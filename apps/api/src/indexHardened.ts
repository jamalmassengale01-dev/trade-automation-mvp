/**
 * Hardened Trade Automation API
 * 
 * Entry point with all safety features enabled.
 */

import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import config from './config';
import logger from './utils/logger';
import { connectAllAdapters, disconnectAllAdapters } from './brokers';
import { closeWorkers } from './jobs/workersHardened';
import { closePool } from './db';
import { closeQueues } from './jobs/queues';
import { runStartupReconciliation } from './services/reconciliation';
import { cleanupExpiredKeys } from './services/idempotency';
import { cleanupOldHeartbeats } from './services/heartbeat';
import { cleanupOldEntries as cleanupDLQ } from './services/deadLetter';
import { reconcileAllAccounts as reconcileRuleAssumptions } from './services/ruleReconciliation';
import { broadcaster } from './services/wsbroadcaster';
import { bracketManager } from './strategy/bracketManager';
// Importing workersHardened starts the alert/order/gb-trade BullMQ workers as a side effect.
import './jobs/workersHardened';

// Import routes
import accountsRoutes from './routes/accounts';
import alertsRoutes from './routes/alerts';
import ordersRoutes from './routes/orders';
import riskEventsRoutes from './routes/risk-events';
import systemRoutes from './routes/system';
import strategiesRoutes from './routes/strategies';
import gbRoutes from './routes/gb';
import { handleTradingViewWebhook, handleTradingViewWebhookByStrategy } from './webhook/handlerHardened';
import authRoutes from './routes/auth';
import catalogRoutes from './routes/catalog';
import { attachUser, requireAuth } from './middleware/auth';
import { cleanupExpiredSessions } from './services/session';
import { eodFlattenTick } from './services/eodFlatten';

const app = express();

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet());
// Cookies only travel cross-origin when the origin is named explicitly and
// credentials are allowed — a wildcard origin silently drops them.
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json());

