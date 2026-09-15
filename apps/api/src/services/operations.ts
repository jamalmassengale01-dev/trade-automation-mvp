/**
 * The operational view.
 *
 * One question, answered on one screen: **if a signal arrived right now, what
 * would happen — and if the answer is "nothing", why?**
 *
 * Everything here already existed, spread across five pages. Fleet state on
 * /fleet, payout blockers on /launchpad, halt verdicts on /health, refusals in
 * /risk-events, and readiness only in a CLI. During a 30-minute window nobody
 * clicks through five pages, so in practice the information was not available
 * at the moment it mattered.
 *
 * Assembled server-side and returned in one response rather than fanned out
 * from the browser: five polling requests on a 10-second timer is five times
 * the load for a view whose parts must agree with each other. A page that shows
 * drawdown room from one instant and the halt verdict from another is worse
 * than one that refreshes a beat later.
 *
 * Broker preflight is EXCLUDED by default. It makes a network call per account
 * and this endpoint is polled; readiness here is the local half, and the full
 * check stays behind `npm run fleet:check` or an explicit request.
 */

import { query } from '../db';
import { fleetReadiness, ReadinessCheck } from './fleetReadiness';
import { accountDrawdownState } from './accountDrawdown';
import { getLatestRuleCheck } from './ruleReconciliation';
import { entitlementForUser } from './entitlements';
import { shouldBlockTrade } from '../strategy/ruleReconciler';
import { getSession, SESSION_WINDOWS, etMinutesOfDay, Session } from '../strategy/sessions';
import { dllHeadroom } from '../strategy/gate';
import { DdMode } from '../strategy/drawdown';
import logger from '../utils/logger';

const log = logger.child({ context: 'Operations' });

export interface SessionState {
  /** Which window we are inside right now, if any. */
  current: Session | null;
  /** The next window to open, and how far away. Null late in the day. */
  next: { session: Session; label: string; minutesAway: number } | null;
}

export interface OpsAccount {
  id: string;
  name: string;
  presetName: string | null;
  propFirm: string | null;
  phase: string | null;

  ladderStep: number;
  /** Risk the NEXT trade would take at the current step. */
  nextStepRisk: number | null;

  dayPnl: number;
  dailyLossCap: number;
  dllRoom: number;

  drawdownFloor: number | null;
  drawdownRoom: number | null;
  /** True when the floor was derived from incomplete history and may be too low. */
  drawdownUnderstated: boolean;

  tradesToday: number;
  maxTradesPerDay: number;
  sessionsUsed: { london: boolean; nyam: boolean; nypm: boolean };
  dayLockedOut: boolean;

  openTrade: { id: string; symbol: string; direction: string; contracts: number; state: string } | null;

  /**
   * Why this account would refuse a signal right now, if it would. Ordered
   * most-severe first; the first entry is what a trader needs to see.
   */
  blockers: Array<{ kind: string; message: string }>;
}

export interface OpsRefusal {
  at: string;
  accountName: string | null;
  ruleType: string;
  message: string;
}

export interface OperationsView {
  generatedAt: string;
  session: SessionState;
  readiness: { ready: boolean; failing: ReadinessCheck[]; warnings: number };
  accounts: OpsAccount[];
  refusals: OpsRefusal[];
  /** Accounts that would refuse a signal right now. The headline number. */
  blockedCount: number;
  /** One sentence answering "would anything trade right now". */
  accountsSummary: string;
}

/**
 * The sentence above the account list.
 *
 * Lives here rather than in the page because it is a claim about whether the
 * fleet would trade, and claims like that need a test. The first version was
 * written in the component as `clear.length === accounts.length ? 'all would
 * trade' : ...`, which on an empty fleet is 0 === 0 — so a server with no
 * accounts at all announced that ALL of them would take a signal, directly
 * above a card explaining that none would. Seen within a minute of the first
 * real deployment.
 *
 * On a screen whose entire job is answering "would a signal trade right now",
 * saying yes when the answer is no is the only truly unacceptable output.
 */
export function summariseAccounts(names: string[], clearNames: string[]): string {
  // Order matters: the empty case must be tested before any comparison of
  // counts, because zero equals zero.
  if (names.length === 0) return 'no accounts connected yet';
  if (clearNames.length === 0) return 'none would trade a signal right now';
  if (clearNames.length === names.length) return 'all would trade a signal right now';
  return `${clearNames.join(', ')} would trade right now`;
}

const SESSION_LABEL: Record<Session, string> = {
  london: 'London', nyam: 'NY AM', nypm: 'NY PM',
};

/** Which window we are in, and when the next one opens. */
export function sessionState(now: Date = new Date()): SessionState {
  const current = getSession(now);
  const minutes = etMinutesOfDay(now);

  let next: SessionState['next'] = null;
  for (const name of ['london', 'nyam', 'nypm'] as Session[]) {
    const w = SESSION_WINDOWS[name];
    if (w.startMin > minutes) {
      next = { session: name, label: SESSION_LABEL[name], minutesAway: w.startMin - minutes };
      break;
    }
  }
  return { current, next };
}

