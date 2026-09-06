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
 * POST /api/accounts
 * Create a new broker account
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, broker_type, credentials = {}, settings = {} } = req.body;

    if (!name || !broker_type) {
      res.status(400).json({ success: false, error: 'name and broker_type are required' });
      return;
    }

    const validTypes = ['mock', 'simulated', 'tradovate', 'tradier'];
    if (!validTypes.includes(broker_type)) {
      res.status(400).json({ success: false, error: `broker_type must be one of: ${validTypes.join(', ')}` });
      return;
    }

    const defaultSettings = {
      multiplier: 1,
      longOnly: false,
      shortOnly: false,
      allowedSymbols: [],
      maxContracts: 100,
      maxPositions: 10,
      ...settings,
    };

    const result = await query(
      `INSERT INTO broker_accounts (name, broker_type, credentials, settings, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, name, broker_type, is_active, is_disabled, settings, created_at`,
      [name, broker_type, JSON.stringify(credentials), JSON.stringify(defaultSettings)]
    );

    routeLogger.info('Created broker account', { name, broker_type, id: result.rows[0].id });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to create account', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to create account' });
  }
});

/**
 * PATCH /api/accounts/:id
 * Update account fields — currently: name, settings, and preset_id (GB LIVE prop-firm preset).
 * Assigning a preset does not affect other accounts on the strategy.
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, settings, preset_id } = req.body as {
      name?: string;
      settings?: Record<string, unknown>;
      preset_id?: string | null;
    };

    if (preset_id !== undefined && preset_id !== null) {
      const preset = await query('SELECT id, prop_firm FROM presets WHERE id = $1', [preset_id]);
      if (preset.rowCount === 0) {
        res.status(400).json({ success: false, error: `Unknown preset_id: ${preset_id}` });
        return;
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(name); }
    if (settings !== undefined) { sets.push(`settings = $${i++}`); params.push(JSON.stringify(settings)); }
    if (preset_id !== undefined) {
      sets.push(`preset_id = $${i++}`);
      params.push(preset_id);
      // Assigning a preset resets this account's own ladder/day state; it never touches other accounts.
      sets.push(`ladder_step = 1`, `day_realized_pnl = 0`, `trades_today = 0`, `london_used = false`, `nyam_used = false`, `nypm_used = false`);
    }

    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'No updatable fields provided' });
      return;
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE broker_accounts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      params
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Account not found' });
      return;
    }

    await query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, new_value, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      ['update', 'broker_account', req.params.id, JSON.stringify({ name, preset_id })]
    );

    routeLogger.info('Account updated', { accountId: req.params.id, preset_id });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to update account', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to update account' });
  }
});

/**
 * DELETE /api/accounts/:id
 * Delete a broker account
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM broker_accounts WHERE id = $1 RETURNING id, name',
      [req.params.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Account not found' });
      return;
    }

    routeLogger.info('Deleted broker account', { id: req.params.id });
    res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    routeLogger.error('Failed to delete account', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to delete account' });
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
