import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config';
import logger from './utils/logger';
import { connectAllAdapters, disconnectAllAdapters } from './brokers';
import { closeWorkers } from './jobs/workers';
import { closePool } from './db';
import { closeQueues } from './jobs/queues';

// Import routes
import accountsRoutes from './routes/accounts';
import alertsRoutes from './routes/alerts';
import ordersRoutes from './routes/orders';
import riskEventsRoutes from './routes/risk-events';
import systemRoutes from './routes/system';
import { handleTradingViewWebhook } from './webhook/handler';

const app = express();

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path}`, {
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TradingView webhook endpoint
app.post('/webhook/tradingview', handleTradingViewWebhook);

// API routes
app.use('/api/accounts', accountsRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/risk-events', riskEventsRoutes);
app.use('/api/system', systemRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Trade Automation API',
    version: '1.0.0',
    environment: config.env,
    status: 'running',
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
    logger.info('Starting Trade Automation API...', {
      environment: config.env,
      port: config.server.port,
    });
    
    // Connect broker adapters
    await connectAllAdapters();
    
    // Start server
    app.listen(config.server.port, config.server.host, () => {
      logger.info(`Server listening on ${config.server.host}:${config.server.port}`);
    });
    
  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    // Close workers
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

// Start server
startServer();
