import { describe, it, expect } from 'vitest';
import { simulateFleet, FleetParams } from './fleetMonteCarlo';

/** Apex 50K, the shape the fleet was designed around. */
const APEX: Omit<FleetParams, 'activeSlots' | 'binAtPct'> = {
  startBalance: 50000, targetProfit: 3000, maxDrawdown: 2000,
  ddMode: 'eod_trailing', lockBuffer: 100, dailyLossCap: 1000,
  baseRisk: 334, capStep: 3, expiryDays: 30, minTradingDays: 1,
  evalPrice: 109, safetyNet: 2100, minPayout: 500,
  slots: 10, staggerDays: 7,
  winRate: 0.55, fullWinShare: 0.45, breakevenRate: 0.05,
  tradesPerDay: 1.4, maxTradesPerDay: 3,
};

const run = (over: Partial<FleetParams>, days = 250, runs = 400) =>
  simulateFleet({ ...APEX, activeSlots: 10, binAtPct: null, ...over }, days, runs, 42);

describe('simulateFleet', () => {
  it('is deterministic for a given seed', () => {
    expect(run({}).net).toBe(run({}).net);
  });

  it('spends the evaluation price for every evaluation bought', () => {
    const r = run({ evalPrice: 100 });
    // evalsBought is reported to one decimal, so reconstructing the total from
    // it carries up to half a count of rounding — 0.05 x 100 = $5 either way.
    expect(r.spent).toBeGreaterThan(r.evalsBought * 100 - 6);
    expect(r.spent).toBeLessThan(r.evalsBought * 100 + 6);
  });

  it('net is extracted minus spent', () => {
    const r = run({});
    expect(r.net).toBe(r.extracted - r.spent);
  });

  // The framework's central claim. Measured: it does not hold.
  it('rotation does not beat copy-trading at zero edge', () => {
    const all = run({ activeSlots: 10 });
    const half = run({ activeSlots: 5 });
    expect(half.net).toBeLessThanOrEqual(all.net);
  });

  // Idle accounts still burn their expiry clock, so rotating under one buys
  // MORE evaluations and passes FEWER of them.
  it('rotation under an expiry clock buys more evaluations and passes fewer', () => {
    const all = run({ activeSlots: 10, expiryDays: 30 });
    const half = run({ activeSlots: 5, expiryDays: 30 });
    expect(half.evalsBought).toBeGreaterThan(all.evalsBought);
    expect(half.evalsPassed).toBeLessThan(all.evalsPassed);
  });

  /**
   * -6% of a 50K account is -$3,000, but the drawdown gate seizes it at
   * -$2,000. The rule can never fire on a futures account with a 4% drawdown;
   * it is a forex figure, where 10% is typical. If this test ever fails, the
   * preset's drawdown has widened enough for the rule to matter.
   */
  it('a -6% bin rule cannot fire against a $2,000 drawdown', () => {
    const without = run({ binAtPct: null });
    const with6 = run({ binAtPct: -0.06 });
    expect(with6.net).toBe(without.net);
    expect(with6.evalsBought).toBe(without.evalsBought);
  });

  it('a bin rule inside the drawdown does change behaviour', () => {
    const without = run({ binAtPct: null });
    const with2 = run({ binAtPct: -0.02 }); // -$1,000, reachable before seizure
    expect(with2.evalsBought).not.toBe(without.evalsBought);
  });

  // The variable that actually decides the outcome.
  it('a real edge turns the fleet profitable; price alone does not', () => {
    const cheapNoEdge = run({ evalPrice: 22 });
    const dearWithEdge = run({ evalPrice: 109, winRate: 0.60, fullWinShare: 0.70 });
    expect(cheapNoEdge.net).toBeLessThan(0);
    expect(dearWithEdge.net).toBeGreaterThan(0);
  });

  it('cheaper evaluations help, holding the edge fixed', () => {
    expect(run({ evalPrice: 22 }).net).toBeGreaterThan(run({ evalPrice: 109 }).net);
  });

  it('reports percentiles spanning the mean', () => {
    const r = run({});
    expect(r.netPercentiles.p10).toBeLessThanOrEqual(r.netPercentiles.p50);
    expect(r.netPercentiles.p50).toBeLessThanOrEqual(r.netPercentiles.p90);
  });
});