// Request logging with trace ID
app.use((req, res, next) => {
  const start = Date.now();
  const traceId = req.headers['x-trace-id'] as string || generateTraceId();
  
  // Add trace ID to response
  res.setHeader('X-Trace-Id', traceId);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path}`, {
      traceId,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
    });
  });
  next();
});

// ============================================
// ROUTES
// ============================================

// Health check (before auth)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0-hardened',
  });
});

// TradingView webhook endpoints
app.post('/webhook/tradingview', handleTradingViewWebhook);
app.post('/webhook/tradingview/:strategyId', handleTradingViewWebhookByStrategy);

// Resolve the session cookie for every /api request. Attaches req.user when
// one is present; enforcement is per-route below. Mounted AFTER the webhook
// handlers on purpose — TradingView cannot hold a session and authenticates
// with the per-strategy secret in its URL instead.
app.use('/api', attachUser);

// Login/logout are the only unauthenticated API routes.
app.use('/api/auth', authRoutes);

// Everything else requires a session.
app.use('/api/accounts', requireAuth, accountsRoutes);
app.use('/api/alerts', requireAuth, alertsRoutes);
app.use('/api/orders', requireAuth, ordersRoutes);
app.use('/api/risk-events', requireAuth, riskEventsRoutes);
app.use('/api/system', requireAuth, systemRoutes);
app.use('/api/strategies', requireAuth, strategiesRoutes);
app.use('/api/gb', requireAuth, gbRoutes);
app.use('/api/catalog', requireAuth, catalogRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Trade Automation API',
    version: '1.0.0-hardened',
    environment: config.env,
    status: 'running',
    features: {
      hardened: true,
      circuitBreaker: true,
      rateLimiting: true,
      idempotency: true,
      reconciliation: true,
    },
  });
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', {
    path: req.path,
    error: err.message,
    stack: err.stack,
  });
  
  res.status(500).json({
    success: false,
    error: config.isDev ? err.message : 'Internal server error',
  });
});

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    logger.info('Starting Trade Automation API (HARDENED)...', {
      environment: config.env,
      port: config.server.port,
      features: {
        hardened: true,
        circuitBreaker: true,
        rateLimiting: true,
        idempotency: true,
        reconciliation: true,
      },
    });

    // Connect broker adapters
    await connectAllAdapters();

    // Run startup reconciliation to sync positions
    logger.info('Running startup reconciliation...');
    await runStartupReconciliation();
    logger.info('Startup reconciliation complete');

    // Resume any GB LIVE trades left mid-lifecycle by a previous crash/restart
    logger.info('Rehydrating open GB LIVE trades...');
    await bracketManager.rehydrate();
    logger.info('GB LIVE rehydration complete');

    // Start HTTP + WebSocket server
    const httpServer = http.createServer(app);
    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      broadcaster.addClient(ws);
      ws.on('close', () => broadcaster.removeClient(ws));
      ws.on('error', () => broadcaster.removeClient(ws));
    });

    httpServer.listen(config.server.port, config.server.host, () => {
      logger.info(`Server listening on ${config.server.host}:${config.server.port} (HTTP + WebSocket)`);
    });

    // Start periodic cleanup tasks
    startCleanupTasks();

  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// ============================================
// CLEANUP TASKS
// ============================================

function startCleanupTasks(): void {
  // Clean up expired idempotency keys every hour
  setInterval(async () => {
    try {
      const count = await cleanupExpiredKeys();
      logger.debug('Cleaned up expired idempotency keys', { count });
    } catch (error) {
      logger.error('Failed to clean up idempotency keys', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 60 * 60 * 1000);

  // Clean up old heartbeats every hour
  setInterval(async () => {
    try {
      const count = await cleanupOldHeartbeats(60);
      logger.debug('Cleaned up old heartbeats', { count });
    } catch (error) {
      logger.error('Failed to clean up heartbeats', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 60 * 60 * 1000);

  // Clean up old DLQ entries daily
  setInterval(async () => {
    try {
      const count = await cleanupDLQ(30);
      logger.debug('Cleaned up old DLQ entries', { count });
    } catch (error) {
      logger.error('Failed to clean up DLQ', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 24 * 60 * 60 * 1000);

  // Drop expired sessions daily.
  setInterval(async () => {
    try {
      const count = await cleanupExpiredSessions();
      logger.debug('Cleaned up expired sessions', { count });
    } catch (error) {
      logger.error('Failed to clean up sessions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 24 * 60 * 60 * 1000);

  // Apex requires accounts flat before 4:59 PM ET and disclaims anything left
  // open through the close. Ticking every minute rather than scheduling a
  // single timer means a restart during the afternoon still catches the window.
  setInterval(async () => {
    try {
      const results = await eodFlattenTick();
      if (results && results.length > 0) {
        logger.warn('EOD flatten ran', {
          accounts: results.length,
          closed: results.reduce((n, r) => n + r.tradesClosed, 0),
          failed: results.filter((r) => r.error).length,
        });
      }
    } catch (error) {
      logger.error('EOD flatten tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 60 * 1000);

  // Rule reconciliation: compare each account's preset assumptions against
  // what the broker actually reports. Runs every 15 minutes so a wrong preset
  // or a drifting day-P&L counter is caught within one session window rather
  // than after a blown account. The executor reads the persisted verdict, so
  // this never sits on the signal path.
  const runRuleReconciliation = async () => {
    try {
      const results = await reconcileRuleAssumptions();
      const halts = results.filter((r) => r.verdict === 'halt').length;
      if (halts > 0) {
        logger.error('Rule reconciliation found halting issues', {
          halts,
          accounts: results.filter((r) => r.verdict === 'halt').map((r) => r.accountName),
        });
      }
    } catch (error) {
      logger.error('Rule reconciliation sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  setInterval(runRuleReconciliation, 15 * 60 * 1000);
  // Run once shortly after boot so a restart re-establishes verdicts promptly.
  setTimeout(runRuleReconciliation, 30 * 1000);
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // Close workers (stop processing new jobs)
    await closeWorkers();

    // Disconnect brokers
    await disconnectAllAdapters();

    // Close queues
    await closeQueues();

    // Close database pool
    await closePool();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  shutdown('unhandledRejection');
});

// ============================================
// UTILITY
// ============================================

function generateTraceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
}

// Start server
startServer();
