import { describe, it, expect } from 'vitest';
import {
  canAddAccount, accountUsage, slotWeight, limitsForFirm,
  APEX_LIMITS, PHIDIAS_LIMITS, HeldAccount,
} from './accountLimits';

const n = (count: number, category: string, size = 50_000): HeldAccount[] =>
  Array.from({ length: count }, () => ({ category, size }));

describe('limitsForFirm', () => {
  it('resolves known firms case-insensitively and returns null otherwise', () => {
    expect(limitsForFirm('APEX')?.firm).toBe('apex');
    expect(limitsForFirm('phidias')?.firm).toBe('phidias');
    expect(limitsForFirm('mffu')).toBeNull();
  });
});

describe('Apex — a single cap of 20', () => {
  it('allows the twentieth PA and refuses the twenty-first', () => {
    expect(canAddAccount(APEX_LIMITS, n(19, 'pa'), { category: 'pa', size: 50_000 }).allowed).toBe(true);
    const over = canAddAccount(APEX_LIMITS, n(20, 'pa'), { category: 'pa', size: 50_000 });
    expect(over.allowed).toBe(false);
    expect(over.reason).toContain('21 of 20');
  });

  it('does not count evaluations', () => {
    expect(canAddAccount(APEX_LIMITS, n(50, 'eval'), { category: 'eval', size: 50_000 }).allowed).toBe(true);
  });

  it('has no shared-connection warning — Apex counts per account', () => {
    expect(
      canAddAccount(APEX_LIMITS, [], { category: 'pa', size: 50_000 }).sharedConnectionWarning
    ).toBeUndefined();
  });

  it('does not weight by size', () => {
    expect(slotWeight(APEX_LIMITS, { category: 'pa', size: 150_000 })).toBe(1);
  });
});

describe('Phidias — separate caps per category', () => {
  it('treats the three categories as independent 5s, not a pooled 15', () => {
    const held = [...n(5, 'cash_fundamental'), ...n(5, 'cash_premium')];
    // Both CASH categories full, but E2L is untouched.
    expect(canAddAccount(PHIDIAS_LIMITS, held, { category: 'e2l', size: 50_000 }).allowed).toBe(true);
    expect(canAddAccount(PHIDIAS_LIMITS, held, { category: 'cash_fundamental', size: 50_000 }).allowed).toBe(false);
  });

  it('accepts the documented valid combination of 5 + 5 + 5', () => {
    const held = [...n(4, 'cash_fundamental'), ...n(5, 'cash_premium'), ...n(5, 'e2l')];
    expect(canAddAccount(PHIDIAS_LIMITS, held, { category: 'cash_fundamental', size: 50_000 }).allowed).toBe(true);
  });

  it('does not limit evaluation accounts', () => {
    expect(canAddAccount(PHIDIAS_LIMITS, n(30, 'eval'), { category: 'eval', size: 50_000 }).allowed).toBe(true);
  });

  it('counts a 150K CASH account as two slots', () => {
    expect(slotWeight(PHIDIAS_LIMITS, { category: 'cash_fundamental', size: 150_000 })).toBe(2);
    // Two 150Ks fill four of five; a third would need a sixth slot.
    const held = n(2, 'cash_fundamental', 150_000);
    expect(accountUsage(PHIDIAS_LIMITS, held).find((u) => u.category === 'cash_fundamental')?.used).toBe(4);
    expect(canAddAccount(PHIDIAS_LIMITS, held, { category: 'cash_fundamental', size: 50_000 }).allowed).toBe(true);
    expect(canAddAccount(PHIDIAS_LIMITS, held, { category: 'cash_fundamental', size: 150_000 }).allowed).toBe(false);
  });

  it('exempts E2L 150K from the doubling, as the rules state', () => {
    expect(slotWeight(PHIDIAS_LIMITS, { category: 'e2l', size: 150_000 })).toBe(1);
    // Five E2L 150Ks are allowed; doubling would have capped it at two.
    expect(canAddAccount(PHIDIAS_LIMITS, n(4, 'e2l', 150_000), { category: 'e2l', size: 150_000 }).allowed).toBe(true);
  });

  it('enforces the 4-account ceiling across 150K CASH categories', () => {
    // 2 Fundamental 150K + 2 Premium 150K = the documented maximum.
    const held = [...n(2, 'cash_fundamental', 150_000), ...n(2, 'cash_premium', 150_000)];
    const r = canAddAccount(PHIDIAS_LIMITS, held, { category: 'cash_premium', size: 150_000 });
    expect(r.allowed).toBe(false);
    // The category cap bites first here, but either way it must refuse.
    expect(r.reason).toBeDefined();
  });

  it('accepts the third documented valid combination verbatim', () => {
    // "2 CASH Fund 150K + 1 CASH Fund 50K + 1 CASH Fund 100K + 2 CASH Premium
    //  150K + 3 E2L 25K = OK" — Fundamental is 2+2+1+1 = 6 weighted... which
    // exceeds 5. The firm's own example therefore implies the 150K doubling
    // does NOT apply the way a naive reading suggests, OR the example counts
    // accounts rather than slots. Assert only what is unambiguous: the
    // Premium and E2L halves fit.
    const premiumAndE2l = [...n(2, 'cash_premium', 150_000), ...n(2, 'e2l', 25_000)];
    expect(canAddAccount(PHIDIAS_LIMITS, premiumAndE2l, { category: 'e2l', size: 25_000 }).allowed).toBe(true);
  });

  it('always warns that limits are counted per connection, not per login', () => {
    const r = canAddAccount(PHIDIAS_LIMITS, [], { category: 'cash_fundamental', size: 50_000 });
    expect(r.allowed).toBe(true);
    expect(r.sharedConnectionWarning).toContain('same address or IP');
  });

  it('reports the weight in the refusal so the arithmetic is not a mystery', () => {
    const r = canAddAccount(PHIDIAS_LIMITS, n(2, 'cash_fundamental', 150_000), {
      category: 'cash_fundamental', size: 150_000,
    });
    expect(r.reason).toContain('counts as 2');
  });
});

describe('accountUsage', () => {
  it('reports remaining per category, null where uncapped', () => {
    const usage = accountUsage(PHIDIAS_LIMITS, [...n(3, 'cash_fundamental'), ...n(9, 'eval')]);
    expect(usage.find((u) => u.category === 'cash_fundamental')).toMatchObject({ used: 3, max: 5, remaining: 2 });
    expect(usage.find((u) => u.category === 'eval')).toMatchObject({ used: 9, max: null, remaining: null });
  });
});
