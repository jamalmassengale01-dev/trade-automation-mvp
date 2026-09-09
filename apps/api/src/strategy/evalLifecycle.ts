/**
 * Evaluation lifecycle.
 *
 * An Apex evaluation is a race against two clocks that most tracking ignores:
 *
 *   - 30 calendar days from purchase, then it expires. No resets. A slow pass
 *     is a lost fee, not a delayed one.
 *   - 7 calendar days from being marked passed to pay the activation fee, or
 *     the funded account is forfeited and a new evaluation must be passed.
 *
 * So the interesting question is not "did it pass?" — you find that out
 * anyway. It is "is this one going to make it, and if not, how early can I
 * tell?" An eval trending toward day 40 is dead on day 12; knowing that on day
 * 12 is worth something, and nothing surfaces it unless something computes it.
 *
 * Pure: no db, no io, no clock. `today` is injected.
 */

export type EvalOutcome = 'in_progress' | 'passed' | 'blown' | 'expired';

export interface EvalSnapshot {
  outcome: EvalOutcome;
  /** YYYY-MM-DD. */
  purchaseDate: string;
  /** YYYY-MM-DD, or null when the firm imposes no expiry. */
  expiresOn: string | null;
  passDate: string | null;
  activationDeadline: string | null;
  startBalance: number;
  targetProfit: number;
  maxDrawdown: number;
  /** Trading days the firm requires before it will pass the evaluation. */
  minTradingDays?: number;
}

export type EvalUrgency = 'ok' | 'watch' | 'critical' | 'lapsed';

export interface EvalAssessment {
  outcome: EvalOutcome;
  /** True when the outcome differs from the stored one and should be written. */
  changed: boolean;
  /** Why it changed, for the audit trail. */
  reason?: string;

  profit: number;
  progressPct: number;
  /** Calendar days left before expiry. Negative once past. */
  daysRemaining: number | null;
  daysElapsed: number;
  /** Average profit per day that actually traded. */
  ratePerTradingDay: number;
  /** How many days actually produced P&L — the projection's sample size. */
  tradingDaysObserved: number;
  /**
   * Calendar days to reach target at the observed rate, or null when there is
   * not enough to project from: too few trading days, or a flat/negative rate.
   * A number here is a claim; null is the honest answer more often than not.
   */
  daysToTargetAtRate: number | null;
  /**
   * Optimistic/pessimistic bounds around that estimate, reflecting how lumpy
   * the process is. Null whenever daysToTargetAtRate is.
   */
  projectionRange: { fast: number; slow: number } | null;
  /** True when even the SLOW end of the projection lands inside the window. */
  onTrack: boolean | null;
  /** Why no projection is offered, when there isn't one. */
  projectionBlockedBy: 'insufficient_sample' | 'no_progress' | null;

  /** Days until the activation fee must be paid. Only set once passed. */
  daysToActivationDeadline: number | null;

  urgency: EvalUrgency;
  notes: string[];
}

const DAY_MS = 86_400_000;

/** Whole days between two YYYY-MM-DD dates, b - a. */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round((db - da) / DAY_MS);
}

/** YYYY-MM-DD `days` after `from`. */
export function addDays(from: string, days: number): string {
  const t = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(t)) return from;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

export interface AssessInput {
  snapshot: EvalSnapshot;
  currentBalance: number;
  /** YYYY-MM-DD. */
  today: string;
  /** Days from a pass being marked to the activation fee being due. */
  activationWindowDays?: number;
  /**
   * Days that actually produced P&L. Supplied by the caller from real trade
   * history rather than estimated: the strategy trades three short windows and
   * skips many sessions, so guessing "5 trading days per week" would flatter
   * every projection.
   */
  tradingDaysObserved?: number;
}

/**
 * Below this many trading days, no projection is offered at all.
 *
 * A rate drawn from two or three days of a strategy that takes at most three
 * trades a day is noise, and a confident-looking date built on noise is worse
 * than admitting there isn't one yet.
 */
export const MIN_TRADING_DAYS_TO_PROJECT = 5;

/** Trading days per calendar day — the deadline is calendar, the rate is not. */
const TRADING_DAYS_PER_CALENDAR_DAY = 5 / 7;

/**
 * Spread applied around the central estimate.
 *
 * The underlying process is lumpy: sessions that do not fire, a ladder that
 * changes size after a loss, and a win rate that is itself unvalidated. A
 * single number implies a precision the inputs do not support, so the estimate
 * is reported as a band and the on-track judgement uses its slow end.
 */
const PROJECTION_SPREAD = 0.4;

/**
 * Where an evaluation stands, and whether its stored outcome needs updating.
 *
 * Terminal outcomes are never revisited. An eval that passed and later drifted
 * below its drawdown is still passed — the outcome was decided at the moment
 * the target was reached, and re-deciding it later would rewrite history to
 * match a state the firm has already moved past.
 */
