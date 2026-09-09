/**
 * Notification dispatcher.
 *
 * Reads new risk_events, decides which deserve a person's attention, and
 * delivers them. Runs on a schedule and never on the signal path — a channel
 * being down must not stop a trade, and a slow webhook must not delay a fill.
 *
 * DELIVERY
 *
 * One channel is always present: the log. It is not a placeholder — a
 * notification that reached the log and nowhere else is still recorded, still
 * deduped, and still visible in the notifications table, so the system is
 * honest about what it tried to tell you even with nothing configured.
 *
 * The optional channel is a generic webhook (NOTIFY_WEBHOOK_URL). Generic
 * rather than a Slack or Discord client on purpose: Slack, Discord, ntfy,
 * Zapier, Make and a plain HTTP endpoint all accept a JSON POST, so one
 * implementation covers every one of them and adding email later is a sender,
 * not a rewrite.
 *
 * FAILURE
 *
 * Delivery failures are recorded and retried, never thrown. The dispatcher's
 * job is to be the thing that tells you something is wrong; it failing loudly
 * enough to take down the process would be self-defeating.
 */

import { query } from '../db';
import {
  classifyEvent, withinCooldown, formatTitle,
  RiskEventLike, NotifySeverity,
} from '../strategy/notifications';
import logger from '../utils/logger';

const log = logger.child({ context: 'Notifications' });

const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL ?? '';
const WEBHOOK_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 4;
/** Never deliver more than this in one sweep, however far behind. */
const MAX_PER_SWEEP = 25;

