import { describe, it, expect } from 'vitest';
import { calculatePropFirm, PropFirmInputs, toDerivedFrom,
  suggestInternalDailyLossCap,
} from './propFirmMath';

/** Apex 50K EOD Eval, exactly as documented in CLAUDE.md. */
const APEX_50K_EVAL: PropFirmInputs = {
  startBalance: 50000,
  targetProfit: 3000,
  maxDrawdown: 2000,
  dailyLossCap: 1000,
  ddMode: 'eod_trailing',
  phase: 'eval',
  maxContracts: 60,
  minTradingDays: 7,
  consistencyPct: 50,
  stepMultipliers: { step2: 1, step3: 2, step4: 4 },
  capStep: 4,
  typicalStopPts: 15,
  symbol: 'MNQ',
};

const APEX_50K_PA: PropFirmInputs = {
  ...APEX_50K_EVAL,
  phase: 'funded',
  targetProfit: 2600,
  maxContracts: 40,
  minPayout: 500,
  safetyNetBuffer: 100,
};

function ids(r: ReturnType<typeof calculatePropFirm>) {
  return r.findings.map((f) => f.id);
}

describe('calculatePropFirm — base risk', () => {
  it('derives $334 from a $1,000 DLL using the DLL/3 convention', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.rules.baseRisk).toBe(334);
  });

  it('flags that ceil-rounding puts 3 losses $2 over the cap', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(ids(r)).toContain('base_risk_overshoots_dll');
  });

  it('floor rounding stays inside the cap and raises no overshoot note', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, riskRounding: 'floor' });
    expect(r.rules.baseRisk).toBe(333);
    expect(ids(r)).not.toContain('base_risk_overshoots_dll');
  });

  it('honours an explicit base risk override (Eval Rush)', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, baseRiskOverride: 500 });
    expect(r.rules.baseRisk).toBe(500);
  });

  it('respects a non-default risk divisor', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, riskDivisor: 4 });
    expect(r.rules.baseRisk).toBe(250);
  });
});

describe('calculatePropFirm — ladder feasibility', () => {
  it('walks 1/1/2/4 multipliers into the right nominal risks', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.rules.ladder.map((l) => l.nominalRisk)).toEqual([334, 334, 668, 1000]);
    // step 4 wants 4 x 334 = 1336 but is clamped to the $1,000 daily cap
  });

  it('finds that only steps 1-2 can fire inside one broker day', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    // Room is consumed by ACTUAL contract-rounded losses ($330), matching how the
    // live DLL gate reads day_realized_pnl — not by the nominal $334 step risk.
    // step1 (room 1000, ok) -> step2 (room 670, ok) -> step3 needs 668 > room 340
    expect(r.rules.maxReachableStep).toBe(2);
    expect(r.rules.ladder[2].reachableSameDay).toBe(false);
    expect(r.rules.ladder[2].dllRoomBefore).toBe(340);
    expect(ids(r)).toContain('ladder_unreachable');
  });

  it('shows 1/1/2/4 under DLL/3 can never reach step 3+ same-day, at any account size', () => {
    // Structural, not a tuning accident: the four steps sum to 8x base, so the
    // whole ladder only fits inside one day when base <= DLL/8. DLL/3 is far
    // above that, so steps 3-4 only ever fire on a LATER day, after the 6PM ET
    // reset, carrying the step forward. True for 50K and 250K alike.
    for (const dailyLossCap of [1000, 2500, 5000]) {
      const r = calculatePropFirm({ ...APEX_50K_EVAL, dailyLossCap, maxDrawdown: dailyLossCap * 2 });
      expect(r.rules.maxReachableStep).toBe(2);
    }
  });

  it('reports worst-case day loss from actual (integer-contract) risk, not nominal', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    // 334 / (15 x 2) = 11.13 -> 11 contracts -> 11 x 30 = $330 actual, twice
    expect(r.rules.ladder[0].contracts).toBe(11);
    expect(r.rules.ladder[0].actualRisk).toBe(330);
    expect(r.rules.worstCaseDayLoss).toBe(660);
  });

  it('a base risk small enough vs the cap does let the whole ladder fire in one day', () => {
    // base = DLL/10 = 600; steps 600 + 600 + 1200 + 2400 = 4800 <= 6000 cap.
    const r = calculatePropFirm({
      ...APEX_50K_EVAL,
      dailyLossCap: 6000,
      maxDrawdown: 20000,
      riskDivisor: 10,
    });
    expect(r.rules.baseRisk).toBe(600);
    expect(r.rules.maxReachableStep).toBe(4);
    expect(ids(r)).not.toContain('ladder_unreachable');
  });
});

