import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'StrategiesRoute' });

const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:3001';

function webhookUrl(strategyId: string): string {
  return `${WEBHOOK_BASE_URL}/webhook/tradingview/${strategyId}`;
}

// GET /api/strategies
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT
        s.*,
        COUNT(DISTINCT rr.id) FILTER (WHERE rr.is_active = true) AS risk_rules_count,
        COUNT(DISTINCT cm.id) FILTER (WHERE cm.is_active = true) AS copier_mappings_count
      FROM strategies s
      LEFT JOIN risk_rules rr ON rr.strategy_id = s.id
      LEFT JOIN copier_mappings cm ON cm.strategy_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);

    const strategies = result.rows.map((row) => ({
      ...row,
      webhookUrl: webhookUrl(row.id),
      risk_rules_count: Number(row.risk_rules_count),
      copier_mappings_count: Number(row.copier_mappings_count),
    }));

    res.json({ success: true, data: strategies });
  } catch (error) {
    routeLogger.error('Failed to list strategies', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/strategies
router.post('/', async (req: Request, res: Response) => {
  const { name, description } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }

  try {
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    // Use a fixed demo user_id from seeded data, or null for MVP
    const userResult = await query('SELECT id FROM users LIMIT 1');
    const userId = userResult.rows[0]?.id || null;

    const result = await query(
      `INSERT INTO strategies (user_id, name, description, webhook_secret, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       RETURNING *`,
      [userId, name.trim(), description?.trim() || null, webhookSecret]
    );

    const strategy = {
      ...result.rows[0],
      webhookUrl: webhookUrl(result.rows[0].id),
    };

    routeLogger.info('Strategy created', { id: strategy.id, name: strategy.name });
    res.status(201).json({ success: true, data: strategy });
  } catch (error) {
    routeLogger.error('Failed to create strategy', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/strategies/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT s.*,
        COUNT(DISTINCT rr.id) FILTER (WHERE rr.is_active = true) AS risk_rules_count,
        COUNT(DISTINCT cm.id) FILTER (WHERE cm.is_active = true) AS copier_mappings_count
       FROM strategies s
       LEFT JOIN risk_rules rr ON rr.strategy_id = s.id
       LEFT JOIN copier_mappings cm ON cm.strategy_id = s.id
       WHERE s.id = $1
       GROUP BY s.id`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Strategy not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        webhookUrl: webhookUrl(result.rows[0].id),
        risk_rules_count: Number(result.rows[0].risk_rules_count),
        copier_mappings_count: Number(result.rows[0].copier_mappings_count),
      },
    });
  } catch (error) {
    routeLogger.error('Failed to get strategy', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /api/strategies/:id
router.patch('/:id', async (req: Request, res: Response) => {
  const { name, description, is_active } = req.body;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (name !== undefined) { setClauses.push(`name = $${idx++}`); values.push(name.trim()); }
  if (description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(description?.trim() || null); }
  if (is_active !== undefined) { setClauses.push(`is_active = $${idx++}`); values.push(Boolean(is_active)); }

  if (setClauses.length === 0) {
    res.status(400).json({ success: false, error: 'No fields to update' });
    return;
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(req.params.id);

  try {
    const result = await query(
      `UPDATE strategies SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Strategy not found' });
      return;
    }

    res.json({
      success: true,
      data: { ...result.rows[0], webhookUrl: webhookUrl(result.rows[0].id) },
    });
  } catch (error) {
    routeLogger.error('Failed to update strategy', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/strategies/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query('DELETE FROM strategies WHERE id = $1 RETURNING id', [req.params.id]);

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Strategy not found' });
      return;
    }

    routeLogger.info('Strategy deleted', { id: req.params.id });
    res.json({ success: true, message: 'Strategy deleted' });
  } catch (error) {
    routeLogger.error('Failed to delete strategy', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// RISK RULES
// ============================================

const VALID_RULE_TYPES = [
  'max_contracts', 'max_positions', 'cooldown', 'session_time',
  'daily_loss_limit', 'symbol_whitelist', 'conflicting_position',
  'account_disabled', 'kill_switch',
];

// GET /api/strategies/:id/risk-rules
router.get('/:id/risk-rules', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'SELECT * FROM risk_rules WHERE strategy_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    routeLogger.error('Failed to list risk rules', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/strategies/:id/risk-rules
router.post('/:id/risk-rules', async (req: Request, res: Response) => {
  const { rule_type, config } = req.body;

  if (!rule_type || !VALID_RULE_TYPES.includes(rule_type)) {
    res.status(400).json({ success: false, error: `rule_type must be one of: ${VALID_RULE_TYPES.join(', ')}` });
    return;
  }

  try {
    // Verify strategy exists
    const strat = await query('SELECT id FROM strategies WHERE id = $1', [req.params.id]);
    if (strat.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Strategy not found' });
      return;
    }

    const result = await query(
      `INSERT INTO risk_rules (strategy_id, rule_type, config, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, true, NOW(), NOW())
       RETURNING *`,
      [req.params.id, rule_type, JSON.stringify(config || {})]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to add risk rule', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/strategies/:id/risk-rules/:ruleId
router.delete('/:id/risk-rules/:ruleId', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM risk_rules WHERE id = $1 AND strategy_id = $2 RETURNING id',
      [req.params.ruleId, req.params.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Risk rule not found' });
      return;
    }

    res.json({ success: true, message: 'Risk rule deleted' });
  } catch (error) {
    routeLogger.error('Failed to delete risk rule', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// COPIER MAPPINGS
// ============================================

// GET /api/strategies/:id/copier-mappings
router.get('/:id/copier-mappings', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT cm.*, ba.name AS account_name, ba.broker_type
       FROM copier_mappings cm
       JOIN broker_accounts ba ON ba.id = cm.account_id
       WHERE cm.strategy_id = $1
       ORDER BY cm.created_at ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    routeLogger.error('Failed to list copier mappings', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/strategies/:id/copier-mappings
router.post('/:id/copier-mappings', async (req: Request, res: Response) => {
  const { account_id, fixed_size, multiplier, long_only, short_only, allowed_symbols } = req.body;

  if (!account_id) {
    res.status(400).json({ success: false, error: 'account_id is required' });
    return;
  }

  try {
    const strat = await query('SELECT id FROM strategies WHERE id = $1', [req.params.id]);
    if (strat.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Strategy not found' });
      return;
    }

    const result = await query(
      `INSERT INTO copier_mappings
         (strategy_id, account_id, is_active, fixed_size, multiplier, long_only, short_only, allowed_symbols, created_at, updated_at)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (strategy_id, account_id) DO UPDATE
         SET is_active = true, fixed_size = $3, multiplier = $4,
             long_only = $5, short_only = $6, allowed_symbols = $7, updated_at = NOW()
       RETURNING *`,
      [
        req.params.id,
        account_id,
        fixed_size ?? null,
        multiplier ?? 1.0,
        long_only ?? false,
        short_only ?? false,
        allowed_symbols ?? [],
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to add copier mapping', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /api/strategies/:id/copier-mappings/:mappingId
router.patch('/:id/copier-mappings/:mappingId', async (req: Request, res: Response) => {
  const { fixed_size, multiplier, long_only, short_only, allowed_symbols, is_active } = req.body;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (fixed_size !== undefined) { setClauses.push(`fixed_size = $${idx++}`); values.push(fixed_size); }
  if (multiplier !== undefined) { setClauses.push(`multiplier = $${idx++}`); values.push(multiplier); }
  if (long_only !== undefined) { setClauses.push(`long_only = $${idx++}`); values.push(Boolean(long_only)); }
  if (short_only !== undefined) { setClauses.push(`short_only = $${idx++}`); values.push(Boolean(short_only)); }
  if (allowed_symbols !== undefined) { setClauses.push(`allowed_symbols = $${idx++}`); values.push(allowed_symbols); }
  if (is_active !== undefined) { setClauses.push(`is_active = $${idx++}`); values.push(Boolean(is_active)); }

  if (setClauses.length === 0) {
    res.status(400).json({ success: false, error: 'No fields to update' });
    return;
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(req.params.mappingId, req.params.id);

  try {
    const result = await query(
      `UPDATE copier_mappings SET ${setClauses.join(', ')} WHERE id = $${idx} AND strategy_id = $${idx + 1} RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Copier mapping not found' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to update copier mapping', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/strategies/:id/copier-mappings/:mappingId
router.delete('/:id/copier-mappings/:mappingId', async (req: Request, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM copier_mappings WHERE id = $1 AND strategy_id = $2 RETURNING id',
      [req.params.mappingId, req.params.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Copier mapping not found' });
      return;
    }

    res.json({ success: true, message: 'Copier mapping deleted' });
  } catch (error) {
    routeLogger.error('Failed to delete copier mapping', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
