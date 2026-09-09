/**
 * Evaluation tracker.
 *
 * Feeds the pure lifecycle rules from real account state, persists outcome
 * transitions, and raises a risk event for the ones that cost money if missed.
 *
 * Trading days are COUNTED from account_daily_pnl rather than estimated. The
 * strategy trades three short windows a day and skips many of them, so a
 * "5 trading days a week" assumption would flatter every projection — which is
 * the opposite of what a countdown is for.
 */

import { query } from '../db';
import { assessEval, EvalAssessment, EvalSnapshot, staggerWarnings, addDays } from '../strategy/evalLifecycle';
import logger from '../utils/logger';

const log = logger.child({ context: 'EvalTracker' });

export interface TrackedEval {
  id: string;
  accountId: string | null;
  accountName: string | null;
  propFirm: string;
  accountSize: number;
  purchaseDate: string;
  expiresOn: string | null;
  evalCost: number;
  activationCost: number;
  currentBalance: number;
  assessment: EvalAssessment;
}

interface EvalRow extends Record<string, unknown> {
  id: string;
  broker_account_id: string | null;
  account_name: string | null;
  prop_firm: string;
  account_size: number;
  purchase_date: Date | string;
  expires_on: Date | string | null;
  pass_date: Date | string | null;
  activation_deadline: Date | string | null;
  eval_cost: string | number;
  activation_cost: string | number;
  outcome: 'in_progress' | 'passed' | 'blown' | 'expired';
  cumulative_pnl: string | number | null;
  p_start_balance: string | number | null;
  p_target_profit: string | number | null;
  p_max_drawdown: string | number | null;
  p_min_trading_days: number | null;
}

const d = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);

const num = (v: string | number | null | undefined, fallback = 0): number =>
  v === null || v === undefined ? fallback : Number(v);

const EVAL_SQL = `
  SELECT e.*, ba.name AS account_name, ba.cumulative_pnl,
         p.start_balance AS p_start_balance,
         p.target_profit AS p_target_profit,
         p.max_drawdown  AS p_max_drawdown,
         p.min_trading_days AS p_min_trading_days
  FROM evals e
  LEFT JOIN broker_accounts ba ON ba.id = e.broker_account_id
  LEFT JOIN presets p ON p.id = ba.preset_id
`;

