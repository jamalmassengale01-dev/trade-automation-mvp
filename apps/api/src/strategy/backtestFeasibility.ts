/**
 * Can a backtest survive a prop firm?
 *
 * A backtest reports profit. A prop firm evaluation is not won on profit, it is
 * won on profit BEFORE the drawdown runs out and, at some firms, before a clock
 * does. Those are different questions, and a strategy can pass the first
 * decisively while failing the second at every possible position size.
 *
 * The arithmetic:
 *
 *   1. A backtest at one contract has some max drawdown D and some expectancy
 *      E per trade. Both scale linearly with position size.
 *   2. Trading at k contracts gives drawdown k·D and expectancy k·E.
 *   3. The firm caps drawdown at L, so k is bounded: k ≤ (L · safetyFraction)/D.
 *   4. That bound fixes the expectancy, which fixes how many trades the target
 *      needs, which fixes how many days — which the eval window may not allow.
 *
 * The trap this exists to catch: raising position size to pass faster raises
 * drawdown at exactly the same rate, so it buys nothing. The ratio of edge to
 * drawdown is a property of the STRATEGY, and no amount of sizing changes it.
 * A strategy whose scaled drawdown will not fit under the cap while reaching
 * target in time cannot be made to fit.
 */

export interface BacktestStats {
  /** Trades in the sample. Below ~100 the verdict is indicative, not decisive. */
  trades: number;
  winRate: number;
  /** Average winning trade, in dollars, at the tested position size. */
  avgWin: number;
  /** Average losing trade as a POSITIVE number of dollars. */
  avgLoss: number;
  /** Peak-to-trough drawdown, in dollars, at the tested position size. */
  maxDrawdown: number;
  /** Trading days the sample spans, for the pace estimate. */
  tradingDays: number;
}

export interface FirmConstraints {
  targetProfit: number;
  maxDrawdown: number;
  /** Trading days before the evaluation expires. Null = no clock. */
  evalTradingDays: number | null;
  /** Minimum trading days the firm requires before it will pass an eval. */
  minTradingDays?: number;
}

export interface FeasibilityOptions {
  /**
   * Fraction of the firm's drawdown the scaled backtest may consume.
   *
   * 0.5 by default and that is not conservatism for its own sake: the sample's
   * max drawdown is the worst run OBSERVED, not the worst possible. Sizing so
   * the observed worst case exactly touches the limit means any run worse than
   * the sample — which is most of them, given enough time — ends the account.
   */
  drawdownSafetyFraction?: number;
}

export type FeasibilityVerdict = 'viable' | 'marginal' | 'too_slow' | 'no_edge';