describe('calculatePropFirm — contract cap', () => {
  it('flags when the contract cap silently truncates a ladder step', () => {
    // 40-contract PA cap, tight 5pt stop: step 3 wants 668/(5x2) = 66 contracts
    const r = calculatePropFirm({ ...APEX_50K_PA, typicalStopPts: 5 });
    expect(ids(r)).toContain('contract_cap_binds');
    const rung = r.rules.ladder.find((l) => l.contractCapBinds)!;
    expect(rung.uncappedContracts).toBeGreaterThan(40);
    expect(rung.contracts).toBe(40);
    expect(rung.actualRisk).toBeLessThan(rung.nominalRisk);
  });

  it('does not flag the cap when a normal stop keeps size well under it', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(ids(r)).not.toContain('contract_cap_binds');
  });

  it('errors when the stop is too wide to afford a single contract', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, typicalStopPts: 400 });
    expect(ids(r)).toContain('size_zero');
    expect(r.findings.find((f) => f.id === 'size_zero')!.severity).toBe('error');
  });
});

describe('calculatePropFirm — payout and balance thresholds', () => {
  it('reproduces the documented $52,100 safety net and $52,600 payout floor', () => {
    const r = calculatePropFirm(APEX_50K_PA);
    expect(r.rules.safetyNetBalance).toBe(52100);
    expect(r.rules.minBalanceForPayout).toBe(52600);
  });

  it('leaves payout thresholds null for an eval', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.rules.safetyNetBalance).toBeNull();
    expect(r.rules.minBalanceForPayout).toBeNull();
  });

  it('computes the target balance', () => {
    expect(calculatePropFirm(APEX_50K_EVAL).rules.targetBalance).toBe(53000);
  });
});

describe('calculatePropFirm — consistency rule', () => {
  it('reproduces the CLAUDE.md example: an $800 day needs $1,600 total', () => {
    const r = calculatePropFirm(APEX_50K_PA);
    expect(r.rules.minTotalProfitForDay!(800)).toBe(1600);
  });

  it('caps the largest compliant day at the consistency fraction of target', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.rules.maxCompliantDayAtTarget).toBe(1500);
  });

  it('disables consistency math when the pct is zero', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, consistencyPct: 0 });
    expect(r.rules.minTotalProfitForDay).toBeNull();
    expect(r.rules.maxCompliantDayAtTarget).toBeNull();
  });
});

describe('calculatePropFirm — drawdown survivability', () => {
  it('reports how many worst-case days the drawdown absorbs', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    // 2000 max DD / 660 worst-case day
    expect(r.rules.survivableMaxLossDays).toBeCloseTo(3.03, 2);
  });

  it('errors when the daily cap is not below max drawdown', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, dailyLossCap: 2000 });
    expect(ids(r)).toContain('dll_exceeds_maxdd');
    expect(r.findings.find((f) => f.id === 'dll_exceeds_maxdd')!.severity).toBe('error');
  });

  it('warns when the drawdown absorbs fewer than two bad days', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, maxDrawdown: 900, dailyLossCap: 800 });
    expect(ids(r)).toContain('thin_dd_buffer');
  });
});

describe('calculatePropFirm — expectancy shape', () => {
  it('weights avg win R by the real group split, not a flat half', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    // 11 contracts -> g1 = 5 at 0.5R, g2 = 6 at 2.0R -> (2.5 + 12) / 11
    expect(r.rules.avgWinR).toBeCloseTo(1.32, 2);
    expect(r.rules.partialWinR).toBeCloseTo(0.23, 2);
  });

  it('derives a breakeven win rate consistent with that avg win', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.rules.breakevenWinRate).toBeCloseTo(1 / (1 + r.rules.avgWinR), 2);
    expect(r.rules.breakevenWinRate).toBeLessThan(0.5);
  });
});

