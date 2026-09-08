import { describe, it, expect } from 'vitest';
import {
  resolveScalingTier,
  validateScalingTiers,
  APEX_EOD_PA_TIERS,
  ScalingTier,
} from './scaling';

const APEX_50K = APEX_EOD_PA_TIERS[50000];

describe('resolveScalingTier — Apex 50K PA', () => {
  it('starts a fresh PA at Level 1: 20 micros, not the 40 headline', () => {
    const t = resolveScalingTier(APEX_50K, 0)!;
    expect(t.level).toBe(1);
    expect(t.maxContracts).toBe(20);
    expect(t.dailyLossCap).toBe(1000);
  });

  it('walks every published band', () => {
    const cases: Array<[number, number, number, number]> = [
      // profit, level, maxContracts, dll
      [0, 1, 20, 1000],
      [1_499, 1, 20, 1000],
      [1_500, 2, 30, 1000],
      [2_999, 2, 30, 1000],
      [3_000, 3, 40, 2000],
      [5_999, 3, 40, 2000],
      [6_000, 4, 40, 3000],
      [50_000, 4, 40, 3000],
    ];
    for (const [profit, level, contracts, dll] of cases) {
      const t = resolveScalingTier(APEX_50K, profit)!;
      expect({ profit, ...t }).toMatchObject({ level, maxContracts: contracts, dailyLossCap: dll });
    }
  });

  it('holds Level 1 when the account is down — the Level 1 floor', () => {
    for (const loss of [-1, -500, -1999]) {
      const t = resolveScalingTier(APEX_50K, loss)!;
      expect(t.level).toBe(1);
      expect(t.maxContracts).toBe(20);
    }
  });

  it('reports how far the next tier is', () => {
    expect(resolveScalingTier(APEX_50K, 1_000)!.profitToNextTier).toBe(500);
    expect(resolveScalingTier(APEX_50K, 0)!.profitToNextTier).toBe(1500);
  });

  it('marks the top tier and stops promising a next one', () => {
    const top = resolveScalingTier(APEX_50K, 10_000)!;
    expect(top.isTopTier).toBe(true);
    expect(top.profitToNextTier).toBeNull();
    expect(resolveScalingTier(APEX_50K, 0)!.isTopTier).toBe(false);
  });

  it('the DLL is not constant across tiers — it triples at the top', () => {
    const caps = [0, 1500, 3000, 6000].map((p) => resolveScalingTier(APEX_50K, p)!.dailyLossCap);
    expect(caps).toEqual([1000, 1000, 2000, 3000]);
  });
});

describe('resolveScalingTier — other account sizes', () => {
  it('opens a 25K PA at 10 micros', () => {
    expect(resolveScalingTier(APEX_EOD_PA_TIERS[25000], 0)!.maxContracts).toBe(10);
  });

  it('opens a 100K PA at 30 micros and tops out at 60', () => {
    expect(resolveScalingTier(APEX_EOD_PA_TIERS[100000], 0)!.maxContracts).toBe(30);
    expect(resolveScalingTier(APEX_EOD_PA_TIERS[100000], 20_000)!.maxContracts).toBe(60);
  });

  it('opens a 150K PA at 40 micros and tops out at 100', () => {
    expect(resolveScalingTier(APEX_EOD_PA_TIERS[150000], 0)!.maxContracts).toBe(40);
    expect(resolveScalingTier(APEX_EOD_PA_TIERS[150000], 12_000)!.maxContracts).toBe(100);
  });
});

describe('resolveScalingTier — degenerate input', () => {
  it('returns null with no tiers, rather than inventing a limit', () => {
    expect(resolveScalingTier([], 1000)).toBeNull();
    expect(resolveScalingTier(undefined as unknown as ScalingTier[], 1000)).toBeNull();
  });

  it('treats a non-finite basis as zero', () => {
    expect(resolveScalingTier(APEX_50K, NaN)!.level).toBe(1);
  });

  it('does not care what order the tiers arrive in', () => {
    const shuffled = [...APEX_50K].reverse();
    expect(resolveScalingTier(shuffled, 3_000)!.level).toBe(3);
  });
});

describe('validateScalingTiers', () => {
  it('accepts every published Apex table', () => {
    for (const size of [25000, 50000, 100000, 150000]) {
      expect(validateScalingTiers(APEX_EOD_PA_TIERS[size])).toEqual([]);
    }
  });

  it('catches the overlap in Apex\'s own published 50K table', () => {
    // The scaling page lists the top tier as "$5,999 & Up" while the tier below
    // it ends at $5,999 — $5,999 would land in two bands. We store $6,000, per
    // the daily-loss-limit page; this proves the checker would have caught it.
    const asPublished: ScalingTier[] = [
      ...APEX_50K.slice(0, 3),
      { level: 4, minProfit: 5999, maxProfit: null, maxContracts: 40, dailyLossCap: 3000 },
    ];
    const problems = validateScalingTiers(asPublished);
    expect(problems.some((p) => /overlap/i.test(p))).toBe(true);
  });

  it('catches a gap between bands', () => {
    const gapped: ScalingTier[] = [
      { level: 1, minProfit: 0, maxProfit: 999, maxContracts: 20, dailyLossCap: 1000 },
      { level: 2, minProfit: 2000, maxProfit: null, maxContracts: 40, dailyLossCap: 2000 },
    ];
    expect(validateScalingTiers(gapped).some((p) => /Gap/i.test(p))).toBe(true);
  });

  it('requires the lowest band to start at zero', () => {
    const floating: ScalingTier[] = [
      { level: 1, minProfit: 500, maxProfit: null, maxContracts: 20, dailyLossCap: 1000 },
    ];
    expect(validateScalingTiers(floating).some((p) => /not \$0/.test(p))).toBe(true);
  });

  it('requires the highest band to be open-ended', () => {
    const capped: ScalingTier[] = [
      { level: 1, minProfit: 0, maxProfit: 999, maxContracts: 20, dailyLossCap: 1000 },
      { level: 2, minProfit: 1000, maxProfit: 5000, maxContracts: 40, dailyLossCap: 2000 },
    ];
    expect(validateScalingTiers(capped).some((p) => /open-ended/.test(p))).toBe(true);
  });

  it('rejects nonsensical limits', () => {
    const bad: ScalingTier[] = [
      { level: 1, minProfit: 0, maxProfit: null, maxContracts: 0, dailyLossCap: -5 },
    ];
    const problems = validateScalingTiers(bad);
    expect(problems.some((p) => /maxContracts/.test(p))).toBe(true);
    expect(problems.some((p) => /dailyLossCap/.test(p))).toBe(true);
  });

  it('reports no tiers rather than passing silently', () => {
    expect(validateScalingTiers([])).toEqual(['No tiers defined']);
  });
});
