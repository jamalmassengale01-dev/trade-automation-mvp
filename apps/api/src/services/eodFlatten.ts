/**
 * End-of-day flatten.
 *
 * Apex: "All trades must be closed before 4:59 PM ET. It is your
 * responsibility to ensure that your account is flat before 4:59 PM ET. Apex
 * will not take responsibility for trades that are left open throughout market
 * close."
 *
 * Nothing in this system enforced that. The NY PM session opens trades between
 * 2:00 and 2:30 PM ET, and a Group 2 runner that never reaches TP2 simply stays
 * open — through 4:59, through the EOD threshold recalculation at 4:59:59, and
 * into the next session. Two things go wrong at once: the position is held
 * across a boundary Apex disclaims, and the closing balance that sets both the
 * next day's drawdown threshold and (on a PA) the next day's scaling tier is
 * computed while the trade is still in flight.
 *
 * This closes anything still open a few minutes early. The margin is
 * deliberate — a market order needs time to fill, and being flat at 4:58 costs
 * nothing while being open at 4:59 costs the guarantee.
 */

import { query } from '../db';
import { bracketManager } from '../strategy/bracketManager';
import { etMinutesOfDay } from '../strategy/sessions';
import logger from '../utils/logger';

const log = logger.child({ context: 'EodFlatten' });

/** 4:55 PM ET — four minutes of margin before Apex's 4:59 deadline. */
export const DEFAULT_FLATTEN_ET_MINUTE = 16 * 60 + 55;
/** Stop trying once the window has passed; the next day's sweep takes over. */
const WINDOW_MINUTES = 10;

export interface FlattenResult {
  accountId: string;
  accountName: string;
  tradesClosed: number;
  error?: string;
}

/**
 * True when `now` falls in the flatten window.
 *
 * Exported for tests: the behaviour that matters is that it fires within the
 * window and stays quiet outside it, including across the ET day boundary.
 */
export function inFlattenWindow(now: Date, cutoffMinute = DEFAULT_FLATTEN_ET_MINUTE): boolean {
  const minute = etMinutesOfDay(now);
  return minute >= cutoffMinute && minute < cutoffMinute + WINDOW_MINUTES;
}

/**
 * Close every open GB trade across the fleet.
 *
 * Runs per account and never lets one failure stop the rest — a broker error on
 * one account must not leave the other nineteen open through the close.
 */
export async function flattenOpenTrades(reason: string): Promise<FlattenResult[]> {
  const r = await query<{ id: string; name: string; open_trades: string }>(
    `SELECT ba.id, ba.name, COUNT(gt.id) AS open_trades
     FROM broker_accounts ba
     JOIN gb_trades gt ON gt.broker_account_id = ba.id
       AND gt.state NOT IN ('closed', 'failed')
     WHERE ba.is_active = true AND ba.is_disabled = false
     GROUP BY ba.id, ba.name`
  );

  if (r.rowCount === 0) return [];

  const results: FlattenResult[] = [];
  for (const row of r.rows) {
    try {
      const closed = await bracketManager.closeAll(row.id, reason);
      results.push({ accountId: row.id, accountName: row.name, tradesClosed: closed });
      log.warn('Flattened open trades before close', {
        accountId: row.id, accountName: row.name, closed, reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        accountId: row.id, accountName: row.name, tradesClosed: 0, error: message,
      });
      log.error('EOD flatten FAILED — position may be held through market close', {
        accountId: row.id, accountName: row.name, error: message,
      });
      await query(
        `INSERT INTO risk_events (type, rule_type, account_id, message, details, created_at)
         VALUES ('kill_switch', 'eod_flatten_failed', $1, $2, $3, NOW())`,
        [
          row.id,
          `Could not flatten before market close: ${message}. The position may be held ` +
          `through 4:59 PM ET, which Apex explicitly does not cover.`,
          JSON.stringify({ openTrades: Number(row.open_trades) }),
        ]
      ).catch(() => undefined);
    }
  }
  return results;
}

/**
 * Tick this once a minute. Fires at most once per ET day.
 *
 * The guard is a date string rather than a timer so a restart inside the window
 * does not re-flatten, and a restart before it does not miss the window.
 */
let lastFlattenDay: string | null = null;

export async function eodFlattenTick(
  now: Date = new Date(),
  cutoffMinute = DEFAULT_FLATTEN_ET_MINUTE
): Promise<FlattenResult[] | null> {
  if (!inFlattenWindow(now, cutoffMinute)) return null;

  const dayKey = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (lastFlattenDay === dayKey) return null;
  lastFlattenDay = dayKey;

  log.info('EOD flatten window reached', { dayKey });
  return flattenOpenTrades('eod_flatten');
}

/** Testing hook. */
export function __resetFlattenGuard(): void {
  lastFlattenDay = null;
}