/** Today in ET, matching the broker-day calendar the deadlines are quoted in. */
function todayEt(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** How many distinct days this account actually produced P&L on. */
async function countTradingDays(accountId: string | null, since: string): Promise<number> {
  if (!accountId) return 0;
  const r = await query<{ n: string }>(
    `SELECT COUNT(DISTINCT day_key) AS n FROM account_daily_pnl
     WHERE account_id = $1 AND day_key >= $2::date AND realized_pnl <> 0`,
    [accountId, since]
  );
  return parseInt(r.rows[0]?.n ?? '0', 10);
}

async function buildTracked(row: EvalRow, today: string): Promise<TrackedEval> {
  const purchaseDate = d(row.purchase_date)!;
  const startBalance = num(row.p_start_balance, row.account_size);

  const snapshot: EvalSnapshot = {
    outcome: row.outcome,
    purchaseDate,
    expiresOn: d(row.expires_on),
    passDate: d(row.pass_date),
    activationDeadline: d(row.activation_deadline),
    startBalance,
    targetProfit: num(row.p_target_profit),
    maxDrawdown: num(row.p_max_drawdown),
    minTradingDays: row.p_min_trading_days ?? 0,
  };

  const currentBalance = startBalance + num(row.cumulative_pnl);
  const tradingDaysObserved = await countTradingDays(row.broker_account_id, purchaseDate);

  return {
    id: row.id,
    accountId: row.broker_account_id,
    accountName: row.account_name,
    propFirm: row.prop_firm,
    accountSize: row.account_size,
    purchaseDate,
    expiresOn: d(row.expires_on),
    evalCost: num(row.eval_cost),
    activationCost: num(row.activation_cost),
    currentBalance,
    assessment: assessEval({ snapshot, currentBalance, today, tradingDaysObserved }),
  };
}

export interface EvalOverview {
  evals: TrackedEval[];
  staggerWarnings: string[];
  totals: {
    inProgress: number;
    passed: number;
    blown: number;
    expired: number;
    spent: number;
    /** Evaluations whose projection does not reach target before expiry. */
    offPace: number;
    /** Passed evals whose activation window closes within 2 days. */
    activationUrgent: number;
  };
}

/** Every tracked evaluation, assessed against current account state. */
export async function listEvals(scopeSql = 'TRUE', params: unknown[] = []): Promise<EvalOverview> {
  const today = todayEt();
  const r = await query<EvalRow>(`${EVAL_SQL} WHERE ${scopeSql} ORDER BY e.purchase_date DESC`, params);

  const evals: TrackedEval[] = [];
  for (const row of r.rows) evals.push(await buildTracked(row, today));

  const active = evals.filter((e) => e.assessment.outcome === 'in_progress');

  return {
    evals,
    staggerWarnings: staggerWarnings(active.map((e) => e.purchaseDate)),
    totals: {
      inProgress: active.length,
      passed: evals.filter((e) => e.assessment.outcome === 'passed').length,
      blown: evals.filter((e) => e.assessment.outcome === 'blown').length,
      expired: evals.filter((e) => e.assessment.outcome === 'expired').length,
      spent: Number(evals.reduce((s, e) => s + e.evalCost + e.activationCost, 0).toFixed(2)),
      offPace: active.filter((e) => e.assessment.onTrack === false).length,
      activationUrgent: evals.filter(
        (e) =>
          e.assessment.outcome === 'passed' &&
          e.assessment.daysToActivationDeadline !== null &&
          e.assessment.daysToActivationDeadline >= 0 &&
          e.assessment.daysToActivationDeadline <= 2
      ).length,
    },
  };
}

/**
 * Sweep every in-progress evaluation and persist any outcome change.
 *
 * Only writes on a transition. Re-running is safe and does nothing when
 * nothing has changed — which matters, because this runs on a schedule and an
 * eval spends most of its life in the same state.
 */
export async function refreshEvalOutcomes(): Promise<TrackedEval[]> {
  const today = todayEt();
  const r = await query<EvalRow>(`${EVAL_SQL} WHERE e.outcome = 'in_progress'`);
  const changed: TrackedEval[] = [];

  for (const row of r.rows) {
    const tracked = await buildTracked(row, today);
    const a = tracked.assessment;
    if (!a.changed) continue;

    const passDate = a.outcome === 'passed' ? today : null;
    const activationDeadline = a.outcome === 'passed' ? addDays(today, 7) : null;
    const daysToPass = a.outcome === 'passed' ? a.daysElapsed : null;

    await query(
      `UPDATE evals
       SET outcome = $2, pass_date = $3, activation_deadline = $4,
           days_to_pass = $5, updated_at = NOW()
       WHERE id = $1`,
      [row.id, a.outcome, passDate, activationDeadline, daysToPass]
    );

    log.warn('Evaluation outcome changed', {
      evalId: row.id, accountName: tracked.accountName,
      outcome: a.outcome, reason: a.reason,
    });

    // A transition is money moving: a pass starts a 7-day fee clock, a blow or
    // an expiry means buying a replacement. None of it should be discovered by
    // happening to look at a dashboard.
    if (tracked.accountId) {
      await query(
        `INSERT INTO risk_events (type, rule_type, account_id, message, details, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          a.outcome === 'passed' ? 'warning' : 'kill_switch',
          `eval_${a.outcome}`,
          tracked.accountId,
          a.outcome === 'passed'
            ? `Evaluation passed on day ${a.daysElapsed}. Activation fee due by ${activationDeadline} or the funded account is forfeited.`
            : `Evaluation ${a.outcome}: ${a.reason}`,
          JSON.stringify({ evalId: row.id, profit: a.profit, daysElapsed: a.daysElapsed }),
        ]
      ).catch(() => undefined);
    }

    changed.push(tracked);
  }

  if (changed.length > 0) {
    log.info('Eval sweep complete', { transitions: changed.length });
  }
  return changed;
}

export interface CreateEvalInput {
  brokerAccountId?: string | null;
  propFirm: string;
  accountSize: number;
  purchaseDate: string;
  evalCost?: number;
  activationCost?: number;
  /** Calendar days the evaluation stays active. 0 or omitted = no expiry. */
  expiryDays?: number;
  userId?: string | null;
}

/** Record an evaluation purchase. */
export async function createEval(input: CreateEvalInput): Promise<{ id: string; expiresOn: string | null }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate)) {
    throw new Error('purchaseDate must be YYYY-MM-DD');
  }
  if (!Number.isFinite(input.accountSize) || input.accountSize <= 0) {
    throw new Error('accountSize must be a positive number');
  }

  const expiresOn = input.expiryDays && input.expiryDays > 0
    ? addDays(input.purchaseDate, input.expiryDays)
    : null;

  const r = await query<{ id: string }>(
    `INSERT INTO evals
       (user_id, broker_account_id, prop_firm, account_size, purchase_date,
        eval_cost, activation_cost, expires_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.userId ?? null,
      input.brokerAccountId ?? null,
      input.propFirm,
      Math.round(input.accountSize),
      input.purchaseDate,
      input.evalCost ?? 0,
      input.activationCost ?? 0,
      expiresOn,
    ]
  );

  log.info('Evaluation recorded', { id: r.rows[0].id, propFirm: input.propFirm, expiresOn });
  return { id: r.rows[0].id, expiresOn };
}
