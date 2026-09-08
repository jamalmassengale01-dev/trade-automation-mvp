/**
 * Rule reconciliation.
 *
 * A preset is a set of *assumptions* about an account: how big it is, what the
 * daily loss cap is, how much drawdown room exists. The executor sizes every
 * trade from those assumptions. If any of them is wrong — a 50K preset assigned
 * to a 100K account, our day-P&L counter drifting from the broker's — the DLL
 * gate is computing headroom from fiction and will happily size a trade that
 * breaches the account.
 *
 * This module compares the assumptions against what the broker actually
 * reports and decides whether trading should continue.
 *
 * WHAT CAN AND CANNOT BE VERIFIED
 *
 * Tradovate exposes balance, equity, and realized P&L. Those are ground truth
 * and are checked here.
 *
 * It does NOT expose the prop firm's daily loss limit or trailing drawdown —
 * those are enforced firm-side (Apex, Tradeify, MFFU), not by the broker, and
 * there is no API for them. Claiming to verify them automatically would be a
 * lie. Instead they carry a `verifiedAt` stamp set by a human against the
 * firm's rules page, and this module reports how stale that is. Staleness never
 * halts trading on its own — it is surfaced loudly, but a technicality about a
 * confirmation date should not flatten a fleet.
 *
 * Pure: no db, no io, no clock. `now` is injected.
 */

export type Verdict = 'ok' | 'warn' | 'halt';

export interface BrokerSnapshot {
  /** Broker cash balance. */
  cashBalance: number;
  /** Broker-reported realized P&L for the current broker day. */
  realizedPnl: number;
  /** Cash + realized + open. */
  equity: number;
}

/** What EdgePilot currently believes about the account. */
export interface TrackedState {
  dayRealizedPnl: number;
  cumulativePnl: number;
  ladderStep: number;
}

export interface PresetAssumptions {
  id: string;
  /** Days idle before the firm's inactivity policy puts the account at risk. 0 disables. */
  inactivityAlertDays?: number;
  startBalance: number;
  maxDrawdown: number;
  dailyLossCap: number;
  phase: 'eval' | 'funded';
  /** Null means no human has ever confirmed these numbers. */
  verifiedAt: Date | null;
  staleAfterDays: number;
}

export interface ReconcileFinding {
  id: string;
  severity: 'halt' | 'warn' | 'info';
  message: string;
  /** Numbers behind the finding, for the risk event payload. */
  detail?: Record<string, number | string | null>;
}

export interface ReconcileResult {
  verdict: Verdict;
  findings: ReconcileFinding[];
  /** equity - cumulativePnl: what the account size must have been. */
  impliedStart: number;
}

export interface ReconcileInput {
  snapshot: BrokerSnapshot;
  tracked: TrackedState;
  preset: PresetAssumptions;
  now: Date;
  /**
   * Days since this account last placed a trade. null means it has never
   * traded, in which case pass its age instead — a funded account that has sat
   * untouched since activation is the case most at risk.
   */
  daysSinceLastTrade?: number | null;
  /** Days since the account row was created, used when it has never traded. */
  accountAgeDays?: number | null;
  /** Overrides for the comparison thresholds. */
  tolerances?: Partial<Tolerances>;
}

export interface Tolerances {
  /** Absolute $ drift in day P&L before warning. */
  dayPnlWarn: number;
  /** Absolute $ drift in day P&L before halting. Gate input — kept tight. */
  dayPnlHalt: number;
  /** Fraction of startBalance the implied start may drift before warning. */
  impliedStartWarnPct: number;
  /**
   * Ratio bounds on balance/startBalance outside which the preset is wrong.
   *
   * Kept well inside 2x and 0.5x on purpose: the likeliest misassignment is an
   * adjacent account size (50K preset on a 100K account and vice versa), which
   * lands exactly ON those factors. Bounds of 0.5/2.0 would let the most
   * common real mistake slip through the boundary comparison. A legitimate
   * account never strays this far — a 50K eval lives between roughly $48,000
   * (blown) and $55,000 (passed), a ratio of 0.96 to 1.10.
   */
  sizeRatioLow: number;
  sizeRatioHigh: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  dayPnlWarn: 5,
  dayPnlHalt: 50,
  impliedStartWarnPct: 0.02,
  sizeRatioLow: 0.7,
  sizeRatioHigh: 1.5,
};