export interface FeasibilityResult {
  verdict: FeasibilityVerdict;
  /** Expectancy per trade at the tested size. Negative means there is no edge. */
  expectancyPerTrade: number;
  /** avgWin / avgLoss. Below 1 the strategy wins small and loses big. */
  payoffRatio: number;
  /** Largest safe multiple of the tested position size. */
  safeMultiplier: number;
  expectancyAtSafeSize: number;
  scaledDrawdownAtSafeSize: number;
  /** Drawdown if traded at a given per-trade risk instead. */
  tradesToTarget: number;
  tradingDaysToTarget: number;
  /** Trades per day observed in the sample. */
  tradesPerDay: number;
  /**
   * 95% confidence interval on the win rate, and the expectancy at its lower
   * bound. A sample whose lower bound is a losing strategy has not established
   * an edge, however good the headline looks.
   */
  winRateCi: { low: number; high: number };
  expectancyAtWorstCase: number;
  reasons: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/**
 * Round DOWN to 2dp.
 *
 * Used for the position multiplier only. Rounding it to nearest can round up,
 * which pushes the scaled drawdown past the budget the multiplier exists to
 * respect — a "safe" size that is fractionally over the cap is not safe, and
 * the error compounds with every dollar of account size.
 */
const floor2 = (n: number) => Math.floor(n * 100) / 100;

/**
 * Drawdown this strategy would produce at a chosen per-trade risk.
 *
 * The question people actually ask — "what if I size it like my other
 * strategy?" — and usually the one that ends the conversation.
 */
export function drawdownAtRisk(stats: BacktestStats, riskPerTrade: number): number {
  if (stats.avgLoss <= 0) return 0;
  return round2(stats.maxDrawdown * (riskPerTrade / stats.avgLoss));
}

/** Can this backtest clear this firm's evaluation? */
export function assessFeasibility(
  stats: BacktestStats,
  firm: FirmConstraints,
  options: FeasibilityOptions = {}
): FeasibilityResult {
  const safety = options.drawdownSafetyFraction ?? 0.5;
  const reasons: string[] = [];

  const payoffRatio = stats.avgLoss > 0 ? round2(stats.avgWin / stats.avgLoss) : Infinity;
  const expectancyPerTrade = round2(
    stats.winRate * stats.avgWin - (1 - stats.winRate) * stats.avgLoss
  );
  const tradesPerDay = stats.tradingDays > 0 ? round2(stats.trades / stats.tradingDays) : 0;

  // Sampling error on the win rate. Reported because a headline win rate from
  // fifty trades routinely spans "excellent" to "loses money".
  const se = Math.sqrt(Math.max(0, (stats.winRate * (1 - stats.winRate)) / Math.max(1, stats.trades)));
  const low = Math.max(0, stats.winRate - 1.96 * se);
  const high = Math.min(1, stats.winRate + 1.96 * se);
  const expectancyAtWorstCase = round2(low * stats.avgWin - (1 - low) * stats.avgLoss);

  const safeMultiplier =
    stats.maxDrawdown > 0
      ? floor2((firm.maxDrawdown * safety) / stats.maxDrawdown)
      : Infinity;
  const expectancyAtSafeSize = round2(expectancyPerTrade * safeMultiplier);
  const scaledDrawdownAtSafeSize = round2(stats.maxDrawdown * safeMultiplier);

  const tradesToTarget =
    expectancyAtSafeSize > 0 ? Math.ceil(firm.targetProfit / expectancyAtSafeSize) : Infinity;
  const tradingDaysToTarget =
    tradesPerDay > 0 && Number.isFinite(tradesToTarget)
      ? Math.ceil(tradesToTarget / tradesPerDay)
      : Infinity;

  if (expectancyPerTrade <= 0) {
    reasons.push(
      `Expectancy is $${expectancyPerTrade} per trade. The strategy loses money at any size; ` +
      'position sizing cannot fix a negative edge, only scale it.'
    );
    return {
      verdict: 'no_edge', expectancyPerTrade, payoffRatio, safeMultiplier,
      expectancyAtSafeSize, scaledDrawdownAtSafeSize, tradesToTarget,
      tradingDaysToTarget, tradesPerDay,
      winRateCi: { low: round2(low), high: round2(high) },
      expectancyAtWorstCase, reasons,
    };
  }

  if (payoffRatio < 1) {
    reasons.push(
      `Average win $${round2(stats.avgWin)} is smaller than average loss ` +
      `$${round2(stats.avgLoss)} (payoff ${payoffRatio}). The edge depends entirely on the ` +
      'win rate holding — a few points of decay flips it negative.'
    );
  }

  if (expectancyAtWorstCase <= 0) {
    reasons.push(
      `At the low end of the 95% confidence interval on win rate (${Math.round(low * 100)}%), ` +
      `expectancy is $${expectancyAtWorstCase}. ${stats.trades} trades cannot distinguish this ` +
      'from a losing strategy.'
    );
  }

  const minDays = firm.minTradingDays ?? 0;
  const effectiveDays = Math.max(tradingDaysToTarget, minDays);

  let verdict: FeasibilityVerdict;
  if (firm.evalTradingDays !== null && effectiveDays > firm.evalTradingDays) {
    verdict = 'too_slow';
    reasons.push(
      `Reaching $${firm.targetProfit} needs about ${tradesToTarget} trades (${effectiveDays} ` +
      `trading days at ${tradesPerDay}/day), against ${firm.evalTradingDays} before the ` +
      'evaluation expires. Sizing up to go faster raises drawdown at the same rate, so it ' +
      'does not help.'
    );
  } else if (effectiveDays > 60) {
    verdict = 'marginal';
    reasons.push(
      `No expiry to fail, but ${effectiveDays} trading days at safe size is roughly three ` +
      'months of exposure to reach target.'
    );
  } else {
    verdict = 'viable';
    reasons.push(
      `Reaching $${firm.targetProfit} projects to ${tradesToTarget} trades / ${effectiveDays} ` +
      `trading days at ${safeMultiplier}x the tested size.`
    );
  }

  if (stats.trades < 100) {
    reasons.push(
      `Sample is ${stats.trades} trades. Treat the verdict as indicative; 200+ trades across ` +
      'more than one market regime is where it becomes decisive.'
    );
  }

  return {
    verdict, expectancyPerTrade, payoffRatio, safeMultiplier,
    expectancyAtSafeSize, scaledDrawdownAtSafeSize, tradesToTarget,
    tradingDaysToTarget, tradesPerDay,
    winRateCi: { low: round2(low), high: round2(high) },
    expectancyAtWorstCase, reasons,
  };
}

/** Human-readable report. */
export function formatFeasibility(
  name: string,
  stats: BacktestStats,
  firm: FirmConstraints,
  result: FeasibilityResult
): string {
  const mark = { viable: 'VIABLE', marginal: 'MARGINAL', too_slow: 'TOO SLOW', no_edge: 'NO EDGE' };
  return [
    `${name} — ${mark[result.verdict]}`,
    `  sample        ${stats.trades} trades over ${stats.tradingDays} days ` +
      `(${result.tradesPerDay}/day), win rate ${Math.round(stats.winRate * 100)}%`,
    `  payoff        avg win $${round2(stats.avgWin)} / avg loss $${round2(stats.avgLoss)} ` +
      `= ${result.payoffRatio}`,
    `  expectancy    $${result.expectancyPerTrade}/trade ` +
      `(worst case in CI: $${result.expectancyAtWorstCase})`,
    `  safe size     ${result.safeMultiplier}x tested → drawdown ` +
      `$${result.scaledDrawdownAtSafeSize} of $${firm.maxDrawdown} allowed`,
    `  to target     ${result.tradesToTarget} trades / ${result.tradingDaysToTarget} days` +
      (firm.evalTradingDays !== null ? ` (window: ${firm.evalTradingDays} days)` : ' (no expiry)'),
    ...result.reasons.map((r) => `  → ${r}`),
  ].join('\n');
}
