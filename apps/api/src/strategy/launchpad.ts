/**
 * LaunchPad — the payout lifecycle of a funded account.
 *
 * The execution engine answers "should this trade fire?". This answers the
 * question that actually pays: "can this account request money yet, and if
 * not, what is missing?"
 *
 * Apex's EOD Performance Account gates a payout on four independent things,
 * and an account can sit blocked on any one of them while looking healthy on
 * the others:
 *
 *   1. QUALIFYING DAYS — 5 days that each cleared a minimum daily profit.
 *      A day that made money but not enough does not count at all. Neither
 *      does a losing day. There is no deadline; the count simply accrues.
 *
 *   2. SAFETY NET — the balance floor (start + drawdown + $100). Only profit
 *      ABOVE it is eligible, so the minimum balance to request is
 *      safety net + minimum payout.
 *
 *   3. CONSISTENCY — no single day may be 50% or more of profit since the
 *      last approved payout. This is the one that surprises people: a great
 *      day can push you FURTHER from a payout by dominating the total.
 *
 *   4. PAYOUT NUMBER — each payout has its own capped amount, and the account
 *      closes after the sixth.
 *
 * Pure: no db, no io, no clock. Dates are supplied by the caller.
 */

export interface DailyPnl {
  /** Broker day, YYYY-MM-DD. */
  dayKey: string;
  pnl: number;
}

export interface PayoutRules {
  /** Minimum net profit for a day to count toward the qualifying-day total. */
  qualifyingDayThreshold: number;
  /** How many qualifying days a request needs. */
  requiredQualifyingDays: number;
  /** Balance floor: start + drawdown + buffer. Only profit above it is eligible. */
  safetyNetBalance: number;
  /** Smallest amount the firm will process. */
  minPayout: number;
  /** e.g. 50 => no single day may be >= 50% of profit since the last payout. */
  consistencyPct: number;
  /**
   * Per-payout caps, in order. Length is the maximum number of payouts UNLESS
   * `payoutScheduleRepeats` is set.
   */
  payoutSchedule: number[];
  /**
   * True when the schedule is a repeating cycle rather than a finite list.
   *
   * Apex is finite: six payouts totalling $13,000 and the Performance Account
   * closes. Phidias is not — the $2,000 cap is per cycle and the CASH account
   * keeps going, with their rules stating plainly that "there is no financial
   * penalty for staying simulated". Treating an unbounded schedule as a
   * six-entry list would stop reporting payouts on an account that is still
   * paying them.
   */
  payoutScheduleRepeats?: boolean;
  /**
   * Trader's share by payout number, e.g. [0.75, 0.8, 0.85, 0.9, 1.0]. The
   * LAST entry persists for every later payout — Phidias Premium keeps 100%
   * from the fifth onward. Null/empty means the flat `profitSplit`.
   */
  splitSchedule?: number[] | null;
  /** Flat trader's share, used when there is no schedule. 1.0 = 100%. */
  profitSplit?: number;
}

/**
 * Trader's share of payout number `n` (1-based).
 *
 * A progressive split is a schedule that runs out, not one that resets: past
 * its end the final rate continues forever. Reading it as "unspecified" past
 * the last entry would silently drop a Premium account back to 75% at exactly
 * the point it starts keeping everything.
 */
export function splitForPayout(
  payoutNumber: number,
  splitSchedule: number[] | null | undefined,
  flatSplit = 1
): number {
  if (!splitSchedule || splitSchedule.length === 0) return flatSplit;
  if (payoutNumber < 1) return splitSchedule[0];
  return splitSchedule[Math.min(payoutNumber, splitSchedule.length) - 1];
}

/** Gross cap for payout `n`, or null when the schedule is finite and spent. */
export function scheduledAmountFor(
  payoutNumber: number,
  schedule: number[],
  repeats = false
): number | null {
  if (schedule.length === 0 || payoutNumber < 1) return null;
  if (payoutNumber <= schedule.length) return schedule[payoutNumber - 1];
  if (!repeats) return null;
  // Past the end of a repeating cycle, the last entry is the standing cap.
  return schedule[schedule.length - 1];
}