const DAY_MS = 86_400_000;

function round2(v: number): number {
  return Number(v.toFixed(2));
}

function worst(a: Verdict, b: Verdict): Verdict {
  const rank = { ok: 0, warn: 1, halt: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Compare preset assumptions against broker truth.
 *
 * Returns 'halt' only for conditions where continuing to trade would size from
 * numbers known to be wrong, or where the account is already breached.
 */
export function reconcileRules(input: ReconcileInput): ReconcileResult {
  const { snapshot, tracked, preset, now } = input;
  const tol = { ...DEFAULT_TOLERANCES, ...input.tolerances };
  const findings: ReconcileFinding[] = [];
  let verdict: Verdict = 'ok';

  const add = (f: ReconcileFinding) => {
    findings.push(f);
    if (f.severity === 'halt') verdict = worst(verdict, 'halt');
    else if (f.severity === 'warn') verdict = worst(verdict, 'warn');
  };

  // ---- 1. Wrong preset assigned -------------------------------------
  // The loudest, most damaging misconfiguration: a 50K preset on a 100K
  // account (under-sizes, harmless) or a 100K preset on a 50K account
  // (over-sizes by 2x and breaches the DLL on the first loss).
  const ratio = preset.startBalance > 0 ? snapshot.cashBalance / preset.startBalance : 0;
  if (ratio < tol.sizeRatioLow || ratio > tol.sizeRatioHigh) {
    add({
      id: 'preset_size_mismatch',
      severity: 'halt',
      message:
        `Account balance $${round2(snapshot.cashBalance)} is ${round2(ratio)}x the preset's ` +
        `$${preset.startBalance} account size. The wrong preset is almost certainly assigned — ` +
        `every trade would be sized from the wrong base risk.`,
      detail: { balance: round2(snapshot.cashBalance), presetStart: preset.startBalance, ratio: round2(ratio) },
    });
  }

  // ---- 2. Day P&L drift ---------------------------------------------
  // This value IS the DLL gate's input. If it disagrees with the broker, the
  // gate is computing headroom from a number that does not exist.
  const dayDrift = Math.abs(tracked.dayRealizedPnl - snapshot.realizedPnl);
  if (dayDrift > tol.dayPnlHalt) {
    add({
      id: 'day_pnl_drift_halt',
      severity: 'halt',
      message:
        `Tracked day P&L $${round2(tracked.dayRealizedPnl)} differs from the broker's ` +
        `$${round2(snapshot.realizedPnl)} by $${round2(dayDrift)}. The daily-loss gate is sizing ` +
        `from a stale number — most likely a missed fill or a broker-day boundary error.`,
      detail: { tracked: round2(tracked.dayRealizedPnl), broker: round2(snapshot.realizedPnl), drift: round2(dayDrift) },
    });
  } else if (dayDrift > tol.dayPnlWarn) {
    add({
      id: 'day_pnl_drift',
      severity: 'warn',
      message:
        `Tracked day P&L is $${round2(dayDrift)} off the broker's figure. Within tolerance, but ` +
        `worth watching — commissions and partial fills both show up here.`,
      detail: { tracked: round2(tracked.dayRealizedPnl), broker: round2(snapshot.realizedPnl), drift: round2(dayDrift) },
    });
  }

  // ---- 3. Cumulative tracking drift ----------------------------------
  // cumulativePnl drives Sniper Mode and payout progress. Back out the account
  // size it implies and compare with the preset.
  const impliedStart = round2(snapshot.equity - tracked.cumulativePnl);
  const startDrift = Math.abs(impliedStart - preset.startBalance);
  const startDriftPct = preset.startBalance > 0 ? startDrift / preset.startBalance : 0;
  if (startDriftPct > tol.impliedStartWarnPct) {
    add({
      id: 'cumulative_pnl_drift',
      severity: 'warn',
      message:
        `Equity minus tracked cumulative P&L implies a $${impliedStart} account, but the preset ` +
        `says $${preset.startBalance}. Sniper Mode and payout progress are computed from ` +
        `cumulative P&L, so both are off by roughly $${round2(startDrift)}.`,
      detail: { impliedStart, presetStart: preset.startBalance, drift: round2(startDrift) },
    });
  }

  // ---- 4. Drawdown already breached ----------------------------------
  const ddFloor = round2(preset.startBalance - preset.maxDrawdown);
  if (snapshot.equity <= ddFloor) {
    add({
      id: 'drawdown_breached',
      severity: 'halt',
      message:
        `Equity $${round2(snapshot.equity)} is at or below the $${ddFloor} drawdown floor ` +
        `($${preset.startBalance} - $${preset.maxDrawdown}). The account is blown; stop trading it.`,
      detail: { equity: round2(snapshot.equity), floor: ddFloor },
    });
  } else if (snapshot.equity - ddFloor < preset.dailyLossCap) {
    add({
      id: 'drawdown_within_one_day',
      severity: 'warn',
      message:
        `Only $${round2(snapshot.equity - ddFloor)} of drawdown room left, less than one full ` +
        `daily loss cap ($${preset.dailyLossCap}). A single bad day ends the account.`,
      detail: { room: round2(snapshot.equity - ddFloor), dailyLossCap: preset.dailyLossCap },
    });
  }

  // ---- 5. Inactivity ---------------------------------------------------
  // Warn, never halt. The remedy for an idle account is to trade it; blocking
  // trades would guarantee the outcome the policy threatens. This is also the
  // one failure that produces no error anywhere — an expired TradingView alert
  // just stops sending, and nothing looks wrong except an absence of trades.
  const inactivityDays = preset.inactivityAlertDays ?? 0;
  if (inactivityDays > 0) {
    // Never traded (null) falls back to account age; unknown (undefined) skips.
    const neverTraded = input.daysSinceLastTrade === null;
    const idle = neverTraded
      ? input.accountAgeDays ?? null
      : input.daysSinceLastTrade ?? null;

    if (idle !== null && idle > inactivityDays) {
      add({
        id: neverTraded ? 'never_traded' : 'account_inactive',
        severity: 'warn',
        message: neverTraded
          ? `This account has never placed a trade in ${idle} day(s). The firm's inactivity ` +
            `policy can close an idle account — check the strategy is mapped and its alerts are live.`
          : `No trade in ${idle} day(s), past the ${inactivityDays}-day inactivity threshold. ` +
            `An expired alert or a disconnected webhook produces exactly this: no errors, just ` +
            `silence. The firm's inactivity policy can close the account.`,
        detail: { idleDays: idle, thresholdDays: inactivityDays, neverTraded: String(neverTraded) },
      });
    }
  }

  // ---- 6. Preset verification age ------------------------------------
  // Never a halt: an expired confirmation date is not evidence the rules
  // changed, and halting on it would flatten a fleet over paperwork.
  if (preset.verifiedAt === null) {
    add({
      id: 'preset_never_verified',
      severity: 'warn',
      message:
        `Preset "${preset.id}" has never been confirmed against the firm's published rules. ` +
        `The daily loss cap and drawdown cannot be read from the broker API — verify them by hand.`,
      detail: { presetId: preset.id, verifiedAt: null },
    });
  } else {
    const ageDays = Math.floor((now.getTime() - preset.verifiedAt.getTime()) / DAY_MS);
    if (ageDays > preset.staleAfterDays) {
      add({
        id: 'preset_stale',
        severity: 'warn',
        message:
          `Preset "${preset.id}" was last verified ${ageDays} days ago (stale after ` +
          `${preset.staleAfterDays}). Prop firms change targets and drawdown terms without notice — ` +
          `re-check the rules page.`,
        detail: { presetId: preset.id, ageDays, staleAfterDays: preset.staleAfterDays },
      });
    }
  }

  return { verdict, findings, impliedStart };
}

/**
 * Whether a persisted check should block a new trade.
 *
 * Deliberately fails OPEN when no recent check exists: a dead reconciliation
 * job or a broker outage should not silently stop a working fleet. It fails
 * CLOSED on an actual halt verdict, because that means we have positive
 * evidence the sizing inputs are wrong.
 */
export function shouldBlockTrade(check: {
  verdict: Verdict | null;
  checkedAt: Date | null;
} | null): { blocked: boolean; reason?: string } {
  if (!check || check.verdict === null) return { blocked: false };
  if (check.verdict === 'halt') {
    return { blocked: true, reason: 'rule_reconciliation_halt' };
  }
  return { blocked: false };
}
