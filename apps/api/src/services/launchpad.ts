/**
 * LaunchPad service — payout status per funded account.
 *
 * Feeds the pure rules in strategy/launchpad.ts from real account history.
 *
 * Qualifying days are DERIVED on read from account_daily_pnl rather than
 * stored. Whether a day qualifies depends on the preset's threshold, and that
 * threshold changes when a firm updates its rules — a stored verdict would
 * freeze a judgement made under terms that no longer apply, and quietly
 * disagree with what the firm would say today.
 */

import { query } from '../db';
import {
  payoutEligibility,
  PayoutEligibility,
  PayoutRules,
  DailyPnl,
} from '../strategy/launchpad';
import logger from '../utils/logger';

const log = logger.child({ context: 'LaunchpadService' });

export interface AccountPayoutStatus {
  accountId: string;
  accountName: string;
  presetId: string | null;
  phase: 'eval' | 'funded' | null;
  currentBalance: number;
  /** Cumulative P&L since the last approved payout. */
  profitSinceLastPayout: number;
  payoutsTaken: number;
  totalExtracted: number;
  lastPayoutAt: string | null;
  eligibility: PayoutEligibility | null;
  /** Null when the account has no preset, or is an eval rather than a PA. */
  unavailableReason?: string;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  name: string;
  preset_id: string | null;
  cumulative_pnl: string | number;
  p_phase: string | null;
  p_start_balance: string | number | null;
  p_max_drawdown: string | number | null;
  p_qualifying_day_threshold: string | number | null;
  p_required_qualifying_days: number | null;
  p_min_payout: string | number | null;
  p_safety_net_buffer: string | number | null;
  p_consistency_pct: string | number | null;
  p_min_trading_days: number | null;
  p_payout_schedule: number[] | null;
}

const num = (v: string | number | null | undefined, fallback = 0): number =>
  v === null || v === undefined ? fallback : Number(v);

const ACCOUNT_SQL = `
  SELECT ba.id, ba.name, ba.preset_id, ba.cumulative_pnl,
         p.phase                    AS p_phase,
         p.start_balance            AS p_start_balance,
         p.max_drawdown             AS p_max_drawdown,
         p.qualifying_day_threshold AS p_qualifying_day_threshold,
         p.required_qualifying_days AS p_required_qualifying_days,
         p.min_payout               AS p_min_payout,
         p.safety_net_buffer        AS p_safety_net_buffer,
         p.payout_schedule          AS p_payout_schedule,
         p.consistency_pct          AS p_consistency_pct,
         p.min_trading_days         AS p_min_trading_days
  FROM broker_accounts ba
  LEFT JOIN presets p ON p.id = ba.preset_id
`;

/** Payout status for one account. */
export async function getAccountPayoutStatus(accountId: string): Promise<AccountPayoutStatus | null> {
  const r = await query<AccountRow>(`${ACCOUNT_SQL} WHERE ba.id = $1`, [accountId]);
  const acct = r.rows[0];
  if (!acct) return null;
  return buildStatus(acct);
}

/** Payout status across every funded account. */
export async function listPayoutStatus(scopeSql = 'TRUE', params: unknown[] = []): Promise<AccountPayoutStatus[]> {
  const r = await query<AccountRow>(
    `${ACCOUNT_SQL} WHERE ${scopeSql} ORDER BY ba.name`,
    params
  );
  const out: AccountPayoutStatus[] = [];
  for (const acct of r.rows) out.push(await buildStatus(acct));
  return out;
}