export interface ConsistencyStatus {
  /** Largest single profitable day in the window. */
  largestDay: number;
  /** Net profit across the window. */
  totalProfit: number;
  /** largestDay / totalProfit, or null when there is no profit yet. */
  ratio: number | null;
  ok: boolean;
  /** Total profit needed before the largest day stops dominating. */
  minTotalRequired: number;
  /** Additional profit still needed. 0 when already compliant. */
  shortfall: number;
}

/**
 * Whether the largest day dominates the window.
 *
 * Losing days count toward the net total, so a loss makes consistency HARDER,
 * not easier — it shrinks the denominator while the best day stays put.
 */
export function consistencyStatus(days: DailyPnl[], consistencyPct: number): ConsistencyStatus {
  const frac = consistencyPct > 0 ? consistencyPct / 100 : 0;
  const totalProfit = Number(days.reduce((s, d) => s + d.pnl, 0).toFixed(2));
  const largestDay = days.reduce((m, d) => (d.pnl > m ? d.pnl : m), 0);

  if (frac === 0) {
    return { largestDay, totalProfit, ratio: null, ok: true, minTotalRequired: 0, shortfall: 0 };
  }
  if (largestDay <= 0) {
    // No profitable day yet: nothing can dominate.
    return { largestDay: 0, totalProfit, ratio: null, ok: true, minTotalRequired: 0, shortfall: 0 };
  }

  const minTotalRequired = Number((largestDay / frac).toFixed(2));
  const ratio = totalProfit > 0 ? Number((largestDay / totalProfit).toFixed(4)) : null;
  const ok = totalProfit >= minTotalRequired;

  return {
    largestDay,
    totalProfit,
    ratio,
    ok,
    minTotalRequired,
    shortfall: ok ? 0 : Number((minTotalRequired - totalProfit).toFixed(2)),
  };
}

/** Days that cleared the minimum daily profit. */
export function qualifyingDays(days: DailyPnl[], threshold: number): DailyPnl[] {
  return days.filter((d) => d.pnl >= threshold);
}

export type BlockReason =
  | 'insufficient_qualifying_days'
  | 'below_safety_net'
  | 'consistency'
  | 'all_payouts_taken';

export interface PayoutBlocker {
  reason: BlockReason;
  message: string;
  /** How much more is needed, where that is a number. */
  shortfall?: number;
}

export interface PayoutEligibility {
  eligible: boolean;
  /** 1-based number of the payout this would be. null once all are taken. */
  payoutNumber: number | null;
  /** Cap for that payout number. */
  scheduledAmount: number | null;
  /** What can actually be requested: min(profit above safety net, scheduled cap). */
  requestableAmount: number;
  /** Trader's share of THIS payout, 1.0 = 100%. Null once all are taken. */
  splitPct: number | null;
  /** requestableAmount after the split — what actually arrives. */
  netAmount: number;
  qualifyingDayCount: number;
  daysStillNeeded: number;
  consistency: ConsistencyStatus;
  /** Every unmet requirement, not just the first — they are independent. */
  blockers: PayoutBlocker[];
  /** True on the final payout: the account closes after it is approved. */
  isFinalPayout: boolean;
}

export interface EligibilityInput {
  /** Daily P&L since the last approved payout (or account inception). */
  daysSinceLastPayout: DailyPnl[];
  currentBalance: number;
  payoutsAlreadyTaken: number;
  rules: PayoutRules;
}

/**
 * Can this account request a payout?
 *
 * Reports EVERY unmet requirement rather than stopping at the first. They are
 * independent, and an operator deciding whether to keep trading an account
 * needs the whole picture — being told only about qualifying days, then only
 * about consistency a week later, is how a payout slips a fortnight.
 */
