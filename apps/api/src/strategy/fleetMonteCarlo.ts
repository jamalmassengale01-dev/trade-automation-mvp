/**
 * Fleet simulation — does account rotation change anything?
 *
 * `evalMonteCarlo` answers "will ONE evaluation pass". That is the wrong
 * question for a fleet, because the accounts are not independent: they trade
 * the same signals on the same days. Twenty accounts copy-trading one strategy
 * is not twenty bets, it is one bet at twenty times the stake.
 *
 * That is the claim the "revolving door" framework rests on, and it is
 * testable. The mechanism it proposes is that keeping only some accounts
 * active at a time breaks the correlation: each account experiences a
 * DIFFERENT SEGMENT of the same return path, so a losing stretch kills the
 * accounts that were online for it rather than all of them.
 *
 * Whether that changes the expected outcome rather than merely the variance
 * depends on the payoff being non-linear — and it is, because an account has a
 * pass threshold and a death threshold. Sampling the same path differently can
 * therefore change the mean, not just its spread. Hence a simulation rather
 * than an argument.
 *
 * WHAT IS MODELLED HONESTLY
 *
 *   - One shared signal stream. Every active account sees the same trade
 *     outcomes on the same day. This is the whole point; drawing independent
 *     outcomes per account would simulate a decorrelated fleet that does not
 *     exist and would make rotation look pointless by construction.
 *   - The real gates: `stepRisk`, `dllHeadroom`, `drawdownState`, the same
 *     calls the executor makes, via the same modules.
 *   - Accounts differ in ladder step, so identical signals still produce
 *     different position sizes and therefore different balances.
 *   - Cash is tracked both ways: evaluation fees out, payouts in.
 *
 * WHAT IS SIMPLIFIED, AND SAID SO
 *
 *   - Qualifying days and the consistency rule are not modelled. Both DELAY
 *     payouts, so this simulation is optimistic about how fast cash comes out.
 *   - A funded account that dies is replaced by a fresh evaluation, with no
 *     activation delay.
 *   - Trade outcomes are drawn from the assumed edge, which for this strategy
 *     has been measured at zero. Everything here inherits that assumption.
 */
import { stepRisk, nextStep, StepMultipliers } from './ladder';
import { dllHeadroom } from './gate';
import { drawdownState, DdMode } from './drawdown';

export interface FleetParams {
  // ---- the firm's rules ----
  startBalance: number;
  targetProfit: number;
  maxDrawdown: number;
  ddMode: DdMode;
  lockBuffer: number | null;
  dailyLossCap: number;
  baseRisk: number;
  capStep: number;
  multipliers?: StepMultipliers;
  /** Evaluation expiry in calendar days, or null for none. */
  expiryDays: number | null;
  minTradingDays: number;
  /** What one evaluation costs. The variable the whole model is sensitive to. */
  evalPrice: number;
  /**
   * Dollars above start that cannot be withdrawn. On Apex this is the $2,000
   * drawdown plus a $100 buffer — and it is why "take a payout at 3%" does not
   * work there: 3% of 50K is $1,500, which never clears a $2,100 floor.
   */
  safetyNet: number;
  /** Smallest withdrawal the firm will process. */
  minPayout: number;

  // ---- the fleet policy: the part being tested ----
  /** Total account slots owned. */
  slots: number;
  /** Calendar days between starting each slot. */
  staggerDays: number;
  /**
   * How many slots trade on any given day. Equal to `slots` reproduces
   * copy-trading — every account takes every signal, which is what
   * `gbLiveExecutor` does today. Fewer means rotation.
   */
  activeSlots: number;
  /**
   * Abandon a funded account once it is this far below its start, and buy a
   * fresh evaluation instead of grinding back. Null disables the rule.
   * The framework calls this "binning"; -6% is its suggested figure.
   */
  binAtPct: number | null;

