/**
 * Evaluation Monte Carlo.
 *
 * Answers one question: given a firm's rules and an assumed edge, how often
 * does an evaluation pass, and how long does it take?
 *
 * It reuses the REAL ladder, drawdown and gate logic rather than a simplified
 * copy of it. A simulation that models its own idea of the rules tells you
 * about the simulation. This one advances the same `stepRisk` the executor
 * calls and trails the same `drawdownState` the reconciler reads, so a bug in
 * either shows up here too.
 *
 * WHAT REMOVING THE CLOCK ACTUALLY CHANGES
 *
 * An evaluation with an expiry has three outcomes: pass, blow, expire. Without
 * one it has two. Every eval that would have expired now runs until it either
 * passes or blows, so the pass rate rises — but it converges on the ruin
 * probability, not on 100%, because a trailing floor keeps closing from below
 * whether or not there is a deadline.
 *
 * The cost moves rather than disappearing. With a deadline you lose the fee.
 * Without one you lose the account slot for as long as the eval takes, and the
 * tail is genuinely long: an eval that has drifted sideways for forty days is
 * occupying a slot that a fresh $116 attempt could be using.
 *
 * EVERY NUMBER OUT OF THIS IS A PROJECTION
 *
 * The win rate is the dominant input and it is UNVALIDATED from live trading —
 * CLAUDE.md has said so since the beginning. Nothing here changes that. Run the
 * sensitivity grid rather than quoting a single figure, and treat the spread
 * between win rates as the real answer.
 */

import { stepRisk, nextStep, StepMultipliers, TradeOutcome } from './ladder';
import { drawdownState, DdMode } from './drawdown';
import { dllHeadroom } from './gate';

export interface EvalSimParams {
  startBalance: number;
  targetProfit: number;
  maxDrawdown: number;
  ddMode: DdMode;
  /** Dollars above start where a trailing floor locks. Null = never locks. */
  lockBuffer: number | null;
  dailyLossCap: number;
  baseRisk: number;
  capStep: number;
  multipliers?: StepMultipliers;
  /** Calendar-day expiry, or null for none. */
  expiryDays: number | null;
  /** Trading days the firm requires before it will pass. */
  minTradingDays: number;

  // ---- assumed edge: the part that is not a rule ----
  /** P(trade reaches TP1 at least). */
  winRate: number;
  /**
   * Of winning trades, the share that also reach TP2. The rest close the
   * runner at breakeven after TP1 — the "W~" partial that the ladder still
   * treats as a reset.
   */
  fullWinShare: number;
  /** P(trade scratches at breakeven), taken out of the losing side. */
  breakevenRate: number;
  /** Sessions that actually produce a signal, per trading day. */
  tradesPerDay: number;
  /** Hard ceiling from the strategy: 3 sessions. */
  maxTradesPerDay: number;
}

export interface EvalSimResult {
  runs: number;
  passRate: number;
  /** Drawdown floor actually breached. */
  blowRate: number;
  /**
   * Room fell below the minimum step risk, so no further trade can be placed.
   * The account is not breached but it is finished — with the drawdown gate
   * active this is the dominant failure, not the breach.
   */
  seizedRate: number;
  /** Neither passed nor failed within the horizon. */
  expiredRate: number;
  /** blowRate + seizedRate — every way the eval ends without a pass. */
  failRate: number;
  /** Trading days to pass, over passing runs only. */
  daysToPass: { mean: number; p10: number; p50: number; p90: number };
  /** Trading days survived before blowing, over blowing runs only. */
  daysToBlow: { mean: number; p50: number };
  /** Expected cost per FUNDED account at a given eval price. */
  costPerFunded: (evalCost: number) => number;
}

/** Deterministic RNG so a reported figure can be reproduced exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/**
 * Payoff of one trade in dollars, given the step's risk.
 *
 * Group 1 takes TP1 at 0.5R, group 2 runs to TP2 at 2R with its stop moved to
 * breakeven once TP1 fills. So a full win is 1.25R on the whole position and a
 * partial is 0.25R — not 2R, which is the number that makes projections look
 * better than the strategy is.
 */
function tradePayoff(rng: () => number, risk: number, p: EvalSimParams): { pnl: number; outcome: TradeOutcome } {
  const r = rng();
  if (r < p.winRate) {
    const full = rng() < p.fullWinShare;
    return full
      ? { pnl: risk * 1.25, outcome: 'W' }
      : { pnl: risk * 0.25, outcome: 'W~' };
  }
  if (r < p.winRate + p.breakevenRate) return { pnl: 0, outcome: 'BE' };
  return { pnl: -risk, outcome: 'L' };
}

