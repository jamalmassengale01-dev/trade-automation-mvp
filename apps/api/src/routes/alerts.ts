import { Router, Request, Response } from 'express';
import { AlertReceived } from '../types';
import { query } from '../db';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'AlertsRoute' });

/**
 * GET /api/alerts
 * List all received alerts with pagination
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const offset = (page - 1) * pageSize;
    
    const countResult = await query('SELECT COUNT(*) FROM alerts_received');
    const total = parseInt(countResult.rows[0].count, 10);
    
    const result = await query<AlertReceived>(`
      SELECT ar.*, s.name as strategy_name
      FROM alerts_received ar
      LEFT JOIN strategies s ON ar.strategy_id = s.id
      ORDER BY ar.created_at DESC
      LIMIT $1 OFFSET $2
    `, [pageSize, offset]);
    
    res.json({
      success: true,
      data: {
        items: result.rows,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    routeLogger.error('Failed to list alerts', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list alerts',
    });
  }
});

/**
 * GET /api/alerts/:id
 * Get single alert details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query<AlertReceived>(`
      SELECT ar.*, s.name as strategy_name
      FROM alerts_received ar
      LEFT JOIN strategies s ON ar.strategy_id = s.id
      WHERE ar.id = $1
    `, [req.params.id]);
    
    if (result.rowCount === 0) {
      res.status(404).json({
        success: false,
        error: 'Alert not found',
      });
      return;
    }
    
    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    routeLogger.error('Failed to get alert', {
      alertId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get alert',
    });
  }
});

/**
 * GET /api/alerts/stats
 * Get alert statistics
 */
router.get('/stats/overview', async (req: Request, res: Response) => {
  try {
    const timeRange = req.query.range as string || '24h';
    let interval: string;
    
    switch (timeRange) {
      case '1h':
        interval = '1 hour';
        break;
      case '7d':
        interval = '7 days';
        break;
      case '30d':
        interval = '30 days';
        break;
      default:
        interval = '24 hours';
    }
    
    const result = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_valid = true) as valid,
        COUNT(*) FILTER (WHERE is_valid = false) as invalid,
        COUNT(*) FILTER (WHERE is_duplicate = true) as duplicates,
        COUNT(*) FILTER (WHERE processed_at IS NOT NULL) as processed
      FROM alerts_received
      WHERE created_at > NOW() - INTERVAL '${interval}'
    `);
    
    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    routeLogger.error('Failed to get alert stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get alert statistics',
    });
  }
});

export default router;