  // ---- the assumed edge ----
  winRate: number;
  fullWinShare: number;
  breakevenRate: number;
  tradesPerDay: number;
  maxTradesPerDay: number;
}

export interface FleetResult {
  runs: number;
  horizonDays: number;
  /** Mean dollars spent on evaluations per run. */
  spent: number;
  /** Mean dollars withdrawn per run. */
  extracted: number;
  /** extracted - spent. The number that decides whether any of this works. */
  net: number;
  /** Share of runs ending with more cash than they started. */
  profitableRuns: number;
  /** Mean evaluations bought, and how many of them passed. */
  evalsBought: number;
  evalsPassed: number;
  /** Mean payouts taken. */
  payouts: number;
  /** Net at the 10th / 50th / 90th percentile across runs. */
  netPercentiles: { p10: number; p50: number; p90: number };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = 'W' | 'W~' | 'BE' | 'L';

/**
 * One trade's outcome, drawn ONCE per day per trade slot and shared by every
 * active account. The R multiple is what is shared; the dollar result is not,
 * because each account sizes from its own ladder step.
 */
function drawOutcome(rng: () => number, p: FleetParams): { outcome: Outcome; r: number } {
  if (rng() < p.winRate) {
    const full = rng() < p.fullWinShare;
    // TP1 at 0.5R on half the position, TP2 at 2R on the runner, matching
    // `sizing.ts`. A partial win closes the runner at breakeven.
    return full ? { outcome: 'W', r: 1.25 } : { outcome: 'W~', r: 0.25 };
  }
  if (rng() < p.breakevenRate) return { outcome: 'BE', r: 0 };
  return { outcome: 'L', r: -1 };
}

interface Account {
  /** null while the slot is waiting for its staggered start. */
  state: 'pending' | 'eval' | 'funded' | null;
  startsOnDay: number;
  balance: number;
  step: number;
  highWaterEod: number;
  daysAlive: number;
}

export function simulateFleet(p: FleetParams, horizonDays = 250, runs = 2_000, seed = 1): FleetResult {
  const rng = mulberry32(seed);
  const TRADING_PER_CALENDAR = 5 / 7;
  const evalMaxDays = p.expiryDays === null
    ? Number.POSITIVE_INFINITY
    : Math.floor(p.expiryDays * TRADING_PER_CALENDAR);

  const nets: number[] = [];
  let totSpent = 0, totExtracted = 0, totEvals = 0, totPassed = 0, totPayouts = 0, profitable = 0;

  for (let run = 0; run < runs; run++) {
    let spent = 0, extracted = 0, evalsBought = 0, evalsPassed = 0, payouts = 0;

    const fresh = (startsOnDay: number): Account => ({
      state: 'pending', startsOnDay, balance: p.startBalance,
      step: 1, highWaterEod: p.startBalance, daysAlive: 0,
    });

    const accounts: Account[] = Array.from({ length: p.slots }, (_, i) =>
      fresh(Math.floor(i * p.staggerDays * TRADING_PER_CALENDAR)));

    for (let day = 0; day < horizonDays; day++) {
      // Today's signals, drawn once and shared. This is the correlation.
      const nTrades = Math.min(
        p.maxTradesPerDay,
        Math.floor(p.tradesPerDay) + (rng() < p.tradesPerDay % 1 ? 1 : 0),
      );
      const signals = Array.from({ length: nTrades }, () => drawOutcome(rng, p));

      // Bring slots online as their staggered start arrives.
      for (const a of accounts) {
        if (a.state === 'pending' && day >= a.startsOnDay) {
          a.state = 'eval';
          spent += p.evalPrice;
          evalsBought++;
        }
      }

      // Rotation: which accounts trade today. Rotating the window by day means
      // each account sees a different SEGMENT of the same return path, which is
      // the entire mechanism being tested.
      const live = accounts.filter((a) => a.state === 'eval' || a.state === 'funded');
      const activeToday = new Set<Account>();
      if (p.activeSlots >= live.length) {
        live.forEach((a) => activeToday.add(a));
      } else {
        for (let k = 0; k < p.activeSlots; k++) {
          activeToday.add(live[(day + k) % live.length]);
        }
      }

      for (const a of accounts) {
        if (a.state !== 'eval' && a.state !== 'funded') continue;
        a.daysAlive++;
        if (!activeToday.has(a)) continue;

        let dayPnl = 0;
        for (const sig of signals) {
          const risk = stepRisk(p.baseRisk, a.step, {
            capStep: p.capStep, multipliers: p.multipliers, dailyLossCap: p.dailyLossCap,
          });
          if (risk > dllHeadroom(p.dailyLossCap, dayPnl)) break;

          const dd = drawdownState({
            ddMode: p.ddMode, startBalance: p.startBalance, maxDrawdown: p.maxDrawdown,
            lockBuffer: p.lockBuffer, eodBalances: [a.highWaterEod], currentEquity: a.balance,
          });
          if (risk > dd.room) break;

          const pnl = risk * sig.r;
          a.balance += pnl;
          dayPnl += pnl;
          a.step = nextStep(a.step, sig.outcome, p.capStep);

          if (a.state === 'eval' && a.balance - p.startBalance >= p.targetProfit
              && a.daysAlive >= p.minTradingDays) {
            a.state = 'funded';
            evalsPassed++;
            // A passed evaluation resets to a fresh funded account.
            a.balance = p.startBalance;
            a.highWaterEod = p.startBalance;
            a.step = 1;
            a.daysAlive = 0;
            break;
          }
        }

        if (a.balance > a.highWaterEod) a.highWaterEod = a.balance;

        // Withdraw whatever is above the safety net, once it clears the
        // minimum. This is where the framework's "take it early" lives.
        if (a.state === 'funded') {
          const eligible = a.balance - p.startBalance - p.safetyNet;
          if (eligible >= p.minPayout) {
            extracted += eligible;
            a.balance -= eligible;
            payouts++;
          }
        }

        // The bin rule: abandon rather than grind back.
        if (a.state === 'funded' && p.binAtPct !== null) {
          const downPct = (a.balance - p.startBalance) / p.startBalance;
          if (downPct <= p.binAtPct) {
            Object.assign(a, fresh(day));
            continue;
          }
        }

        const eod = drawdownState({
          ddMode: p.ddMode, startBalance: p.startBalance, maxDrawdown: p.maxDrawdown,
          lockBuffer: p.lockBuffer, eodBalances: [a.highWaterEod], currentEquity: a.balance,
        });
        const minRisk = stepRisk(p.baseRisk, 1, {
          capStep: p.capStep, multipliers: p.multipliers, dailyLossCap: p.dailyLossCap,
        });
        const dead = eod.room <= 0 || eod.room < minRisk;
        const expired = a.state === 'eval' && a.daysAlive >= evalMaxDays;

        if (dead || expired) Object.assign(a, fresh(day));
      }
    }

    const net = extracted - spent;
    nets.push(net);
    totSpent += spent; totExtracted += extracted; totEvals += evalsBought;
    totPassed += evalsPassed; totPayouts += payouts;
    if (net > 0) profitable++;
  }

  nets.sort((a, b) => a - b);
  const pct = (q: number) => Math.round(nets[Math.min(nets.length - 1, Math.floor(q * nets.length))]);

  return {
    runs,
    horizonDays,
    spent: Math.round(totSpent / runs),
    extracted: Math.round(totExtracted / runs),
    net: Math.round((totExtracted - totSpent) / runs),
    profitableRuns: profitable / runs,
    evalsBought: Number((totEvals / runs).toFixed(1)),
    evalsPassed: Number((totPassed / runs).toFixed(1)),
    payouts: Number((totPayouts / runs).toFixed(1)),
    netPercentiles: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) },
  };
}
