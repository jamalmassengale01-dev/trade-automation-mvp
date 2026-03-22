import { Router, Request, Response } from 'express';
import { TradeRequest, OrderSubmitted, Execution } from '../types';
import { query } from '../db';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'OrdersRoute' });

/**
 * GET /api/trade-requests
 * List all trade requests with pagination
 */
router.get('/requests', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const offset = (page - 1) * pageSize;
    
    const countResult = await query('SELECT COUNT(*) FROM trade_requests');
    const total = parseInt(countResult.rows[0].count, 10);
    
    const result = await query<TradeRequest>(`
      SELECT tr.*, s.name as strategy_name
      FROM trade_requests tr
      LEFT JOIN strategies s ON tr.strategy_id = s.id
      ORDER BY tr.created_at DESC
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
    routeLogger.error('Failed to list trade requests', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list trade requests',
    });
  }
});

/**
 * GET /api/orders
 * List all orders with pagination
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const offset = (page - 1) * pageSize;
    
    const countResult = await query('SELECT COUNT(*) FROM orders_submitted');
    const total = parseInt(countResult.rows[0].count, 10);
    
    const result = await query<OrderSubmitted>(`
      SELECT os.*, ba.name as account_name
      FROM orders_submitted os
      LEFT JOIN broker_accounts ba ON os.account_id = ba.id
      ORDER BY os.created_at DESC
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
    routeLogger.error('Failed to list orders', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list orders',
    });
  }
});

/**
 * GET /api/executions
 * List all executions with pagination
 */
router.get('/executions', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const offset = (page - 1) * pageSize;
    
    const countResult = await query('SELECT COUNT(*) FROM executions');
    const total = parseInt(countResult.rows[0].count, 10);
    
    const result = await query<Execution>(`
      SELECT e.*, ba.name as account_name
      FROM executions e
      LEFT JOIN broker_accounts ba ON e.account_id = ba.id
      ORDER BY e.executed_at DESC
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
    routeLogger.error('Failed to list executions', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list executions',
    });
  }
});

export default router;
