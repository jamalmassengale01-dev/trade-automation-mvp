import { describe, it, expect } from 'vitest';
import {
  assessFeasibility, drawdownAtRisk, BacktestStats, FirmConstraints,
} from './backtestFeasibility';

/** The UPF script's 5-minute run, Aug 9 – Sep 9 2026, 1 micro on $10k. */
const UPF_5M: BacktestStats = {
  trades: 50, winRate: 0.68,
  avgWin: 2170.84 / 34, avgLoss: 1617.84 / 16,
  maxDrawdown: 744.90, tradingDays: 22,
};

const APEX_50K: FirmConstraints = {
  targetProfit: 3000, maxDrawdown: 2000, evalTradingDays: 21, minTradingDays: 1,
};
const PHIDIAS_50K: FirmConstraints = {
  targetProfit: 4000, maxDrawdown: 2500, evalTradingDays: null, minTradingDays: 3,
};

describe('assessFeasibility — the UPF backtest against real firms', () => {
  it('reproduces the expectancy from the reported totals', () => {
    const r = assessFeasibility(UPF_5M, APEX_50K);
    // $553 net over 50 trades.
    expect(r.expectancyPerTrade).toBeCloseTo(11.06, 1);
  });

  it('flags a payoff ratio below 1 — wins small, loses big', () => {
    const r = assessFeasibility(UPF_5M, APEX_50K);
    expect(r.payoffRatio).toBeLessThan(1);
    expect(r.reasons.join(' ')).toContain('smaller than average loss');
  });

  it('rules out an Apex evaluation on the 30-day clock', () => {
    const r = assessFeasibility(UPF_5M, APEX_50K);
    expect(r.verdict).toBe('too_slow');
    expect(r.tradingDaysToTarget).toBeGreaterThan(21);
    expect(r.reasons.join(' ')).toContain('does not help');
  });

  it('calls Phidias slow rather than impossible — no expiry to fail', () => {
    const r = assessFeasibility(UPF_5M, PHIDIAS_50K);
    expect(r.verdict).toBe('marginal');
    expect(r.tradingDaysToTarget).toBeGreaterThan(60);
  });

  it('warns that 50 trades cannot establish an edge', () => {
    const r = assessFeasibility(UPF_5M, PHIDIAS_50K);
    // 95% CI on 68% from n=50 reaches down to ~55%, where expectancy is negative.
    expect(r.expectancyAtWorstCase).toBeLessThan(0);
    expect(r.reasons.join(' ')).toContain('cannot distinguish this from a losing strategy');
  });
});

describe('drawdownAtRisk — sizing to a chosen per-trade risk', () => {
  it('blows both firms at GB LIVE base risk', () => {
    // The question that actually decides it: size like the other strategy.
    expect(drawdownAtRisk(UPF_5M, 334)).toBeGreaterThan(2000);   // Apex limit
    expect(drawdownAtRisk(UPF_5M, 417)).toBeGreaterThan(2500);   // Phidias limit
  });

  it('scales linearly with risk', () => {
    const a = drawdownAtRisk(UPF_5M, 100);
    const b = drawdownAtRisk(UPF_5M, 200);
    expect(b).toBeCloseTo(a * 2, 1);
  });
});

describe('assessFeasibility — edge cases', () => {
  const strong: BacktestStats = {
    trades: 400, winRate: 0.55, avgWin: 300, avgLoss: 150,
    maxDrawdown: 600, tradingDays: 200,
  };

  it('passes a strategy with a real edge and a small drawdown', () => {
    const r = assessFeasibility(strong, APEX_50K);
    expect(r.verdict).toBe('viable');
    expect(r.expectancyAtWorstCase).toBeGreaterThan(0);
  });

  it('does not add a small-sample caveat to a large sample', () => {
    expect(assessFeasibility(strong, APEX_50K).reasons.join(' ')).not.toContain('indicative');
  });

  it('reports no_edge without pretending sizing can rescue it', () => {
    const losing: BacktestStats = { ...strong, winRate: 0.3 };
    const r = assessFeasibility(losing, APEX_50K);
    expect(r.verdict).toBe('no_edge');
    expect(r.reasons.join(' ')).toContain('cannot fix a negative edge');
  });

  it('honours the firm minimum trading days even when target is reached sooner', () => {
    const fast: BacktestStats = { ...strong, avgWin: 3000, avgLoss: 150, tradingDays: 20, trades: 400 };
    const r = assessFeasibility(fast, { ...PHIDIAS_50K, minTradingDays: 3 });
    expect(r.verdict).toBe('viable');
  });

  it('keeps the observed drawdown UNDER half the cap, never over', () => {
    // An upper bound, not an approximation. The multiplier rounds down for
    // this reason — rounding to nearest can land fractionally over the budget.
    const r = assessFeasibility(UPF_5M, PHIDIAS_50K);
    expect(r.scaledDrawdownAtSafeSize).toBeLessThanOrEqual(PHIDIAS_50K.maxDrawdown * 0.5);
    expect(r.scaledDrawdownAtSafeSize).toBeGreaterThan(PHIDIAS_50K.maxDrawdown * 0.49);
  });

  it('respects a custom safety fraction', () => {
    const r = assessFeasibility(UPF_5M, PHIDIAS_50K, { drawdownSafetyFraction: 0.8 });
    expect(r.scaledDrawdownAtSafeSize).toBeLessThanOrEqual(PHIDIAS_50K.maxDrawdown * 0.8);
    // Sizing up shortens the timeline but does not change the edge-to-drawdown
    // ratio, which is the property that decides viability.
    expect(r.tradingDaysToTarget).toBeLessThan(
      assessFeasibility(UPF_5M, PHIDIAS_50K).tradingDaysToTarget
    );
  });
});