/** Run the simulation. */
export function simulateEval(p: EvalSimParams, runs = 20_000, seed = 1): EvalSimResult {
  const rng = mulberry32(seed);
  let passed = 0;
  let blown = 0;
  let seized = 0;
  let expired = 0;
  const passDays: number[] = [];
  const blowDays: number[] = [];

  const TRADING_DAYS_PER_CALENDAR = 5 / 7;
  const maxTradingDays = p.expiryDays === null
    ? 500 // a practical ceiling; runs reaching it are counted as still open
    : Math.floor(p.expiryDays * TRADING_DAYS_PER_CALENDAR);

  for (let run = 0; run < runs; run++) {
    let balance = p.startBalance;
    let step = 1;
    let day = 0;
    // End-of-day balances drive the trailing floor, exactly as in production.
    let highWaterEod = p.startBalance;
    let outcome: 'pass' | 'blow' | 'seized' | 'open' = 'open';

    while (day < maxTradingDays) {
      day++;
      let dayPnl = 0;
      const tradesToday = Math.min(
        p.maxTradesPerDay,
        // Fractional trades/day resolved probabilistically rather than rounded,
        // so 1.4 means "1 trade, sometimes 2" instead of always 1.
        Math.floor(p.tradesPerDay) + (rng() < p.tradesPerDay % 1 ? 1 : 0)
      );

      for (let t = 0; t < tradesToday; t++) {
        const risk = stepRisk(p.baseRisk, step, {
          capStep: p.capStep,
          multipliers: p.multipliers,
          dailyLossCap: p.dailyLossCap,
        });

        // Same two gates the executor applies, in the same order.
        if (risk > dllHeadroom(p.dailyLossCap, dayPnl)) break;

        const dd = drawdownState({
          ddMode: p.ddMode,
          startBalance: p.startBalance,
          maxDrawdown: p.maxDrawdown,
          lockBuffer: p.lockBuffer,
          eodBalances: [highWaterEod],
          currentEquity: balance,
        });
        if (risk > dd.room) break;

        const { pnl, outcome: o } = tradePayoff(rng, risk, p);
        balance += pnl;
        dayPnl += pnl;
        step = nextStep(step, o);

        if (balance - p.startBalance >= p.targetProfit && day >= p.minTradingDays) {
          outcome = 'pass';
          break;
        }
      }

      if (outcome === 'pass') break;

      // The floor only moves on a day's close, and only upward.
      if (balance > highWaterEod) highWaterEod = balance;

      const eod = drawdownState({
        ddMode: p.ddMode,
        startBalance: p.startBalance,
        maxDrawdown: p.maxDrawdown,
        lockBuffer: p.lockBuffer,
        eodBalances: [highWaterEod],
        currentEquity: balance,
      });

      // Two ways to die, and the second is the one that actually happens.
      //
      // A literal breach (room <= 0) is rare precisely BECAUSE the drawdown
      // gate refuses any trade larger than the remaining room. What the gate
      // produces instead is a seized account: room falls below the smallest
      // step risk, every subsequent signal is declined, and the account can
      // never trade its way back. It is not breached, it is simply finished —
      // and counting it as "still open" would report a dead account as alive.
      if (eod.room <= 0) { outcome = 'blow'; break; }
      const minRisk = stepRisk(p.baseRisk, 1, {
        capStep: p.capStep, multipliers: p.multipliers, dailyLossCap: p.dailyLossCap,
      });
      if (eod.room < minRisk) { outcome = 'seized'; break; }
    }

    if (outcome === 'pass') { passed++; passDays.push(day); }
    else if (outcome === 'blow') { blown++; blowDays.push(day); }
    else if (outcome === 'seized') { seized++; blowDays.push(day); }
    else expired++;
  }

  passDays.sort((a, b) => a - b);
  blowDays.sort((a, b) => a - b);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const passRate = passed / runs;

  return {
    runs,
    passRate,
    blowRate: blown / runs,
    seizedRate: seized / runs,
    expiredRate: expired / runs,
    failRate: (blown + seized) / runs,
    daysToPass: {
      mean: Number(mean(passDays).toFixed(1)),
      p10: pct(passDays, 10), p50: pct(passDays, 50), p90: pct(passDays, 90),
    },
    daysToBlow: { mean: Number(mean(blowDays).toFixed(1)), p50: pct(blowDays, 50) },
    costPerFunded: (evalCost: number) =>
      passRate > 0 ? Number((evalCost / passRate).toFixed(2)) : Infinity,
  };
}
