import { Router, Request, Response } from 'express';
import { query } from '../db';
import { dllHeadroom } from '../strategy/gate';
import { bracketManager } from '../strategy/bracketManager';
import config from '../config';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'GbRoute' });

/**
 * GET /api/gb/presets
 * Prop-firm preset catalog (Apex 50K Eval, PA Funded, Tradeify, ...).
 */
router.get('/presets', async (_req: Request, res: Response) => {
  try {
    const result = await query(`SELECT * FROM presets ORDER BY prop_firm, phase, start_balance`);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    routeLogger.error('Failed to list presets', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to list presets' });
  }
});

const DD_MODES = ['eod_trailing', 'intraday_trailing', 'static_fixed'];
const PHASES = ['eval', 'funded'];

const PRESET_FIELDS = [
  'id', 'name', 'prop_firm', 'phase', 'start_balance', 'target_profit', 'max_drawdown',
  'daily_loss_cap', 'base_risk', 'max_contracts', 'dd_mode', 'tp1_r', 'tp2_r',
  'cap_step', 'max_trades_day', 'profit_split', 'step2_mult', 'step3_mult', 'step4_mult',
  'pass_zone_buffer', 'sniper_risk_pct', 'sniper_tp_r', 'sniper_max_trades_day', 'notes',
] as const;

type PresetInput = Partial<Record<(typeof PRESET_FIELDS)[number], unknown>>;

/** Validate the subset of fields present in the body. Returns an error string, or null if OK. */
function validatePresetInput(body: PresetInput, opts: { requireCore: boolean }): string | null {
  if (opts.requireCore) {
    for (const f of ['id', 'name', 'prop_firm', 'phase', 'start_balance', 'max_drawdown', 'daily_loss_cap', 'base_risk', 'max_contracts'] as const) {
      if (body[f] === undefined || body[f] === null || body[f] === '') return `${f} is required`;
    }
  }
  if (body.id !== undefined && !/^[a-z0-9_]+$/.test(String(body.id))) {
    return 'id must be lowercase letters, numbers, and underscores only';
  }
  if (body.phase !== undefined && !PHASES.includes(String(body.phase))) {
    return `phase must be one of: ${PHASES.join(', ')}`;
  }
  if (body.dd_mode !== undefined && !DD_MODES.includes(String(body.dd_mode))) {
    return `dd_mode must be one of: ${DD_MODES.join(', ')}`;
  }
  const numericFields = [
    'start_balance', 'target_profit', 'max_drawdown', 'daily_loss_cap', 'base_risk', 'max_contracts',
    'tp1_r', 'tp2_r', 'cap_step', 'max_trades_day', 'profit_split', 'step2_mult', 'step3_mult', 'step4_mult',
    'pass_zone_buffer', 'sniper_risk_pct', 'sniper_tp_r', 'sniper_max_trades_day',
  ] as const;
  for (const f of numericFields) {
    if (body[f] !== undefined && body[f] !== null && (typeof body[f] !== 'number' || !Number.isFinite(body[f] as number))) {
      return `${f} must be a finite number`;
    }
  }
  return null;
}

/**
 * POST /api/gb/presets
 * Create a new prop-firm preset. This is the mechanism for adding a new
 * strategy variant or account-size config without a code change — every
 * ladder/DLL/session/sniper parameter used by the executor lives here.
 */
router.post('/presets', async (req: Request, res: Response) => {
  const body = req.body as PresetInput;
  const err = validatePresetInput(body, { requireCore: true });
  if (err) {
    res.status(400).json({ success: false, error: err });
    return;
  }
  try {
    const existing = await query('SELECT id FROM presets WHERE id = $1', [body.id]);
    if (existing.rowCount! > 0) {
      res.status(409).json({ success: false, error: `Preset '${body.id}' already exists` });
      return;
    }
    const cols = PRESET_FIELDS.filter((f) => body[f] !== undefined);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map((f) => body[f]);
    const result = await query(
      `INSERT INTO presets (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    routeLogger.info('Preset created', { id: body.id });
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to create preset', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to create preset' });
  }
});

/**
 * GET /api/gb/presets/:id
 */
router.get('/presets/:id', async (req: Request, res: Response) => {
  try {
    const result = await query('SELECT * FROM presets WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Preset not found' });
      return;
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to get preset', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get preset' });
  }
});

/**
 * PATCH /api/gb/presets/:id
 * Update any subset of a preset's fields. Takes effect on the NEXT trade for
 * every account assigned to it — open trades are unaffected (their tp1_r/
 * tp2_r were captured onto the gb_trades row at entry time).
 */
router.patch('/presets/:id', async (req: Request, res: Response) => {
  const body = req.body as PresetInput;
  const { id: _ignored, ...rest } = body; // id is immutable — the preset's key
  const err = validatePresetInput(rest, { requireCore: false });
  if (err) {
    res.status(400).json({ success: false, error: err });
    return;
  }
  const cols = PRESET_FIELDS.filter((f) => f !== 'id' && rest[f] !== undefined);
  if (cols.length === 0) {
    res.status(400).json({ success: false, error: 'No updatable fields provided' });
    return;
  }
  try {
    const sets = cols.map((f, i) => `${f} = $${i + 1}`);
    const values = cols.map((f) => rest[f]);
    values.push(req.params.id);
    const result = await query(`UPDATE presets SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Preset not found' });
      return;
    }
    routeLogger.info('Preset updated', { id: req.params.id, fields: cols });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    routeLogger.error('Failed to update preset', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to update preset' });
  }
});

/**
 * DELETE /api/gb/presets/:id
 * Refuses if any broker account is still assigned to it — unassign those
 * accounts first (PATCH /api/accounts/:id { preset_id: null }).
 */
router.delete('/presets/:id', async (req: Request, res: Response) => {
  try {
    const inUse = await query<{ count: string }>('SELECT COUNT(*) FROM broker_accounts WHERE preset_id = $1', [req.params.id]);
    const count = parseInt(inUse.rows[0].count, 10);
    if (count > 0) {
      res.status(409).json({ success: false, error: `Preset is assigned to ${count} account(s) — unassign them first` });
      return;
    }
    const result = await query('DELETE FROM presets WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Preset not found' });
      return;
    }
    routeLogger.info('Preset deleted', { id: req.params.id });
    res.json({ success: true, message: 'Preset deleted' });
  } catch (error) {
    routeLogger.error('Failed to delete preset', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to delete preset' });
  }
});

/**
 * GET /api/gb/accounts
 * Fleet view: every account running a GB LIVE preset, with ladder state,
 * DLL headroom, today's session usage, and its most recent trade.
 */
router.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT
        ba.id, ba.name, ba.broker_type, ba.is_active, ba.is_disabled,
        ba.preset_id, ba.account_phase, ba.ladder_step, ba.day_realized_pnl,
        ba.cumulative_pnl, ba.day_locked_out,
        ba.last_day_key, ba.trades_today, ba.london_used, ba.nyam_used, ba.nypm_used,
        p.name AS preset_name, p.prop_firm, p.phase AS preset_phase,
        p.start_balance, p.target_profit, p.max_drawdown, p.daily_loss_cap,
        p.base_risk, p.max_contracts, p.cap_step, p.max_trades_day,
        p.pass_zone_buffer,
        lt.id AS last_trade_id, lt.symbol AS last_trade_symbol, lt.direction AS last_trade_direction,
        lt.outcome AS last_trade_outcome, lt.pnl AS last_trade_pnl, lt.exit_time AS last_trade_exit_time,
        lt.created_at AS last_trade_created_at
      FROM broker_accounts ba
      JOIN presets p ON p.id = ba.preset_id
      LEFT JOIN LATERAL (
        SELECT * FROM gb_trades gt WHERE gt.broker_account_id = ba.id
        ORDER BY gt.created_at DESC LIMIT 1
      ) lt ON true
      ORDER BY ba.created_at DESC
    `);

    const data = result.rows.map((r: any) => {
      const targetProfit = r.target_profit !== null ? Number(r.target_profit) : null;
      const cumulativePnl = Number(r.cumulative_pnl ?? 0);
      const remaining = targetProfit !== null ? Math.max(targetProfit - cumulativePnl, 0) : null;
      const passZoneBuffer = Number(r.pass_zone_buffer ?? 0);
      const inSniperMode = remaining !== null && passZoneBuffer > 0 && remaining > 0 && remaining <= passZoneBuffer;
      return {
        id: r.id,
        name: r.name,
        brokerType: r.broker_type,
        isActive: r.is_active,
        isDisabled: r.is_disabled,
        phase: r.account_phase,
        preset: {
          id: r.preset_id,
          name: r.preset_name,
          propFirm: r.prop_firm,
          phase: r.preset_phase,
          startBalance: Number(r.start_balance),
          targetProfit,
          maxDrawdown: Number(r.max_drawdown),
          dailyLossCap: Number(r.daily_loss_cap),
          baseRisk: Number(r.base_risk),
          maxContracts: r.max_contracts,
          capStep: r.cap_step,
          maxTradesDay: r.max_trades_day,
        },
        ladderStep: r.ladder_step,
        dayRealizedPnl: Number(r.day_realized_pnl),
        cumulativePnl,
        remainingTarget: remaining,
        inSniperMode,
        dayLockedOut: r.day_locked_out,
        dllRoom: dllHeadroom(Number(r.daily_loss_cap), Number(r.day_realized_pnl)),
        lastDayKey: r.last_day_key,
        tradesToday: r.trades_today,
        maxTradesDay: r.max_trades_day,
        sessions: { london: r.london_used, nyam: r.nyam_used, nypm: r.nypm_used },
        lastTrade: r.last_trade_id
          ? {
              id: r.last_trade_id,
              symbol: r.last_trade_symbol,
              direction: r.last_trade_direction,
              outcome: r.last_trade_outcome,
              pnl: r.last_trade_pnl !== null ? Number(r.last_trade_pnl) : null,
              exitTime: r.last_trade_exit_time,
              createdAt: r.last_trade_created_at,
            }
          : null,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    routeLogger.error('Failed to list GB accounts', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to list GB accounts' });
  }
});

/**
 * GET /api/gb/accounts/:id/trades
 * Trade history for one account, newest first.
 */
router.get('/accounts/:id/trades', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      query(
        `SELECT * FROM gb_trades WHERE broker_account_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.params.id, pageSize, offset]
      ),
      query<{ count: string }>(`SELECT COUNT(*) FROM gb_trades WHERE broker_account_id = $1`, [req.params.id]),
    ]);

    const total = parseInt(count.rows[0].count, 10);
    res.json({
      success: true,
      data: { items: rows.rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    routeLogger.error('Failed to load account trades', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to load account trades' });
  }
});

/**
 * GET /api/gb/trades
 * Recent trades across the whole fleet, for a global feed / activity log.
 */
router.get('/trades', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      query(
        `SELECT gt.*, ba.name AS account_name FROM gb_trades gt
         JOIN broker_accounts ba ON ba.id = gt.broker_account_id
         ORDER BY gt.created_at DESC LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      ),
      query<{ count: string }>(`SELECT COUNT(*) FROM gb_trades`),
    ]);

    const total = parseInt(count.rows[0].count, 10);
    res.json({
      success: true,
      data: { items: rows.rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    routeLogger.error('Failed to list GB trades', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to list GB trades' });
  }
});

/**
 * POST /api/gb/trades/:id/simulate-exit
 * Dev-only: drive an open trade to a chosen outcome without a live market.
 * Refuses in production and refuses on any account that isn't mock/simulated
 * (bracketManager.simulateExit also enforces the latter).
 */
router.post('/trades/:id/simulate-exit', async (req: Request, res: Response) => {
  if (config.isProd) {
    res.status(403).json({ success: false, error: 'simulate-exit is disabled in production' });
    return;
  }
  try {
    const outcome = req.body?.outcome as 'W' | 'W~' | 'L' | 'BE' | undefined;
    if (!outcome || !['W', 'W~', 'L', 'BE'].includes(outcome)) {
      res.status(400).json({ success: false, error: 'body.outcome must be one of W, W~, L, BE' });
      return;
    }
    const trade = await bracketManager.simulateExit(req.params.id, outcome);
    res.json({ success: true, data: trade });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    routeLogger.warn('simulate-exit failed', { tradeId: req.params.id, error: message });
    res.status(400).json({ success: false, error: message });
  }
});

export default router;
