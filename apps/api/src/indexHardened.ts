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
import { broadcaster } from './services/wsbroadcaster';

// Import routes
import accountsRoutes from './routes/accounts';
import alertsRoutes from './routes/alerts';
import ordersRoutes from './routes/orders';
import riskEventsRoutes from './routes/risk-events';
import systemRoutes from './routes/system';
import strategiesRoutes from './routes/strategies';
import { handleTradingViewWebhook, handleTradingViewWebhookByStrategy } from './webhook/handlerHardened';

const app = express();

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet());
app.use(cors());
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

// API routes
app.use('/api/accounts', accountsRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/risk-events', riskEventsRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/strategies', strategiesRoutes);

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