interface Row extends Record<string, unknown> {
  id: string; name: string; user_id: string | null;
  ladder_step: number; day_realized_pnl: string; cumulative_pnl: string;
  trades_today: number; day_locked_out: boolean;
  london_used: boolean; nyam_used: boolean; nypm_used: boolean;
  p_name: string | null; prop_firm: string | null; p_phase: string | null;
  p_start_balance: string | null; p_max_drawdown: string | null;
  p_daily_loss_cap: string | null; p_base_risk: string | null;
  p_dd_mode: DdMode | null; p_safety_net_buffer: string | null;
  p_dll_buffer_pct: string | null; p_max_trades_day: number | null;
  p_cap_step: number | null; p_step2_mult: string | null;
  p_step3_mult: string | null; p_step4_mult: string | null;
  open_id: string | null; open_symbol: string | null;
  open_direction: string | null; open_contracts: number | null; open_state: string | null;
}

const num = (v: unknown, d = 0): number => (v === null || v === undefined ? d : Number(v));

/** Risk the next trade would take, mirroring strategy/ladder.stepRisk. */
function nextStepRisk(r: Row): number | null {
  const base = num(r.p_base_risk, 0);
  if (base <= 0) return null;
  const cap = r.p_cap_step ?? 3;
  const step = Math.min(Math.max(r.ladder_step ?? 1, 1), cap);
  const mult = step === 1 ? 1
    : step === 2 ? num(r.p_step2_mult, 1)
    : step === 3 ? num(r.p_step3_mult, 2)
    : num(r.p_step4_mult, 4);
  const dll = num(r.p_daily_loss_cap, 0);
  const raw = base * mult;
  return Number((dll > 0 ? Math.min(raw, dll) : raw).toFixed(2));
}