export function payoutEligibility(input: EligibilityInput): PayoutEligibility {
  const { daysSinceLastPayout, currentBalance, payoutsAlreadyTaken, rules } = input;
  const blockers: PayoutBlocker[] = [];

  const qualifying = qualifyingDays(daysSinceLastPayout, rules.qualifyingDayThreshold);
  const qualifyingDayCount = qualifying.length;
  const daysStillNeeded = Math.max(0, rules.requiredQualifyingDays - qualifyingDayCount);

  const consistency = consistencyStatus(daysSinceLastPayout, rules.consistencyPct);

  const repeats = rules.payoutScheduleRepeats === true;
  const maxPayouts = rules.payoutSchedule.length;
  const allTaken = !repeats && payoutsAlreadyTaken >= maxPayouts;
  const payoutNumber = allTaken ? null : payoutsAlreadyTaken + 1;
  const scheduledAmount = payoutNumber
    ? scheduledAmountFor(payoutNumber, rules.payoutSchedule, repeats)
    : null;
  const splitPct = payoutNumber
    ? splitForPayout(payoutNumber, rules.splitSchedule, rules.profitSplit ?? 1)
    : null;

  // Only profit above the safety net can be withdrawn.
  const eligibleProfit = Number((currentBalance - rules.safetyNetBalance).toFixed(2));
  const minBalanceToRequest = rules.safetyNetBalance + rules.minPayout;

  if (allTaken) {
    blockers.push({
      reason: 'all_payouts_taken',
      message:
        `All ${maxPayouts} payouts have been taken. The Performance Account closes at this ` +
        `point; a new evaluation is needed to obtain another.`,
    });
  }

  if (daysStillNeeded > 0) {
    blockers.push({
      reason: 'insufficient_qualifying_days',
      message:
        `${qualifyingDayCount} of ${rules.requiredQualifyingDays} qualifying days. A day counts ` +
        `only if it nets at least $${rules.qualifyingDayThreshold} — a small green day does not.`,
      shortfall: daysStillNeeded,
    });
  }

  if (currentBalance < minBalanceToRequest) {
    blockers.push({
      reason: 'below_safety_net',
      message:
        `Balance $${round2(currentBalance)} is below the $${round2(minBalanceToRequest)} needed ` +
        `to request (safety net $${round2(rules.safetyNetBalance)} plus the $${rules.minPayout} minimum).`,
      shortfall: Number((minBalanceToRequest - currentBalance).toFixed(2)),
    });
  }

  if (!consistency.ok) {
    blockers.push({
      reason: 'consistency',
      message:
        `Best day $${round2(consistency.largestDay)} is ` +
        `${consistency.ratio !== null ? `${Math.round(consistency.ratio * 100)}%` : 'all'} of ` +
        `$${round2(consistency.totalProfit)} total, over the ${rules.consistencyPct}% limit. ` +
        `Another $${round2(consistency.shortfall)} of profit dilutes it.`,
      shortfall: consistency.shortfall,
    });
  }

  const eligible = blockers.length === 0;
  const requestableAmount =
    eligible && scheduledAmount !== null
      ? Number(Math.min(eligibleProfit, scheduledAmount).toFixed(2))
      : 0;
  // What actually lands in the trader's account. The split applies to the
  // amount withdrawn, so this is the only figure worth planning against.
  const netAmount = Number((requestableAmount * (splitPct ?? 1)).toFixed(2));

  return {
    eligible,
    payoutNumber,
    scheduledAmount,
    requestableAmount,
    splitPct,
    netAmount,
    qualifyingDayCount,
    daysStillNeeded,
    consistency,
    blockers,
    // A repeating schedule has no final payout — the account does not close.
    isFinalPayout: !repeats && payoutNumber !== null && payoutNumber === maxPayouts,
  };
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}

/** Apex EOD PA payout schedules by account size. Total per cycle in the comment. */
export const APEX_EOD_PAYOUT_SCHEDULES: Record<number, number[]> = {
  25000: [1000, 1000, 1000, 1000, 1000, 1000],          // $6,000
  50000: [1500, 1500, 2000, 2500, 2500, 3000],          // $13,000
  100000: [2000, 2500, 2500, 3000, 4000, 4000],         // $18,000
  150000: [2500, 3000, 3000, 3000, 4000, 5000],         // $20,500
};

/** Minimum daily profit for a day to qualify, by account size. */
export const APEX_EOD_QUALIFYING_THRESHOLDS: Record<number, number> = {
  25000: 100,
  50000: 250,
  100000: 300,
  150000: 350,
};
