import { Router, Request, Response } from 'express';
import { BrokerAccount } from '../types';
import { query } from '../db';
import { getBrokerAdapter } from '../brokers';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'AccountsRoute' });

/**
 * GET /api/accounts
 * List all broker accounts
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query<BrokerAccount>(`
      SELECT id, user_id, name, broker_type, is_active, is_disabled, 
             settings, created_at, updated_at
      FROM broker_accounts
      ORDER BY created_at DESC
    `);
    
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    routeLogger.error('Failed to list accounts', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list accounts',
    });
  }
});

/**
 * GET /api/accounts/:id
 * Get single account details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query<BrokerAccount>(`
      SELECT id, user_id, name, broker_type, is_active, is_disabled, 
             settings, created_at, updated_at
      FROM broker_accounts
      WHERE id = $1
    `, [req.params.id]);
    
    if (result.rowCount === 0) {
      res.status(404).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }
    
    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    routeLogger.error('Failed to get account', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get account',
    });
  }
});

/**
 * GET /api/accounts/:id/positions
 * Get account positions from broker
 */
router.get('/:id/positions', async (req: Request, res: Response) => {
  try {
    const accountResult = await query<BrokerAccount>(
      'SELECT * FROM broker_accounts WHERE id = $1',
      [req.params.id]
    );
    
    if (accountResult.rowCount === 0) {
      res.status(404).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }
    
    const account = accountResult.rows[0];
    const adapter = getBrokerAdapter(account.broker_type);
    
    const positions = await adapter.getPositions(account);
    
    res.json({
      success: true,
      data: positions,
    });
  } catch (error) {
    routeLogger.error('Failed to get positions', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get positions',
    });
  }
});

/**
 * POST /api/accounts/:id/flatten
 * Flatten all positions
 */
router.post('/:id/flatten', async (req: Request, res: Response) => {
  try {
    const accountResult = await query<BrokerAccount>(
      'SELECT * FROM broker_accounts WHERE id = $1',
      [req.params.id]
    );
    
    if (accountResult.rowCount === 0) {
      res.status(404).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }
    
    const account = accountResult.rows[0];
    const adapter = getBrokerAdapter(account.broker_type);
    
    await adapter.flattenAll(account);
    
    // Log audit event
    await query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, new_value, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['flatten', 'broker_account', account.id, JSON.stringify({ triggered: 'manual' })]
    );
    
    routeLogger.info('Account flattened', { accountId: account.id });
    
    res.json({
      success: true,
      message: 'All positions flattened',
    });
  } catch (error) {
    routeLogger.error('Failed to flatten account', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to flatten positions',
    });
  }
});

/**
 * POST /api/accounts/:id/disable
 * Disable account
 */
router.post('/:id/disable', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'UPDATE broker_accounts SET is_disabled = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    
    if (result.rowCount === 0) {
      res.status(404).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }
    
    await query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, new_value, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['disable', 'broker_account', req.params.id, JSON.stringify({ is_disabled: true })]
    );
    
    routeLogger.info('Account disabled', { accountId: req.params.id });
    
    res.json({
      success: true,
      message: 'Account disabled',
    });
  } catch (error) {
    routeLogger.error('Failed to disable account', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to disable account',
    });
  }
});

/**
 * POST /api/accounts/:id/enable
 * Enable account
 */
router.post('/:id/enable', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'UPDATE broker_accounts SET is_disabled = false, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    
    if (result.rowCount === 0) {
      res.status(404).json({
        success: false,
        error: 'Account not found',
      });
      return;
    }
    
    await query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, new_value, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['enable', 'broker_account', req.params.id, JSON.stringify({ is_disabled: false })]
    );
    
    routeLogger.info('Account enabled', { accountId: req.params.id });
    
    res.json({
      success: true,
      message: 'Account enabled',
    });
  } catch (error) {
    routeLogger.error('Failed to enable account', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to enable account',
    });
  }
});

export default router;
