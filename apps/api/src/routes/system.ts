import { Router, Request, Response } from 'express';
import { query } from '../db';
import { getQueueMetrics } from '../jobs/queues';
import { healthCheckAllAdapters } from '../brokers';
import config from '../config';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'SystemRoute' });

/**
 * GET /api/system/health
 * Health check endpoint
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    // Check database
    const dbResult = await query('SELECT 1');
    const dbHealthy = dbResult.rowCount !== null && dbResult.rowCount > 0;
    
    // Check broker adapters
    const brokerHealth = await healthCheckAllAdapters();
    
    // Check queue metrics
    const queueMetrics = await getQueueMetrics();
    
    const allHealthy = dbHealthy && Object.values(brokerHealth).every(h => h);
    
    res.status(allHealthy ? 200 : 503).json({
      success: allHealthy,
      data: {
        status: allHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        services: {
          database: dbHealthy ? 'healthy' : 'unhealthy',
          brokers: brokerHealth,
          queues: queueMetrics,
        },
      },
    });
  } catch (error) {
    routeLogger.error('Health check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({
      success: false,
      data: {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

/**
 * GET /api/system/settings
 * Get system settings
 */
router.get('/settings', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'SELECT key, value, description, updated_at FROM system_settings ORDER BY key'
    );
    
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    routeLogger.error('Failed to get system settings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get system settings',
    });
  }
});

/**
 * POST /api/system/kill-switch
 * Toggle global kill switch
 */
router.post('/kill-switch', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid "enabled" field',
      });
      return;
    }
    
    await query(
      `INSERT INTO system_settings (key, value, description, updated_at)
       VALUES ('global_kill_switch', $1, 'Emergency stop for all trading', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [enabled.toString()]
    );
    
    // Update runtime config
    config.features.globalKillSwitch = enabled;
    
    // Log audit event
    await query(
      `INSERT INTO audit_logs (action, entity_type, new_value, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ['kill_switch', 'system', JSON.stringify({ enabled })]
    );
    
    routeLogger.warn('Kill switch toggled', { enabled });
    
    res.json({
      success: true,
      message: `Kill switch ${enabled ? 'enabled' : 'disabled'}`,
    });
  } catch (error) {
    routeLogger.error('Failed to toggle kill switch', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to toggle kill switch',
    });
  }
});

/**
 * GET /api/system/status
 * Get system status summary
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // Get counts from various tables
    const [
      accountsResult,
      alertsResult,
      tradesResult,
      ordersResult,
      riskEventsResult,
    ] = await Promise.all([
      query('SELECT COUNT(*) FROM broker_accounts WHERE is_active = true'),
      query('SELECT COUNT(*) FROM alerts_received WHERE created_at > NOW() - INTERVAL \'24 hours\''),
      query('SELECT COUNT(*) FROM trade_requests WHERE created_at > NOW() - INTERVAL \'24 hours\''),
      query('SELECT COUNT(*) FROM orders_submitted WHERE created_at > NOW() - INTERVAL \'24 hours\''),
      query('SELECT COUNT(*) FROM risk_events WHERE created_at > NOW() - INTERVAL \'24 hours\''),
    ]);
    
    res.json({
      success: true,
      data: {
        environment: config.env,
        killSwitchActive: config.features.globalKillSwitch,
        activeAccounts: parseInt(accountsResult.rows[0].count, 10),
        last24Hours: {
          alerts: parseInt(alertsResult.rows[0].count, 10),
          trades: parseInt(tradesResult.rows[0].count, 10),
          orders: parseInt(ordersResult.rows[0].count, 10),
          riskEvents: parseInt(riskEventsResult.rows[0].count, 10),
        },
      },
    });
  } catch (error) {
    routeLogger.error('Failed to get system status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get system status',
    });
  }
});

export default router;
