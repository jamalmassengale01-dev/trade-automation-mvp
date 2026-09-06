/**
 * GB LIVE executor — the per-account path for alerts that carry bracket metadata.
 *
 * For every copier mapping whose account has a prop-firm preset:
 *   lock account → roll broker day → session/3-per-day/DLL gate → size from ladder step
 *   → persist gb_trades row → reserve session + trade count → enqueue bracket execution.
 *
 * Accounts without a preset are left to the generic copier path.
 */
import { TradingViewAlert } from '../types';
import { query } from '../db';
import { withAccountLock, logOperation } from '../services';
import { getBrokerAdapter } from '../brokers';
import { isBracketBroker } from '../brokers/bracketInterface';
import { gbTradeQueue } from '../jobs/queues';
import { broadcaster } from '../services/wsbroadcaster';
import { getInstrument, rootSymbol } from '../strategy/instruments';
import { stepRisk } from '../strategy/ladder';
import { contractsFor, splitGroups } from '../strategy/sizing';
import { brokerDayKey, getSession, sessionFlagColumn, toDayKey } from '../strategy/sessions';
import { checkGate, resetIfNewDay, AccountDayState } from '../strategy/gate';
import { bracketManager } from '../strategy/bracketManager';
import type { GbLiveMeta } from '../webhook/gbLiveSchema';
import logger from '../utils/logger';

const log = logger.child({ context: 'GbLiveExecutor' });

/** Signals older than this are not executed (TradingView retry storms, outages). */
const STALE_SIGNAL_MS = 10 * 60 * 1000;

export interface GbExecInput {
  alertRecordId: string;
  strategyId: string;
  alert: TradingViewAlert;
  tradeRequestId: string;
  mappings: Array<{ accountId: string; accountName: string }>;
  logContext: { traceId: string; spanId: string };
}

export type GbAccountStatus = 'queued' | 'closed' | 'rejected' | 'skipped';

export interface GbExecResult {
  /** Accounts this executor owns for the alert (preset-backed). Exclude these from the generic copier. */
  handledAccountIds: string[];
  results: Array<{ accountId: string; accountName: string; status: GbAccountStatus; reason?: string; tradeId?: string }>;
}

export function isGbLiveAlert(alert: TradingViewAlert): boolean {
  return (alert.metadata as Partial<GbLiveMeta> | undefined)?.source === 'gb_live';
}

interface AccountWithPreset extends Record<string, any> {
  id: string;
  name: string;
  broker_type: string;
  is_active: boolean;
  is_disabled: boolean;
  settings: Record<string, any> | null;
  preset_id: string | null;
  ladder_step: number;
  day_realized_pnl: string | number;
  last_day_key: string | Date | null;
  trades_today: number;
  london_used: boolean;
  nyam_used: boolean;
  nypm_used: boolean;
  p_base_risk: string | number | null;
  p_daily_loss_cap: string | number | null;
  p_max_contracts: number | null;
  p_cap_step: number | null;
  p_max_trades_day: number | null;
}