describe('calculatePropFirm — projections', () => {
  it('keeps projections separate and carries an explicit caveat', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.projections.caveat).toMatch(/NOT validated/i);
    expect(r.projections.assumedWinRate).toBe(0.6);
  });

  it('produces a rising sensitivity band across win rates', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    const exp = r.projections.sensitivity.map((s) => s.expectancyR);
    for (let i = 1; i < exp.length; i++) expect(exp[i]).toBeGreaterThan(exp[i - 1]);
  });

  it('flags negative expectancy below the breakeven win rate', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, assumedWinRate: 0.2 });
    expect(ids(r)).toContain('negative_expectancy');
    expect(r.projections.base.expectancyR).toBeLessThan(0);
    expect(r.projections.base.daysToTarget).toBeNull();
  });

  it('binds days-to-pass to the firm minimum when the projection is faster', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, minTradingDays: 40, assumedWinRate: 0.65 });
    expect(r.projections.bindingDaysToPass).toBe(40);
  });
});

describe('calculatePropFirm — evaluation expiry', () => {
  // Verified from apextraderfunding.com: the 50K EOD Trail eval is active for
  // 30 calendar days, expires after 30 days, and has no resets. A slow pass is
  // therefore a lost fee, not a delayed one.
  const APEX_WITH_EXPIRY = { ...APEX_50K_EVAL, minTradingDays: 1, evalExpiryDays: 30 };

  it('converts a calendar expiry window into trading days', () => {
    const r = calculatePropFirm(APEX_WITH_EXPIRY);
    // 30 calendar days x 5/7 ≈ 21 trading days
    expect(r.projections.tradingDaysBeforeExpiry).toBe(21);
  });

  it('is null when the firm imposes no expiry', () => {
    expect(calculatePropFirm(APEX_50K_EVAL).projections.tradingDaysBeforeExpiry).toBeNull();
  });

  it('errors when the target cannot be reached before expiry', () => {
    // A low win rate stretches days-to-target well past the window.
    const r = calculatePropFirm({ ...APEX_WITH_EXPIRY, assumedWinRate: 0.47 });
    expect(ids(r)).toContain('eval_expiry_unreachable');
    expect(r.findings.find((f) => f.id === 'eval_expiry_unreachable')!.severity).toBe('error');
  });

  it('warns when the projection leaves little room before expiry', () => {
    const r = calculatePropFirm({ ...APEX_WITH_EXPIRY, assumedWinRate: 0.55 });
    expect(ids(r)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^eval_expiry_(tight|unreachable)$/)])
    );
  });

  it('stays quiet when the target is comfortably inside the window', () => {
    const r = calculatePropFirm({ ...APEX_WITH_EXPIRY, assumedWinRate: 0.75 });
    expect(ids(r)).not.toContain('eval_expiry_unreachable');
    expect(ids(r)).not.toContain('eval_expiry_tight');
  });

  it('respects a firm minimum that alone exceeds the window', () => {
    const r = calculatePropFirm({
      ...APEX_WITH_EXPIRY, minTradingDays: 25, assumedWinRate: 0.75,
    });
    expect(ids(r)).toContain('eval_expiry_unreachable');
  });
});

describe('calculatePropFirm — min trading days finding', () => {
  it('does not assert a range it cannot know', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, minTradingDays: 0 });
    const f = r.findings.find((x) => x.id === 'min_days_unset')!;
    expect(f.message).not.toMatch(/most require 5-10/);
    expect(f.message).toMatch(/Apex EOD evaluations are 1 day/);
  });

  it('stays silent once a minimum is supplied', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, minTradingDays: 1 });
    expect(ids(r)).not.toContain('min_days_unset');
  });
});

describe('calculatePropFirm — preset output', () => {
  it('emits fields that line up with the presets table columns', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    expect(r.preset).toMatchObject({
      start_balance: 50000,
      target_profit: 3000,
      max_drawdown: 2000,
      daily_loss_cap: 1000,
      base_risk: 334,
      max_contracts: 60,
      dd_mode: 'eod_trailing',
      phase: 'eval',
      cap_step: 4,
      step2_mult: 1,
      step3_mult: 2,
      step4_mult: 4,
    });
  });

  it('round-trips inputs into a JSON-safe derived_from blob', () => {
    const r = calculatePropFirm(APEX_50K_EVAL);
    const blob = toDerivedFrom(r);
    expect(() => JSON.stringify(blob)).not.toThrow();
    expect(JSON.parse(JSON.stringify(blob)).inputs.dailyLossCap).toBe(1000);
    expect(blob.calculator_version).toBe(1);
  });
});

