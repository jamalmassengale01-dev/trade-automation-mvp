/**
 * Manual P&L adjustments.
 *
 * `account_daily_pnl` and `broker_accounts.cumulative_pnl` have exactly one
 * writer in the rest of the system — `bracketManager` on trade close. EdgePilot
 * therefore only knows P&L for trades it placed itself.
 *
 * That is fine until it isn't. A trade taken by hand in the broker platform, a
 * firm adjustment, a commission the model did not predict, a fill the WebSocket
 * missed during a reconnect — any of these and tracked state diverges from the
 * broker permanently. `ruleReconciliation` already detects the divergence, and
 * until now its advice was to "backfill account_daily_pnl", which nothing could
 * do.
 *
 * This is that backfill. It matters more than a bookkeeping tidy-up because the
 * trailing drawdown floor is DERIVED from this table: a missing profitable day
 * lowers the computed floor, which overstates the room above it, which is the
 * direction that ends accounts.
 *
 * Every adjustment raises a risk event. A hand-written number that changes what
 * the gate will permit must never be invisible in the audit trail.
 */

import { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { eodHighWater } from './accountDrawdown';
import logger from '../utils/logger';

const log = logger.child({ context: 'PnlAdjustment' });

export interface AdjustmentInput {
  accountId: string;
  /** Broker day this belongs to, YYYY-MM-DD. */
  dayKey: string;
  /** Signed dollars. Negative for a loss the system did not record. */
  amount: number;
  /** Why. Required — an unexplained adjustment is indistinguishable from a bug. */
  reason: string;
  adjustedBy?: string | null;
}

export interface AdjustmentResult {
  accountId: string;
  dayKey: string;
  amount: number;
  cumulativePnlBefore: number;
  cumulativePnlAfter: number;
  dayPnlAfter: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Apply a dated P&L correction.
 *
 * Writes both tables in one transaction: they are two views of the same fact,
 * and a partial write would leave the drawdown floor disagreeing with the
 * payout math with no indication which is right.
 */
export async function applyAdjustment(input: AdjustmentInput): Promise<AdjustmentResult> {
  if (!DAY_RE.test(input.dayKey)) {
    throw new Error('dayKey must be YYYY-MM-DD (the broker day, not the calendar date)');
  }
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new Error('amount must be a non-zero number');
  }
  if (!input.reason || input.reason.trim().length < 3) {
    throw new Error('reason is required — an unexplained adjustment cannot be audited later');
  }

  const amount = Number(input.amount.toFixed(2));

  const result = await withTransaction(async (client: PoolClient) => {
    // Lock the account row so a concurrent trade close cannot interleave
    // between reading cumulative_pnl and writing it.
    const before = await client.query<{ cumulative_pnl: string; name: string }>(
      'SELECT cumulative_pnl, name FROM broker_accounts WHERE id = $1 FOR UPDATE',
      [input.accountId]
    );
    if (before.rowCount === 0) throw new Error('Account not found');
    const cumulativeBefore = Number(before.rows[0].cumulative_pnl ?? 0);

    // Same upsert shape bracketManager uses, so a corrected day is
    // indistinguishable in structure from a traded one.
    const day = await client.query<{ realized_pnl: string }>(
      `INSERT INTO account_daily_pnl (account_id, day_key, realized_pnl, trades, updated_at)
       VALUES ($1, $2, $3, 0, NOW())
       ON CONFLICT (account_id, day_key) DO UPDATE
         SET realized_pnl = account_daily_pnl.realized_pnl + EXCLUDED.realized_pnl,
             updated_at = NOW()
       RETURNING realized_pnl`,
      [input.accountId, input.dayKey, amount]
    );

    await client.query(
      `UPDATE broker_accounts
       SET cumulative_pnl = cumulative_pnl + $2,
           day_realized_pnl = CASE WHEN last_day_key = $3::date
                                   THEN day_realized_pnl + $2 ELSE day_realized_pnl END,
           updated_at = NOW()
       WHERE id = $1`,
      [input.accountId, amount, input.dayKey]
    );

    return {
      accountId: input.accountId,
      accountName: before.rows[0].name,
      dayKey: input.dayKey,
      amount,
      cumulativePnlBefore: cumulativeBefore,
      cumulativePnlAfter: Number((cumulativeBefore + amount).toFixed(2)),
      dayPnlAfter: Number(day.rows[0].realized_pnl),
    };
  });

  // Outside the transaction: an audit write failing must not roll back a
  // correction that is already reflected in the numbers the gate reads.
  await query(
    `INSERT INTO risk_events (type, rule_type, account_id, message, details, created_at)
     VALUES ('warning', 'pnl_adjusted', $1, $2, $3, NOW())`,
    [
      input.accountId,
      `Manual P&L adjustment of ${amount >= 0 ? '+' : ''}$${amount} on ${input.dayKey}: ` +
      `${input.reason}. Cumulative P&L ${result.cumulativePnlBefore} → ${result.cumulativePnlAfter}. ` +
      'This changes the trailing drawdown floor and therefore what the gate will permit.',
      JSON.stringify({
        dayKey: input.dayKey, amount, reason: input.reason,
        adjustedBy: input.adjustedBy ?? null,
        cumulativeBefore: result.cumulativePnlBefore,
        cumulativeAfter: result.cumulativePnlAfter,
      }),
    ]
  ).catch((err) => log.error('Adjustment audit write failed', { error: String(err) }));

  log.warn('Manual P&L adjustment applied', {
    accountId: input.accountId, dayKey: input.dayKey, amount, reason: input.reason,
  });

  const { accountName: _drop, ...rest } = result;
  return rest;
}

export interface ResyncResult extends AdjustmentResult {
  brokerCumulativePnl: number;
  drift: number;
}

/**
 * Reconcile tracked cumulative P&L to what the broker reports.
 *
 * `ruleReconciliation` already fetches the broker's number every sweep,
 * compares it, records the comparison, and discards it. This is the missing
 * step: take that number and make the local mirror match, as one dated,
 * audited adjustment rather than a silent overwrite.
 *
 * Deliberately expressed as an adjustment. Overwriting `cumulative_pnl`
 * directly would lose the fact that a correction happened and how large it was,
 * which is exactly what someone investigating a blown account needs to see.
 */
export async function resyncToBroker(
  accountId: string,
  brokerCumulativePnl: number,
  dayKey: string,
  adjustedBy?: string | null
): Promise<ResyncResult | null> {
  const r = await query<{ cumulative_pnl: string }>(
    'SELECT cumulative_pnl FROM broker_accounts WHERE id = $1',
    [accountId]
  );
  if (r.rowCount === 0) throw new Error('Account not found');

  const tracked = Number(r.rows[0].cumulative_pnl ?? 0);
  const drift = Number((brokerCumulativePnl - tracked).toFixed(2));

  // Sub-cent drift is float noise, not a discrepancy worth an audit row.
  if (Math.abs(drift) < 0.01) return null;

  const applied = await applyAdjustment({
    accountId,
    dayKey,
    amount: drift,
    reason: `Resync to broker: tracked ${tracked}, broker reports ${brokerCumulativePnl}`,
    adjustedBy,
  });

  return { ...applied, brokerCumulativePnl, drift };
}

/**
 * Whether recorded daily history explains the account's cumulative P&L.
 *
 * The same completeness test the drawdown floor relies on, exposed so the
 * dashboard can say whether the floor is trustworthy before someone sizes a
 * trade against it.
 */
export async function historyIntegrity(
  accountId: string
): Promise<{ complete: boolean; dailyTotal: number; cumulative: number; gap: number }> {
  const [{ totalPnl }, acct] = await Promise.all([
    eodHighWater(accountId),
    query<{ cumulative_pnl: string }>(
      'SELECT cumulative_pnl FROM broker_accounts WHERE id = $1', [accountId]
    ),
  ]);
  const cumulative = Number(acct.rows[0]?.cumulative_pnl ?? 0);
  const gap = Number((cumulative - totalPnl).toFixed(2));
  return { complete: Math.abs(gap) < 0.01, dailyTotal: totalPnl, cumulative, gap };
}