export async function executeGbLiveAlert(input: GbExecInput): Promise<GbExecResult> {
  const { alert, strategyId, tradeRequestId, alertRecordId, logContext } = input;
  const meta = alert.metadata as unknown as GbLiveMeta;
  const out: GbExecResult = { handledAccountIds: [], results: [] };

  for (const m of input.mappings) {
    try {
      const r = await withAccountLock(m.accountId, () => processAccount(m, alert, meta, strategyId, tradeRequestId, alertRecordId), { timeoutMs: 30_000 });
      out.results.push({ accountId: m.accountId, accountName: m.accountName, ...r });
      if (r.status !== 'skipped') out.handledAccountIds.push(m.accountId);
      await logOperation(logContext, {
        operation: 'gb.account',
        entityType: 'account',
        entityId: m.accountId,
        accountId: m.accountId,
        status: r.status === 'rejected' ? 'failed' : r.status === 'skipped' ? 'skipped' : 'succeeded',
        errorMessage: r.reason,
        input: { tradeId: r.tradeId, action: alert.action },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error('GB account processing failed', { accountId: m.accountId, error: reason });
      out.results.push({ accountId: m.accountId, accountName: m.accountName, status: 'rejected', reason });
      out.handledAccountIds.push(m.accountId);
    }
  }
  return out;
}

async function processAccount(
  m: { accountId: string; accountName: string },
  alert: TradingViewAlert,
  meta: GbLiveMeta,
  strategyId: string,
  tradeRequestId: string,
  alertRecordId: string
): Promise<{ status: GbAccountStatus; reason?: string; tradeId?: string }> {
  const r = await query<AccountWithPreset>(
    `SELECT ba.*,
            p.base_risk      AS p_base_risk,
            p.daily_loss_cap AS p_daily_loss_cap,
            p.max_contracts  AS p_max_contracts,
            p.cap_step       AS p_cap_step,
            p.max_trades_day AS p_max_trades_day
     FROM broker_accounts ba
     LEFT JOIN presets p ON p.id = ba.preset_id
     WHERE ba.id = $1`,
    [m.accountId]
  );
  const acct = r.rows[0];
  if (!acct) return { status: 'rejected', reason: 'Account not found' };
  if (!acct.preset_id || acct.p_base_risk === null) return { status: 'skipped', reason: 'No prop-firm preset — generic path' };
  if (!acct.is_active || acct.is_disabled) return { status: 'rejected', reason: 'Account inactive or disabled' };

  // ---- close-all ----------------------------------------------------
  if (alert.action === 'close' || alert.action === 'reverse') {
    const n = await bracketManager.closeAll(acct.id, `signal:${alert.action}`);
    log.info('Close signal processed', { accountId: acct.id, closed: n });
    return { status: 'closed', reason: `${n} trade(s) closed` };
  }
  if (alert.action !== 'buy' && alert.action !== 'sell') {
    return { status: 'rejected', reason: `Unsupported action ${alert.action}` };
  }

  // ---- staleness ----------------------------------------------------
  const now = new Date();
  const alertTime = new Date(alert.timestamp);
  if (now.getTime() - alertTime.getTime() > STALE_SIGNAL_MS) {
    await riskEvent(acct.id, strategyId, 'gb_stale_signal', `Signal is ${Math.round((now.getTime() - alertTime.getTime()) / 60000)} min old`, { alertTime: alertTime.toISOString() });
    return { status: 'rejected', reason: 'stale_signal' };
  }

  // ---- broker day roll ---------------------------------------------
  const todayKey = brokerDayKey(now);
  const before: AccountDayState = {
    ladderStep: Number(acct.ladder_step ?? 1),
    dayRealizedPnl: Number(acct.day_realized_pnl ?? 0),
    lastDayKey: toDayKey(acct.last_day_key),
    tradesToday: Number(acct.trades_today ?? 0),
    londonUsed: !!acct.london_used,
    nyamUsed: !!acct.nyam_used,
    nypmUsed: !!acct.nypm_used,
  };
  const { state, reset } = resetIfNewDay(before, todayKey);
  if (reset) {
    await query(
      `UPDATE broker_accounts SET last_day_key=$2::date, day_realized_pnl=0, trades_today=0,
              london_used=false, nyam_used=false, nypm_used=false, updated_at=NOW() WHERE id=$1`,
      [acct.id, todayKey]
    );
  }

  // ---- gate ----------------------------------------------------------
  const preset = {
    baseRisk: Number(acct.p_base_risk),
    dailyLossCap: Number(acct.p_daily_loss_cap),
    maxContracts: Number(acct.p_max_contracts ?? 0),
    capStep: Number(acct.p_cap_step ?? 3),
    maxTradesPerDay: Number(acct.p_max_trades_day ?? 3),
  };
  const session = getSession(alertTime);
  const risk = stepRisk(preset.baseRisk, state.ladderStep, preset.capStep);
  const gate = checkGate({ state, preset, session, stepRisk: risk });
  if (!gate.allowed) {
    await riskEvent(acct.id, strategyId, `gb_${gate.reason}`, gate.message ?? gate.reason ?? 'gate', { ...gate.details, session, step: state.ladderStep, stepRisk: risk });
    return { status: 'rejected', reason: gate.reason };
  }

  // ---- sizing --------------------------------------------------------
  const stopPts = meta.bracket?.stopPts;
  if (!stopPts || stopPts <= 0) {
    await riskEvent(acct.id, strategyId, 'gb_no_stop_distance', 'Alert carries no usable stop distance', { bracket: meta.bracket });
    return { status: 'rejected', reason: 'no_stop_distance' };
  }
  const inst = getInstrument(alert.symbol);
  if (!inst) {
    await riskEvent(acct.id, strategyId, 'gb_unknown_instrument', `Unknown instrument ${alert.symbol}`, {});
    return { status: 'rejected', reason: 'unknown_instrument' };
  }
  const accountCap = Number(acct.settings?.maxContracts ?? acct.settings?.max_contracts ?? Infinity);
  const maxContracts = Math.min(preset.maxContracts || Infinity, accountCap);
  const contracts = contractsFor(risk, stopPts, inst.pointValue, maxContracts);
  if (contracts <= 0) {
    await riskEvent(acct.id, strategyId, 'gb_size_zero', `Stop ${stopPts} pts too wide for step risk $${risk}`, { stopPts, stepRisk: risk, pointValue: inst.pointValue });
    return { status: 'rejected', reason: 'size_zero' };
  }
  const { g1, g2 } = splitGroups(contracts);

  // ---- tradable symbol ----------------------------------------------
  const adapter = getBrokerAdapter(acct.broker_type as any);
  if (!isBracketBroker(adapter)) {
    return { status: 'rejected', reason: `Broker ${acct.broker_type} cannot run brackets` };
  }
  const symbol = await adapter.resolveTradableSymbol(acct as any, alert.symbol);
  const direction = alert.action === 'buy' ? 'long' : 'short';

  // ---- persist + reserve gate ---------------------------------------
  const ins = await query<{ id: string }>(
    `INSERT INTO gb_trades (broker_account_id, trade_request_id, alert_id, day_key, session, direction, symbol, root_symbol,
                            ref_price, stop_pts, contracts, g1_qty, g2_qty, step_at_entry, step_risk, gtd_seconds, state)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'entry_pending') RETURNING id`,
    [acct.id, tradeRequestId, alertRecordId, todayKey, session, direction, symbol, rootSymbol(alert.symbol),
     alert.price ?? null, stopPts, contracts, g1, g2, state.ladderStep, risk, meta.gtdSeconds ?? 120]
  );
  const tradeId = ins.rows[0].id;

  await query(
    `UPDATE broker_accounts SET trades_today = trades_today + 1, ${sessionFlagColumn(session!)} = true,
            last_day_key = $2::date, updated_at = NOW() WHERE id = $1`,
    [acct.id, todayKey]
  );

  await gbTradeQueue.add('execute-gb-trade', { tradeId }, { jobId: `gb-${tradeId}`, attempts: 1, removeOnComplete: true });

  log.info('GB trade queued', { tradeId, accountId: acct.id, account: acct.name, symbol, direction, contracts, g1, g2, step: state.ladderStep, stepRisk: risk, stopPts, session });
  broadcaster.broadcast('trade_created', {
    tradeId, accountId: acct.id, accountName: acct.name, symbol, direction, contracts, g1, g2,
    step: state.ladderStep, stepRisk: risk, stopPts, session,
  });

  return { status: 'queued', tradeId };
}

async function riskEvent(accountId: string, strategyId: string, ruleType: string, message: string, details: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO risk_events (type, rule_type, strategy_id, account_id, message, details, created_at)
     VALUES ('rejection', $1, $2, $3, $4, $5, NOW())`,
    [ruleType, strategyId || null, accountId, message, JSON.stringify(details ?? {})]
  );
  broadcaster.broadcast('risk_event', { accountId, ruleType, message, details });
  log.warn('GB gate rejection', { accountId, ruleType, message });
}
