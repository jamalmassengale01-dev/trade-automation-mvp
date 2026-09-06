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
        ba.last_day_key, ba.trades_today, ba.london_used, ba.nyam_used, ba.nypm_used,
        p.name AS preset_name, p.prop_firm, p.phase AS preset_phase,
        p.start_balance, p.target_profit, p.max_drawdown, p.daily_loss_cap,
        p.base_risk, p.max_contracts, p.cap_step, p.max_trades_day,
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

    const data = result.rows.map((r: any) => ({
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
        targetProfit: r.target_profit !== null ? Number(r.target_profit) : null,
        maxDrawdown: Number(r.max_drawdown),
        dailyLossCap: Number(r.daily_loss_cap),
        baseRisk: Number(r.base_risk),
        maxContracts: r.max_contracts,
        capStep: r.cap_step,
        maxTradesDay: r.max_trades_day,
      },
      ladderStep: r.ladder_step,
      dayRealizedPnl: Number(r.day_realized_pnl),
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
    }));

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