export async function operationsView(scopeSql = 'TRUE', params: unknown[] = []): Promise<OperationsView> {
  const now = new Date();

  const [readinessReport, accountRows, refusalRows] = await Promise.all([
    fleetReadiness({ skipBroker: true }),
    query<Row>(
      `SELECT ba.id, ba.name, ba.user_id, ba.ladder_step, ba.day_realized_pnl,
              ba.cumulative_pnl, ba.trades_today, ba.day_locked_out,
              ba.london_used, ba.nyam_used, ba.nypm_used,
              p.name AS p_name, p.prop_firm, p.phase AS p_phase,
              p.start_balance AS p_start_balance, p.max_drawdown AS p_max_drawdown,
              p.daily_loss_cap AS p_daily_loss_cap, p.base_risk AS p_base_risk,
              p.dd_mode AS p_dd_mode, p.safety_net_buffer AS p_safety_net_buffer,
              p.dll_buffer_pct AS p_dll_buffer_pct, p.max_trades_day AS p_max_trades_day,
              p.cap_step AS p_cap_step, p.step2_mult AS p_step2_mult,
              p.step3_mult AS p_step3_mult, p.step4_mult AS p_step4_mult,
              ot.id AS open_id, ot.symbol AS open_symbol, ot.direction AS open_direction,
              ot.contracts AS open_contracts, ot.state AS open_state
       FROM broker_accounts ba
       LEFT JOIN presets p ON p.id = ba.preset_id
       LEFT JOIN LATERAL (
         SELECT id, symbol, direction, contracts, state FROM gb_trades gt
         WHERE gt.broker_account_id = ba.id AND gt.state NOT IN ('closed','failed')
         ORDER BY gt.created_at DESC LIMIT 1
       ) ot ON true
       WHERE ba.is_active = true AND ba.preset_id IS NOT NULL AND ${scopeSql}
       ORDER BY ba.name`,
      params
    ),
    // Refusals only — the executor's own rejections. A payout notice or an
    // eval transition is not why a signal did not trade.
    query<{ created_at: Date; rule_type: string; message: string; account_name: string | null }>(
      `SELECT re.created_at, re.rule_type, re.message, ba.name AS account_name
       FROM risk_events re
       LEFT JOIN broker_accounts ba ON ba.id = re.account_id
       WHERE re.rule_type LIKE 'gb_%' AND re.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY re.created_at DESC LIMIT 12`
    ),
  ]);

  const accounts: OpsAccount[] = [];

  for (const r of accountRows.rows) {
    const blockers: Array<{ kind: string; message: string }> = [];

    // 1. Halt verdict — the executor reads exactly this check, so the answer
    //    here is the same one the gate would give.
    //
    //    shouldBlockTrade returns the token 'rule_reconciliation_halt', which
    //    is correct as a rule_type on the executor path and useless to a human
    //    on a page whose whole purpose is answering "why did nothing happen?".
    //    The halting FINDINGS carry the actual reason, so use those.
    const ruleCheck = await getLatestRuleCheck(r.id).catch(() => null);
    const block = shouldBlockTrade(ruleCheck);
    if (block.blocked) {
      const halting = (ruleCheck?.findings ?? []).filter((f) => f.severity === 'halt');
      if (halting.length > 0) {
        for (const f of halting) blockers.push({ kind: 'halt', message: f.message });
      } else {
        blockers.push({ kind: 'halt', message: 'Rule reconciliation halted this account' });
      }
    }

    // 2. Subscription. Always false for an admin, so this is silent on a
    //    personal fleet and speaks up the moment it is not.
    if (r.user_id) {
      const ent = await entitlementForUser(r.user_id).catch(() => null);
      if (ent && !ent.canOpenNewTrades) {
        blockers.push({ kind: 'subscription', message: ent.reason ?? 'Subscription inactive' });
      }
    }

    // 3. Drawdown and daily room, computed the way the gate computes them.
    const startBalance = num(r.p_start_balance);
    const cumulative = num(r.cumulative_pnl);
    const maxDd = num(r.p_max_drawdown);
    const risk = nextStepRisk(r);

    let drawdownFloor: number | null = null;
    let drawdownRoom: number | null = null;
    let drawdownUnderstated = false;

    if (maxDd > 0) {
      const dd = await accountDrawdownState(
        r.id,
        {
          startBalance, maxDrawdown: maxDd,
          ddMode: r.p_dd_mode ?? 'static_fixed',
          safetyNetBuffer: r.p_safety_net_buffer === null ? null : num(r.p_safety_net_buffer),
        },
        startBalance + cumulative,
        cumulative
      ).catch(() => null);
      if (dd) {
        drawdownFloor = dd.floor;
        drawdownRoom = dd.room;
        drawdownUnderstated = dd.understated;
        if (risk !== null && dd.room < risk) {
          blockers.push({
            kind: 'drawdown',
            message: `Next step risks $${risk} against $${dd.room} of room above the $${dd.floor} floor`,
          });
        }
      }
    }

    const dailyLossCap = num(r.p_daily_loss_cap);
    const dllRoom = dllHeadroom(dailyLossCap, num(r.day_realized_pnl), num(r.p_dll_buffer_pct));
    if (risk !== null && dailyLossCap > 0 && risk > dllRoom) {
      blockers.push({ kind: 'dll', message: `Next step risks $${risk} against $${dllRoom} of daily room` });
    }

    // 4. Day and session state.
    if (r.day_locked_out) {
      blockers.push({ kind: 'locked_out', message: 'Day locked out after a max-step loss' });
    }
    const maxTrades = r.p_max_trades_day ?? 3;
    if ((r.trades_today ?? 0) >= maxTrades) {
      blockers.push({ kind: 'max_trades', message: `${r.trades_today} of ${maxTrades} trades used today` });
    }
    if (r.open_id) {
      blockers.push({ kind: 'trade_open', message: 'A trade is already open on this account' });
    }

    accounts.push({
      id: r.id, name: r.name,
      presetName: r.p_name, propFirm: r.prop_firm, phase: r.p_phase,
      ladderStep: r.ladder_step ?? 1, nextStepRisk: risk,
      dayPnl: num(r.day_realized_pnl), dailyLossCap, dllRoom,
      drawdownFloor, drawdownRoom, drawdownUnderstated,
      tradesToday: r.trades_today ?? 0, maxTradesPerDay: maxTrades,
      sessionsUsed: { london: r.london_used, nyam: r.nyam_used, nypm: r.nypm_used },
      dayLockedOut: r.day_locked_out,
      openTrade: r.open_id
        ? { id: r.open_id, symbol: r.open_symbol ?? '', direction: r.open_direction ?? '',
            contracts: r.open_contracts ?? 0, state: r.open_state ?? '' }
        : null,
      blockers,
    });
  }

  const failing = readinessReport.checks.filter((c) => c.status === 'fail');
  const view: OperationsView = {
    generatedAt: now.toISOString(),
    session: sessionState(now),
    readiness: {
      ready: readinessReport.ready,
      failing,
      warnings: readinessReport.checks.filter((c) => c.status === 'warn').length,
    },
    accounts,
    refusals: refusalRows.rows.map((x) => ({
      at: x.created_at.toISOString(),
      accountName: x.account_name,
      ruleType: x.rule_type,
      message: x.message,
    })),
    blockedCount: accounts.filter((a) => a.blockers.length > 0).length,
    accountsSummary: summariseAccounts(
      accounts.map((a) => a.name),
      accounts.filter((a) => a.blockers.length === 0).map((a) => a.name),
    ),
  };

  log.debug('Operations view assembled', {
    accounts: accounts.length, blocked: view.blockedCount, ready: view.readiness.ready,
  });
  return view;
}