describe('calculatePropFirm — input validation', () => {
  it.each([
    ['startBalance', { startBalance: 0 }],
    ['maxDrawdown', { maxDrawdown: 0 }],
    ['dailyLossCap', { dailyLossCap: -1 }],
    ['maxContracts', { maxContracts: 0 }],
    ['typicalStopPts', { typicalStopPts: 0 }],
    ['riskDivisor', { riskDivisor: 0 }],
  ])('rejects a non-positive %s', (_label, patch) => {
    expect(() => calculatePropFirm({ ...APEX_50K_EVAL, ...patch } as PropFirmInputs)).toThrow();
  });

  it('rejects an unknown instrument', () => {
    expect(() => calculatePropFirm({ ...APEX_50K_EVAL, symbol: 'XYZ' })).toThrow(/Unknown instrument/);
  });

  it('warns about intraday trailing drawdown', () => {
    const r = calculatePropFirm({ ...APEX_50K_EVAL, ddMode: 'intraday_trailing' });
    expect(ids(r)).toContain('intraday_trailing_dd');
  });
});

// ------------------------------------------------------------------
// Firms with no published daily loss limit (Phidias-shaped)
// ------------------------------------------------------------------
describe('self-imposed daily loss cap', () => {
  // Phidias 50K Fundamental (Tradovate), evaluation phase, from the firm's
  // own accounts page: $2,500 EOD trailing drawdown, $4,000 target, 3 days to
  // pass, 100 micros, no consistency rule, and no daily loss limit at all.
  const PHIDIAS_50K = {
    startBalance: 50_000,
    targetProfit: 4_000,
    maxDrawdown: 2_500,
    ddMode: 'eod_trailing' as const,
    phase: 'eval' as const,
    maxContracts: 100,
    minTradingDays: 3,
  };

  it('suggests half the drawdown, matching the ratio the ladder assumes', () => {
    expect(suggestInternalDailyLossCap(2_500)).toBe(1_250);
    expect(suggestInternalDailyLossCap(2_000)).toBe(1_000); // the Apex ratio
  });

  it('tells you to set one instead of demanding a rule the firm does not have', () => {
    expect(() =>
      calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 0, dailyLossCapSource: 'internal' })
    ).toThrow(/publishes no daily limit.*\$1250/s);
  });

  it('still rejects a missing cap plainly when the firm does impose one', () => {
    expect(() => calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 0 }))
      .toThrow('dailyLossCap must be a positive number');
  });

  it('computes the same numbers as a firm-imposed cap of the same size', () => {
    const internal = calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 1_250, dailyLossCapSource: 'internal' });
    const firm = calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 1_250 });
    // The arithmetic is identical — only the findings differ.
    expect(internal.preset.base_risk).toBe(firm.preset.base_risk);
    expect(internal.preset.daily_loss_cap).toBe(firm.preset.daily_loss_cap);
  });

  it('warns that the cap is enforced only by us', () => {
    const r = calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 1_250, dailyLossCapSource: 'internal' });
    const f = r.findings.find((x) => x.id === 'dll_self_enforced');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toContain('enforced only by EdgePilot');
    // ...and not on an ordinary firm-capped preset.
    expect(
      calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 1_250 }).findings.map((x) => x.id)
    ).not.toContain('dll_self_enforced');
  });

  it('pushes back on a self-imposed cap looser than the suggestion', () => {
    const r = calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 2_000, dailyLossCapSource: 'internal' });
    expect(r.findings.map((x) => x.id)).toContain('internal_dll_above_suggested');
  });

  it('does not complain when the self-imposed cap is tighter', () => {
    const r = calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 800, dailyLossCapSource: 'internal' });
    expect(r.findings.map((x) => x.id)).not.toContain('internal_dll_above_suggested');
  });

  it('has no eval expiry findings when the firm imposes no clock', () => {
    // Phidias evals do not expire, so the Apex 30-day pressure is absent.
    const r = calculatePropFirm({ ...PHIDIAS_50K, dailyLossCap: 1_250, dailyLossCapSource: 'internal' });
    const ids = r.findings.map((x) => x.id);
    expect(ids).not.toContain('eval_expiry_unreachable');
    expect(ids).not.toContain('eval_expiry_tight');
  });
});
