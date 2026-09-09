/**
 * Current drawdown floor for an account, from recorded daily P&L.
 *
 * Shared by the pre-trade gate and the background reconciler so the two can
 * never disagree about where the floor is — a gate that permits a trade the
 * reconciler would halt for is worse than either check alone.
 *
 * Only the HIGH-WATER end-of-day balance can move a trailing floor, so this
 * asks the database for that one number rather than reading every day's row.
 * The signal path fans one alert out to up to 20 accounts inside a 30-minute
 * window; twenty single-row aggregates is a different proposition from twenty
 * full-history reads.
 */

import { query } from '../db';
import { drawdownState, DrawdownState, DdMode } from '../strategy/drawdown';

export interface DrawdownPresetRules {
  startBalance: number;
  maxDrawdown: number;
  ddMode: DdMode;
  /** Dollars above start where a trailing floor locks. Null = never locks. */
  safetyNetBuffer: number | null;
}

/**
 * Highest end-of-day cumulative P&L the account has recorded, and the total.
 *
 * The running sum is taken in day order, so the max is the best the account
 * ever CLOSED a day at — not its best single day, and not its intraday peak.
 * That is the quantity an EOD-trailing floor follows.
 */
export async function eodHighWater(
  accountId: string
): Promise<{ highWaterPnl: number; totalPnl: number; days: number }> {
  const r = await query<{ high_water: string | null; total: string | null; days: string }>(
    `SELECT MAX(running) AS high_water, MAX(running_total) AS total, COUNT(*) AS days
     FROM (
       SELECT SUM(realized_pnl) OVER (ORDER BY day_key ROWS UNBOUNDED PRECEDING) AS running,
              SUM(realized_pnl) OVER ()                                          AS running_total
       FROM account_daily_pnl
       WHERE account_id = $1
     ) t`,
    [accountId]
  );
  const row = r.rows[0];
  return {
    // A floor never trails DOWN, so a purely losing history leaves it at its
    // starting position — hence the clamp at zero rather than a negative max.
    highWaterPnl: Math.max(0, Number(row?.high_water ?? 0)),
    totalPnl: Number(row?.total ?? 0),
    days: parseInt(row?.days ?? '0', 10),
  };
}

/**
 * Resolve an account's live drawdown state.
 *
 * `equity` should be broker truth where it is available (the reconciler has
 * it). On the signal path it is not, so the caller passes tracked equity —
 * which is exactly the number the reconciler cross-checks against the broker
 * every 15 minutes and halts on when it drifts.
 */
export async function accountDrawdownState(
  accountId: string,
  rules: DrawdownPresetRules,
  equity: number,
  cumulativePnl: number
): Promise<DrawdownState> {
  const { highWaterPnl, totalPnl } = await eodHighWater(accountId);

  // Only the maximum matters to the floor, so a one-element series carrying
  // the high-water balance is equivalent to the full history and far cheaper.
  const highWaterBalance = rules.startBalance + highWaterPnl;

  return drawdownState({
    ddMode: rules.ddMode,
    startBalance: rules.startBalance,
    maxDrawdown: rules.maxDrawdown,
    lockBuffer: rules.safetyNetBuffer,
    eodBalances: [highWaterBalance],
    currentEquity: equity,
    // If the daily rows do not account for all the P&L the account has booked,
    // profitable days are missing and the derived floor is too low — i.e. it
    // reports more room than exists, the dangerous direction.
    historyComplete: Math.abs(totalPnl - cumulativePnl) < 0.01,
  });
}