export function assessEval(input: AssessInput): EvalAssessment {
  const { snapshot: s, currentBalance, today } = input;
  const activationWindowDays = input.activationWindowDays ?? 7;
  const notes: string[] = [];

  const profit = Number((currentBalance - s.startBalance).toFixed(2));
  const progressPct =
    s.targetProfit > 0 ? Number(Math.max(0, (profit / s.targetProfit) * 100).toFixed(1)) : 0;

  const daysElapsed = Math.max(0, daysBetween(s.purchaseDate, today));
  const daysRemaining = s.expiresOn ? daysBetween(today, s.expiresOn) : null;

  // The rate is per TRADING day; the deadline is in CALENDAR days. Keeping the
  // units separate and converting once is the whole difference between a
  // projection you can act on and one that quietly flatters itself.
  const tradingDaysObserved = input.tradingDaysObserved ?? 0;
  const remainingProfit = Math.max(0, s.targetProfit - profit);
  const ratePerTradingDay =
    tradingDaysObserved > 0 ? Number((profit / tradingDaysObserved).toFixed(2)) : 0;

  let daysToTargetAtRate: number | null = null;
  let projectionRange: { fast: number; slow: number } | null = null;
  let projectionBlockedBy: 'insufficient_sample' | 'no_progress' | null = null;

  if (remainingProfit <= 0) {
    daysToTargetAtRate = 0;
  } else if (tradingDaysObserved < MIN_TRADING_DAYS_TO_PROJECT) {
    projectionBlockedBy = 'insufficient_sample';
  } else if (ratePerTradingDay <= 0) {
    projectionBlockedBy = 'no_progress';
  } else {
    const tradingDaysNeeded = remainingProfit / ratePerTradingDay;
    const calendarDays = tradingDaysNeeded / TRADING_DAYS_PER_CALENDAR_DAY;
    daysToTargetAtRate = Math.ceil(calendarDays);
    projectionRange = {
      fast: Math.ceil(calendarDays * (1 - PROJECTION_SPREAD)),
      slow: Math.ceil(calendarDays * (1 + PROJECTION_SPREAD)),
    };
  }

  // Judged on the SLOW end: an eval that only passes if everything goes right
  // is not on track.
  const onTrack =
    daysRemaining === null || daysToTargetAtRate === null
      ? null
      : (projectionRange?.slow ?? daysToTargetAtRate) <= daysRemaining;

  // ---- terminal outcomes stay terminal --------------------------------
  if (s.outcome !== 'in_progress') {
    let daysToActivationDeadline: number | null = null;
    let urgency: EvalUrgency = 'ok';

    if (s.outcome === 'passed' && s.activationDeadline) {
      daysToActivationDeadline = daysBetween(today, s.activationDeadline);
      if (daysToActivationDeadline < 0) {
        urgency = 'lapsed';
        notes.push(
          `Activation deadline passed ${Math.abs(daysToActivationDeadline)} day(s) ago. The ` +
          `funded account opportunity is forfeited; a new evaluation must be passed.`
        );
      } else if (daysToActivationDeadline <= 2) {
        urgency = 'critical';
        notes.push(
          `Activation fee due in ${daysToActivationDeadline} day(s) or the funded account is lost.`
        );
      } else {
        urgency = 'watch';
        notes.push(`Passed — activate within ${daysToActivationDeadline} day(s).`);
      }
    }

    return {
      outcome: s.outcome, changed: false, profit, progressPct,
      daysRemaining, daysElapsed, ratePerTradingDay, tradingDaysObserved,
      daysToTargetAtRate, projectionRange, onTrack, projectionBlockedBy,
      daysToActivationDeadline, urgency, notes,
    };
  }

  // ---- transitions, in priority order ---------------------------------
  // Blown first: an account that breached its drawdown is finished regardless
  // of what else is true of it.
  const drawdownFloor = s.startBalance - s.maxDrawdown;
  if (currentBalance <= drawdownFloor) {
    return {
      outcome: 'blown', changed: true,
      reason: `Balance $${round2(currentBalance)} reached the $${round2(drawdownFloor)} drawdown floor`,
      profit, progressPct, daysRemaining, daysElapsed, ratePerTradingDay,
      tradingDaysObserved, daysToTargetAtRate, projectionRange, onTrack,
      projectionBlockedBy, daysToActivationDeadline: null,
      urgency: 'lapsed',
      notes: [`Blown on day ${daysElapsed}. Buy a replacement evaluation to reclaim the slot.`],
    };
  }

  // Hitting the target is necessary but not sufficient. Most firms also
  // require a minimum number of trading days, and Phidias Fundamental wants
  // three. Marking an evaluation passed early would start the activation-fee
  // countdown against a pass the firm has not granted.
  const minDays = s.minTradingDays ?? 0;
  const targetReached = s.targetProfit > 0 && profit >= s.targetProfit;
  const daysShort = Math.max(0, minDays - tradingDaysObserved);

  if (targetReached && daysShort > 0) {
    return {
      outcome: 'in_progress', changed: false,
      reason:
        `Target reached, but ${tradingDaysObserved} of ${minDays} required trading days completed`,
      profit, progressPct, daysRemaining, daysElapsed, ratePerTradingDay,
      tradingDaysObserved, daysToTargetAtRate: 0, projectionRange: null,
      onTrack: true, projectionBlockedBy: null,
      daysToActivationDeadline: null,
      urgency: 'watch',
      notes: [
        `Profit target met. ${daysShort} more trading day(s) needed before the firm will pass ` +
        'this evaluation — trade small; the target is banked and the drawdown floor is not.',
      ],
    };
  }

  if (targetReached) {
    const deadline = addDays(today, activationWindowDays);
    return {
      outcome: 'passed', changed: true,
      reason: `Profit $${round2(profit)} reached the $${round2(s.targetProfit)} target`,
      profit, progressPct, daysRemaining, daysElapsed, ratePerTradingDay,
      tradingDaysObserved, daysToTargetAtRate: 0, projectionRange: null,
      onTrack: true, projectionBlockedBy: null,
      daysToActivationDeadline: activationWindowDays,
      urgency: 'watch',
      notes: [
        `Passed on day ${daysElapsed}. Activation fee due by ${deadline} — the window runs from ` +
        `the pass being marked after market close, not from when the target was hit intraday.`,
      ],
    };
  }

  // Expiry last: passing on the final day still counts, and still earns the
  // full activation window.
  if (daysRemaining !== null && daysRemaining < 0) {
    return {
      outcome: 'expired', changed: true,
      reason: `Expired ${Math.abs(daysRemaining)} day(s) ago without reaching target`,
      profit, progressPct, daysRemaining, daysElapsed, ratePerTradingDay,
      tradingDaysObserved, daysToTargetAtRate, projectionRange, onTrack: false,
      projectionBlockedBy, daysToActivationDeadline: null,
      urgency: 'lapsed',
      notes: [`Reached ${progressPct}% of target before the ${daysElapsed}-day window closed.`],
    };
  }

  // ---- still running: how worried should we be? -----------------------
  let urgency: EvalUrgency = 'ok';

  if (onTrack === false && projectionRange) {
    urgency = daysRemaining !== null && daysRemaining <= 7 ? 'critical' : 'watch';
    notes.push(
      `At $${ratePerTradingDay} per trading day this needs roughly ` +
      `${projectionRange.fast}-${projectionRange.slow} more calendar days, against ` +
      `${daysRemaining} remaining. It does not reach target on the current pace.`
    );
  } else if (onTrack === true && projectionRange) {
    notes.push(
      `On pace: roughly ${projectionRange.fast}-${projectionRange.slow} more days needed, ` +
      `${daysRemaining} available.`
    );
  }

  if (projectionBlockedBy === 'insufficient_sample') {
    notes.push(
      `${tradingDaysObserved} trading day(s) so far — too few to project from. A rate drawn ` +
      `from fewer than ${MIN_TRADING_DAYS_TO_PROJECT} days of a three-trade-a-day strategy is noise.`
    );
  } else if (projectionBlockedBy === 'no_progress') {
    urgency = urgency === 'ok' ? 'watch' : urgency;
    notes.push(
      profit < 0
        ? `Down $${round2(Math.abs(profit))} over ${tradingDaysObserved} trading days — nothing to project from.`
        : `Flat over ${tradingDaysObserved} trading days — nothing to project from.`
    );
  }

  if (daysRemaining !== null && daysRemaining <= 3 && progressPct < 100) {
    urgency = 'critical';
    notes.push(`${daysRemaining} day(s) left and ${round2(remainingProfit)} still to make.`);
  }

  return {
    outcome: 'in_progress', changed: false, profit, progressPct,
    daysRemaining, daysElapsed, ratePerTradingDay, tradingDaysObserved,
    daysToTargetAtRate, projectionRange, onTrack, projectionBlockedBy,
    daysToActivationDeadline: null, urgency, notes,
  };
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}

/**
 * The stagger rule: never start two evaluations on the same day.
 *
 * CLAUDE.md sets a 7-day minimum so payouts arrive as a continuous stream
 * rather than all at once. Note the tension a multi-pack creates — every eval
 * in the pack starts its 30-day expiry clock on purchase, so holding one back
 * to stagger it burns days off a window that is already tight. This reports
 * the conflict rather than silently picking a side.
 */
export function staggerWarnings(
  purchaseDates: string[],
  minimumGapDays = 7
): string[] {
  const sorted = [...purchaseDates].sort();
  const warnings: string[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i - 1], sorted[i]);
    if (gap === 0) {
      warnings.push(
        `${countAt(sorted, sorted[i])} evaluations start on ${sorted[i]}. Their expiry clocks and ` +
        `payout cycles will run together, so a bad stretch hits every one at once.`
      );
    } else if (gap < minimumGapDays) {
      warnings.push(
        `Evaluations started ${gap} day(s) apart on ${sorted[i - 1]} and ${sorted[i]}, under the ` +
        `${minimumGapDays}-day stagger target.`
      );
    }
  }
  return [...new Set(warnings)];
}

function countAt(dates: string[], date: string): number {
  return dates.filter((d) => d === date).length;
}