export interface PendingNotification {
  id: string;
  accountId: string | null;
  accountName: string | null;
  severity: NotifySeverity;
  title: string;
  body: string;
  details: Record<string, unknown>;
  dedupeKey: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Ingest: risk_events → notifications
// ---------------------------------------------------------------------------

interface EventRow extends Record<string, unknown> {
  id: string;
  type: string;
  rule_type: string;
  account_id: string | null;
  message: string;
  details: Record<string, unknown> | null;
  created_at: Date;
  account_name: string | null;
  user_id: string | null;
}

/**
 * Turn risk events newer than the cursor into notifications.
 *
 * Suppressed events are still ROWS, marked 'suppressed'. Recording the decision
 * not to notify is what makes the filter debuggable — "why didn't I hear about
 * this?" has an answer in the table rather than requiring a code read.
 */
export async function ingestRiskEvents(now: Date = new Date()): Promise<{ queued: number; suppressed: number }> {
  const cursor = await query<{ last_event_at: Date }>(
    'SELECT last_event_at FROM notification_cursor WHERE id = 1'
  );
  const since = cursor.rows[0]?.last_event_at ?? now;

  const events = await query<EventRow>(
    `SELECT re.id, re.type, re.rule_type, re.account_id, re.message, re.details,
            re.created_at, ba.name AS account_name, ba.user_id
     FROM risk_events re
     LEFT JOIN broker_accounts ba ON ba.id = re.account_id
     WHERE re.created_at > $1
     ORDER BY re.created_at ASC
     LIMIT 500`,
    [since]
  );
  if (events.rows.length === 0) return { queued: 0, suppressed: 0 };

  let queued = 0;
  let suppressed = 0;

  for (const e of events.rows) {
    const event: RiskEventLike = {
      id: e.id, type: e.type, ruleType: e.rule_type,
      accountId: e.account_id, message: e.message, details: e.details,
    };
    const decision = classifyEvent(event);

    if (!decision.notify) {
      suppressed++;
      await query(
        `INSERT INTO notifications
           (risk_event_id, account_id, user_id, severity, title, body, details,
            dedupe_key, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'suppressed')`,
        [
          e.id, e.account_id, e.user_id, 'info', decision.title, e.message,
          JSON.stringify({ ...(e.details ?? {}), suppressedBecause: decision.suppressedBecause }),
          decision.dedupeKey,
        ]
      ).catch((err) => log.error('Failed to record suppressed notification', { error: String(err) }));
      continue;
    }

    // Cooldown is measured from the last SENT message on this key, not the last
    // queued one — a message that failed to deliver has not informed anyone, so
    // it must not suppress the retry of the same condition.
    const last = await query<{ sent_at: Date }>(
      `SELECT sent_at FROM notifications
       WHERE dedupe_key = $1 AND status = 'sent'
       ORDER BY sent_at DESC LIMIT 1`,
      [decision.dedupeKey]
    );
    if (withinCooldown(last.rows[0]?.sent_at ?? null, decision.cooldownSeconds, now)) {
      suppressed++;
      continue;
    }

    await query(
      `INSERT INTO notifications
         (risk_event_id, account_id, user_id, severity, title, body, details, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.id, e.account_id, e.user_id, decision.severity,
        formatTitle(decision, e.account_name), e.message,
        JSON.stringify(e.details ?? {}), decision.dedupeKey,
      ]
    );
    queued++;
  }

  const newest = events.rows[events.rows.length - 1].created_at;
  await query(
    'UPDATE notification_cursor SET last_event_at = $1, updated_at = NOW() WHERE id = 1',
    [newest]
  );

  if (queued > 0) log.info('Queued notifications', { queued, suppressed });
  return { queued, suppressed };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** POST the notification as JSON. Returns null on success, else the error. */
async function deliverWebhook(n: PendingNotification): Promise<string | null> {
  if (!WEBHOOK_URL) return null; // not configured is not a failure

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is what Slack, Discord and ntfy all render; the structured
      // fields sit alongside for anything that wants them.
      body: JSON.stringify({
        text: `${n.title}\n${n.body}`,
        severity: n.severity,
        account: n.accountName,
        title: n.title,
        message: n.body,
        details: n.details,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return `webhook ${res.status}: ${text.slice(0, 200)}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver queued notifications.
 *
 * A notification that exhausts its attempts is marked failed and left alone.
 * Retrying forever would eventually deliver a stale alert about a condition
 * that has since resolved, which is worse than not delivering it.
 */
export async function dispatchPending(): Promise<{ sent: number; failed: number }> {
  const rows = await query<{
    id: string; account_id: string | null; account_name: string | null;
    severity: NotifySeverity; title: string; body: string;
    details: Record<string, unknown>; dedupe_key: string; attempts: number;
  }>(
    `SELECT n.id, n.account_id, n.severity, n.title, n.body, n.details,
            n.dedupe_key, n.attempts, ba.name AS account_name
     FROM notifications n
     LEFT JOIN broker_accounts ba ON ba.id = n.account_id
     WHERE n.status = 'pending' AND n.attempts < $1
     ORDER BY
       CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       n.created_at ASC
     LIMIT $2`,
    [MAX_ATTEMPTS, MAX_PER_SWEEP]
  );

  let sent = 0;
  let failed = 0;

  for (const row of rows.rows) {
    const n: PendingNotification = {
      id: row.id, accountId: row.account_id, accountName: row.account_name,
      severity: row.severity, title: row.title, body: row.body,
      details: row.details ?? {}, dedupeKey: row.dedupe_key, attempts: row.attempts,
    };

    // The log channel always runs, so a notification is never lost merely
    // because no external channel is configured.
    const line = `NOTIFY [${n.severity}] ${n.title} — ${n.body}`;
    if (n.severity === 'critical') log.error(line, { details: n.details });
    else log.warn(line, { details: n.details });

    const error = await deliverWebhook(n);

    if (error) {
      failed++;
      const attempts = n.attempts + 1;
      await query(
        `UPDATE notifications
         SET attempts = $2, last_error = $3,
             status = CASE WHEN $2 >= $4 THEN 'failed' ELSE 'pending' END
         WHERE id = $1`,
        [n.id, attempts, error, MAX_ATTEMPTS]
      );
      log.error('Notification delivery failed', {
        id: n.id, attempts, error, willRetry: attempts < MAX_ATTEMPTS,
      });
    } else {
      sent++;
      await query(
        `UPDATE notifications SET status = 'sent', sent_at = NOW(), attempts = attempts + 1
         WHERE id = $1`,
        [n.id]
      );
    }
  }

  return { sent, failed };
}

/** Ingest then deliver. Safe to call on a timer; never throws. */
export async function notificationSweep(): Promise<{ queued: number; sent: number; failed: number }> {
  try {
    const { queued } = await ingestRiskEvents();
    const { sent, failed } = await dispatchPending();
    return { queued, sent, failed };
  } catch (error) {
    log.error('Notification sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { queued: 0, sent: 0, failed: 0 };
  }
}

/** Whether any channel beyond the log is configured. */
export function externalChannelConfigured(): boolean {
  return WEBHOOK_URL.length > 0;
}
