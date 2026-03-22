import { Router, Request, Response } from 'express';
import { RiskEvent } from '../types';
import { query } from '../db';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'RiskEventsRoute' });

/**
 * GET /api/risk-events
 * List all risk events with pagination
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const offset = (page - 1) * pageSize;
    
    const countResult = await query('SELECT COUNT(*) FROM risk_events');
    const total = parseInt(countResult.rows[0].count, 10);
    
    const result = await query<RiskEvent>(`
      SELECT re.*, 
             s.name as strategy_name,
             ba.name as account_name
      FROM risk_events re
      LEFT JOIN strategies s ON re.strategy_id = s.id
      LEFT JOIN broker_accounts ba ON re.account_id = ba.id
      ORDER BY re.created_at DESC
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
    routeLogger.error('Failed to list risk events', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list risk events',
    });
  }
});

/**
 * GET /api/risk-events/stats
 * Get risk event statistics
 */
router.get('/stats/overview', async (req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE type = 'rejection') as rejections,
        COUNT(*) FILTER (WHERE type = 'kill_switch') as kill_switches,
        COUNT(*) FILTER (WHERE type = 'warning') as warnings
      FROM risk_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    
    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    routeLogger.error('Failed to get risk stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get risk statistics',
    });
  }
});

export default router;
