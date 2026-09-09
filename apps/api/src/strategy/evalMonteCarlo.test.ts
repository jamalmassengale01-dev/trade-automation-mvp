import { describe, it, expect } from 'vitest';
import { simulateEval, EvalSimParams } from './evalMonteCarlo';

const APEX: EvalSimParams = {
  startBalance: 50_000, targetProfit: 3_000, maxDrawdown: 2_000,
  ddMode: 'eod_trailing', lockBuffer: 100, dailyLossCap: 1_000,
  baseRisk: 334, capStep: 3, expiryDays: 30, minTradingDays: 1,
  winRate: 0.6, fullWinShare: 0.7, breakevenRate: 0.05,
  tradesPerDay: 1.4, maxTradesPerDay: 3,
};

describe('simulateEval', () => {
  it('is deterministic for a given seed', () => {
    const a = simulateEval(APEX, 2_000, 7);
    const b = simulateEval(APEX, 2_000, 7);
    expect(a.passRate).toBe(b.passRate);
    expect(a.daysToPass.p50).toBe(b.daysToPass.p50);
  });

  it('accounts for every run exactly once', () => {
    const r = simulateEval(APEX, 2_000, 7);
    expect(r.passRate + r.failRate + r.expiredRate).toBeCloseTo(1, 6);
    expect(r.failRate).toBeCloseTo(r.blowRate + r.seizedRate, 6);
  });

  it('passes more often as the edge improves', () => {
    const weak = simulateEval({ ...APEX, winRate: 0.5 }, 4_000, 7);
    const strong = simulateEval({ ...APEX, winRate: 0.7 }, 4_000, 7);
    expect(strong.passRate).toBeGreaterThan(weak.passRate);
  });

  it('never passes an evaluation with no edge at all', () => {
    const r = simulateEval({ ...APEX, winRate: 0.2, fullWinShare: 0 }, 4_000, 7);
    expect(r.passRate).toBeLessThan(0.01);
  });

  it('raises the pass rate when the expiry is removed, holding all else equal', () => {
    // The whole point of the no-clock question: evaluations that would have
    // run out of time now get to finish.
    const clocked = simulateEval(APEX, 6_000, 7);
    const open = simulateEval({ ...APEX, expiryDays: null }, 6_000, 7);
    expect(open.passRate).toBeGreaterThan(clocked.passRate);
    // ...and the tail gets longer, which is what removing it costs.
    expect(open.daysToPass.p90).toBeGreaterThan(clocked.daysToPass.p90);
  });

  it('reports seizure, not breach, as the dominant failure', () => {
    // The drawdown gate refuses any trade larger than the remaining room, so
    // an account runs out of tradable room long before it breaches the floor.
    const r = simulateEval({ ...APEX, winRate: 0.45 }, 4_000, 7);
    expect(r.seizedRate).toBeGreaterThan(r.blowRate);
  });

  it('respects a minimum trading day requirement', () => {
    // 30 required days cannot be met inside a 30-CALENDAR-day expiry, which is
    // only ~21 trading days.
    const r = simulateEval({ ...APEX, minTradingDays: 30 }, 2_000, 7);
    expect(r.passRate).toBe(0);
  });

  it('derives cost per funded account from the pass rate', () => {
    const r = simulateEval(APEX, 4_000, 7);
    expect(r.costPerFunded(109)).toBeCloseTo(109 / r.passRate, 1);
  });
});