async function buildStatus(acct: AccountRow): Promise<AccountPayoutStatus> {
  const base = {
    accountId: acct.id,
    accountName: acct.name,
    presetId: acct.preset_id,
    phase: (acct.p_phase as 'eval' | 'funded' | null) ?? null,
    currentBalance: 0,
    profitSinceLastPayout: 0,
    payoutsTaken: 0,
    totalExtracted: 0,
    lastPayoutAt: null as string | null,
    eligibility: null as PayoutEligibility | null,
  };

  if (!acct.preset_id) {
    return { ...base, unavailableReason: 'No prop-firm preset assigned' };
  }
  if (acct.p_phase !== 'funded') {
    // Evaluations have no payouts; they have a profit target instead.
    return { ...base, unavailableReason: 'Evaluation account — payouts begin after funding' };
  }
  if (!acct.p_payout_schedule || acct.p_payout_schedule.length === 0) {
    return { ...base, unavailableReason: 'Preset has no payout schedule configured' };
  }

  // Approved payouts define the window: everything since the last one.
  const payoutRes = await query<{ n: string; total: string; last_at: Date | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total, MAX(approved_at) AS last_at
     FROM payouts WHERE broker_account_id = $1 AND status = 'approved'`,
    [acct.id]
  );
  const payoutsTaken = parseInt(payoutRes.rows[0]?.n ?? '0', 10);
  const totalExtracted = num(payoutRes.rows[0]?.total);
  const lastPayoutAt = payoutRes.rows[0]?.last_at ?? null;

  const dayRes = await query<{ day_key: Date | string; realized_pnl: string }>(
    `SELECT day_key, realized_pnl FROM account_daily_pnl
     WHERE account_id = $1 ${lastPayoutAt ? 'AND day_key > $2::date' : ''}
     ORDER BY day_key`,
    lastPayoutAt ? [acct.id, lastPayoutAt] : [acct.id]
  );
  const days: DailyPnl[] = dayRes.rows.map((d) => ({
    dayKey: typeof d.day_key === 'string' ? d.day_key.slice(0, 10) : d.day_key.toISOString().slice(0, 10),
    pnl: num(d.realized_pnl),
  }));

  const startBalance = num(acct.p_start_balance);
  const currentBalance = Number((startBalance + num(acct.cumulative_pnl) - totalExtracted).toFixed(2));
  const profitSinceLastPayout = Number(days.reduce((s, d) => s + d.pnl, 0).toFixed(2));

  const rules: PayoutRules = {
    qualifyingDayThreshold: num(acct.p_qualifying_day_threshold, 250),
    requiredQualifyingDays: acct.p_required_qualifying_days ?? 5,
    safetyNetBalance: startBalance + num(acct.p_max_drawdown) + num(acct.p_safety_net_buffer, 100),
    minPayout: num(acct.p_min_payout, 500),
    // NULL means the firm imposes no consistency rule (Phidias evaluations).
    // 0 is the "nothing can dominate" case consistencyStatus already handles,
    // so NULL maps to it directly rather than falling back to Apex's 50 —
    // defaulting a missing rule to a STRICTER one would block payouts that
    // the firm would allow.
    consistencyPct: acct.p_consistency_pct === null || acct.p_consistency_pct === undefined
      ? 0
      : num(acct.p_consistency_pct),
    payoutSchedule: acct.p_payout_schedule,
  };

  const eligibility = payoutEligibility({
    daysSinceLastPayout: days,
    currentBalance,
    payoutsAlreadyTaken: payoutsTaken,
    rules,
  });

  return {
    ...base,
    currentBalance,
    profitSinceLastPayout,
    payoutsTaken,
    totalExtracted,
    lastPayoutAt: lastPayoutAt ? new Date(lastPayoutAt).toISOString() : null,
    eligibility,
  };
}

/**
 * Record a payout request.
 *
 * Re-checks eligibility server-side rather than trusting the caller: the UI's
 * view can be minutes stale, and a request logged against an account that is
 * not actually eligible corrupts the payout numbering for the whole cycle.
 */
export async function requestPayout(
  accountId: string,
  amount?: number
): Promise<{ payoutNumber: number; amount: number }> {
  const status = await getAccountPayoutStatus(accountId);
  if (!status) throw new Error('Account not found');
  if (status.unavailableReason) throw new Error(status.unavailableReason);

  const e = status.eligibility!;
  if (!e.eligible) {
    throw new Error(`Not eligible: ${e.blockers.map((b) => b.message).join(' ')}`);
  }

  const requested = amount ?? e.requestableAmount;
  if (requested <= 0) throw new Error('Requested amount must be positive');
  if (requested > e.requestableAmount) {
    throw new Error(
      `Requested $${requested} exceeds the $${e.requestableAmount} available for payout #${e.payoutNumber}`
    );
  }

  await query(
    `INSERT INTO payouts (broker_account_id, payout_number, amount, status)
     VALUES ($1, $2, $3, 'pending')`,
    [accountId, e.payoutNumber, requested]
  );

  log.info('Payout requested', { accountId, payoutNumber: e.payoutNumber, amount: requested });
  return { payoutNumber: e.payoutNumber!, amount: requested };
}

/** Mark a payout approved or denied once the firm has ruled on it. */
export async function settlePayout(
  payoutId: string,
  status: 'approved' | 'denied',
  notes?: string
): Promise<void> {
  const r = await query(
    `UPDATE payouts
     SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE NULL END,
         notes = COALESCE($3, notes)
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [payoutId, status, notes ?? null]
  );
  if (r.rowCount === 0) throw new Error('Payout not found, or already settled');
  log.info('Payout settled', { payoutId, status });
}
