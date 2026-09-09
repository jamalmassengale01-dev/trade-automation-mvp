/**
 * Which events are worth telling a human about, and how often.
 *
 * The system already records everything it does in risk_events. That is an
 * audit trail, not an alerting system, and the difference is judgement: an
 * alerting system that forwards everything is one nobody reads, and one nobody
 * reads is worse than none because it produces the feeling of being covered.
 *
 * Two decisions live here, both pure:
 *
 *   1. IS IT NOTIFIABLE? Most gate rejections are the system working. A signal
 *      outside a session window, a session already traded, a third trade on a
 *      three-trade day — these are correct refusals and there are dozens a
 *      week. They belong in the log. What deserves a person's attention is
 *      money moving, an account dying, or the system being unable to act.
 *
 *   2. HOW OFTEN? The rule reconciler sweeps every 15 minutes and re-raises a
 *      standing halt every time. Without a cooldown that is 96 identical
 *      messages a day, which trains the reader to ignore the channel — the
 *      precise outcome alerting exists to prevent. Every notifiable event
 *      therefore carries a dedupe key and a cooldown, and repeats inside the
 *      window are dropped rather than queued.
 */

export type NotifySeverity = 'critical' | 'warning' | 'info';

export interface RiskEventLike {
  id?: string;
  /** risk_events.type: rejection | kill_switch | warning */
  type: string;
  /** risk_events.rule_type, e.g. 'rule_drawdown_breached', 'eval_passed'. */
  ruleType: string;
  accountId: string | null;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface NotifyDecision {
  notify: boolean;
  severity: NotifySeverity;
  /** Collapses repeats of the same condition on the same account. */
  dedupeKey: string;
  /** Seconds before the same dedupe key may fire again. */
  cooldownSeconds: number;
  title: string;
  /** Why this is not notifiable, when it isn't. For debugging the filter. */
  suppressedBecause?: string;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Rules that are the system working correctly.
 *
 * Every one of these is a refusal the gates are supposed to make, and they
 * happen constantly. Notifying on them would bury the events that matter.
 */
const ROUTINE_REJECTIONS = new Set([
  'gb_outside_session',
  'gb_session_used',
  'gb_max_trades_day',
  'gb_trade_already_open',
  'gb_sniper_session',
  'gb_sniper_max_trades_day',
  'gb_stale_signal',
]);

/**
 * Conditions worth waking someone for, with how long to stay quiet afterwards.
 *
 * The cooldowns are deliberately long. A blown account is still blown an hour
 * later and repeating it adds nothing; a passed evaluation has a 7-day fee
 * clock, so a daily reminder is useful where an hourly one is nagging.
 */
const CRITICAL: Record<string, { cooldown: number; title: string }> = {
  // Account-ending, or already ended.
  rule_drawdown_breached:   { cooldown: 12 * HOUR, title: 'Account blown — drawdown floor breached' },
  gb_dll_breached:          { cooldown: 6 * HOUR,  title: 'Daily loss limit breached' },
  rule_reconciliation_halt: { cooldown: 6 * HOUR,  title: 'Trading halted — account state does not match the broker' },
  gb_rule_reconciliation_halt: { cooldown: 6 * HOUR, title: 'Signal refused — account is halted' },
  eval_blown:               { cooldown: 12 * HOUR, title: 'Evaluation blown' },
  eval_expired:             { cooldown: 12 * HOUR, title: 'Evaluation expired' },
  // Money is on the table and a clock is running.
  eval_passed:              { cooldown: 1 * DAY,   title: 'Evaluation passed — activation fee due' },
  // The system could not do the thing it was asked to do.
  eod_flatten_failed:       { cooldown: 1 * HOUR,  title: 'Could not flatten before the close' },
  gb_broker_no_brackets:    { cooldown: 6 * HOUR,  title: 'Broker cannot place brackets — trade refused' },
};

const WARNING: Record<string, { cooldown: number; title: string }> = {
  rule_drawdown_within_one_day:   { cooldown: 12 * HOUR, title: 'Less than one day of drawdown room left' },
  rule_drawdown_floor_understated:{ cooldown: 1 * DAY,   title: 'Drawdown floor may be understated' },
  rule_day_pnl_drift:             { cooldown: 6 * HOUR,  title: 'Day P&L disagrees with the broker' },
  rule_cumulative_pnl_drift:      { cooldown: 1 * DAY,   title: 'Cumulative P&L disagrees with the broker' },
  rule_account_size_mismatch:     { cooldown: 1 * DAY,   title: 'Account size does not match its preset' },
  rule_inactivity:                { cooldown: 1 * DAY,   title: 'Account idle — inactivity policy at risk' },
  rule_preset_never_verified:     { cooldown: 7 * DAY,   title: 'Preset has never been verified' },
  rule_preset_stale:              { cooldown: 7 * DAY,   title: 'Preset verification is stale' },
  gb_drawdown_headroom:           { cooldown: 6 * HOUR,  title: 'Trade refused — not enough drawdown room' },
  gb_drawdown_unknown:            { cooldown: 6 * HOUR,  title: 'Trade refused — drawdown state unknown' },
  gb_size_zero:                   { cooldown: 6 * HOUR,  title: 'Signal sized to zero contracts' },
  gb_no_stop_distance:            { cooldown: 6 * HOUR,  title: 'Signal carried no stop distance' },
  gb_unknown_instrument:          { cooldown: 6 * HOUR,  title: 'Signal for an unknown instrument' },
  gb_day_locked_out:              { cooldown: 12 * HOUR, title: 'Day locked out after a max-step loss' },
  eval_expiry_unreachable:        { cooldown: 1 * DAY,   title: 'Evaluation cannot reach target before expiry' },
  eval_expiry_tight:              { cooldown: 2 * DAY,   title: 'Evaluation is behind pace' },
};

/**
 * Should this event reach a person, and under what key?
 *
 * Unknown rule types default to notifying at warning severity. An unrecognised
 * event is more likely to be something new that nobody has classified yet than
 * something safe to drop, and a filter that silently swallows the unfamiliar
 * is how a real alert goes missing.
 */
export function classifyEvent(event: RiskEventLike): NotifyDecision {
  const account = event.accountId ?? 'no-account';
  const key = `${event.ruleType}:${account}`;

  if (ROUTINE_REJECTIONS.has(event.ruleType)) {
    return {
      notify: false,
      severity: 'info',
      dedupeKey: key,
      cooldownSeconds: 0,
      title: event.ruleType,
      suppressedBecause: 'routine gate rejection — the system working as designed',
    };
  }

  const critical = CRITICAL[event.ruleType];
  if (critical) {
    return {
      notify: true, severity: 'critical', dedupeKey: key,
      cooldownSeconds: critical.cooldown, title: critical.title,
    };
  }

  const warning = WARNING[event.ruleType];
  if (warning) {
    return {
      notify: true, severity: 'warning', dedupeKey: key,
      cooldownSeconds: warning.cooldown, title: warning.title,
    };
  }

  // A kill_switch we do not recognise is still a kill switch.
  const severity: NotifySeverity = event.type === 'kill_switch' ? 'critical' : 'warning';
  return {
    notify: true,
    severity,
    dedupeKey: key,
    cooldownSeconds: 6 * HOUR,
    title: `Unclassified ${event.type}: ${event.ruleType}`,
  };
}

/** Has this key fired recently enough to suppress a repeat? */
export function withinCooldown(
  lastSentAt: Date | null,
  cooldownSeconds: number,
  now: Date = new Date()
): boolean {
  if (!lastSentAt || cooldownSeconds <= 0) return false;
  return now.getTime() - lastSentAt.getTime() < cooldownSeconds * 1000;
}

/** One-line summary for a channel that shows a title only. */
export function formatTitle(decision: NotifyDecision, accountName: string | null): string {
  const mark = decision.severity === 'critical' ? '🔴' : decision.severity === 'warning' ? '🟡' : 'ℹ️';
  return accountName ? `${mark} ${accountName}: ${decision.title}` : `${mark} ${decision.title}`;
}
