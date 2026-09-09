import { describe, it, expect } from 'vitest';
import {
  reconcileRules,
  shouldBlockTrade,
  ReconcileInput,
  PresetAssumptions,
} from './ruleReconciler';

const NOW = new Date('2026-09-08T12:00:00Z');

const APEX_50K: PresetAssumptions = {
  id: 'apex_50k_eod_eval',
  startBalance: 50000,
  maxDrawdown: 2000,
  dailyLossCap: 1000,
  phase: 'eval',
  verifiedAt: new Date('2026-09-01T00:00:00Z'),
  staleAfterDays: 90,
};

/** A clean account: balance matches, no drift, plenty of drawdown room. */
function healthy(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    snapshot: { cashBalance: 50000, realizedPnl: 0, equity: 50000 },
    tracked: { dayRealizedPnl: 0, cumulativePnl: 0, ladderStep: 1 },
    preset: APEX_50K,
    now: NOW,
    ...over,
  };
}

const ids = (r: ReturnType<typeof reconcileRules>) => r.findings.map((f) => f.id);

describe('reconcileRules — healthy account', () => {
  it('returns ok with no findings', () => {
    const r = reconcileRules(healthy());
    expect(r.verdict).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  it('backs out the implied account size from equity and cumulative P&L', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 52000, realizedPnl: 0, equity: 52000 },
        tracked: { dayRealizedPnl: 0, cumulativePnl: 2000, ladderStep: 1 },
      })
    );
    expect(r.impliedStart).toBe(50000);
    expect(r.verdict).toBe('ok');
  });
});

describe('reconcileRules — wrong preset assigned', () => {
  it('halts when a 50K preset sits on a 100K account', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 100000, realizedPnl: 0, equity: 100000 },
        tracked: { dayRealizedPnl: 0, cumulativePnl: 0, ladderStep: 1 },
      })
    );
    expect(r.verdict).toBe('halt');
    expect(ids(r)).toContain('preset_size_mismatch');
  });

  it('halts when a 100K preset sits on a 50K account (the dangerous direction)', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 50000, realizedPnl: 0, equity: 50000 },
        preset: { ...APEX_50K, startBalance: 100000, maxDrawdown: 3000 },
      })
    );
    expect(r.verdict).toBe('halt');
    expect(ids(r)).toContain('preset_size_mismatch');
  });

  it('catches an exactly-2x and exactly-half mismatch, not just approximate ones', () => {
    // Regression: bounds of [0.5, 2.0] with exclusive comparison let the two
    // likeliest real misassignments through on the boundary itself.
    for (const [balance, start] of [[100000, 50000], [50000, 100000], [25000, 50000]]) {
      const r = reconcileRules(
        healthy({
          snapshot: { cashBalance: balance, realizedPnl: 0, equity: balance },
          preset: { ...APEX_50K, startBalance: start },
        })
      );
      expect(ids(r)).toContain('preset_size_mismatch');
      expect(r.verdict).toBe('halt');
    }
  });

  it('tolerates normal profit and drawdown without crying mismatch', () => {
    for (const balance of [47000, 50000, 53000, 62000]) {
      const r = reconcileRules(
        healthy({
          snapshot: { cashBalance: balance, realizedPnl: 0, equity: balance },
          tracked: { dayRealizedPnl: 0, cumulativePnl: balance - 50000, ladderStep: 1 },
        })
      );
      expect(ids(r)).not.toContain('preset_size_mismatch');
    }
  });
});

describe('reconcileRules — day P&L drift', () => {
  it('halts on drift large enough to corrupt the DLL gate', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 49400, realizedPnl: -600, equity: 49400 },
        tracked: { dayRealizedPnl: -200, cumulativePnl: -600, ladderStep: 2 },
      })
    );
    expect(r.verdict).toBe('halt');
    expect(ids(r)).toContain('day_pnl_drift_halt');
  });

  it('warns but keeps trading on commission-sized drift', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 49988, realizedPnl: -12, equity: 49988 },
        tracked: { dayRealizedPnl: 0, cumulativePnl: -12, ladderStep: 1 },
      })
    );
    expect(r.verdict).toBe('warn');
    expect(ids(r)).toContain('day_pnl_drift');
    expect(ids(r)).not.toContain('day_pnl_drift_halt');
  });

  it('ignores drift under the warn tolerance', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 49998, realizedPnl: -2, equity: 49998 },
        tracked: { dayRealizedPnl: 0, cumulativePnl: -2, ladderStep: 1 },
      })
    );
    expect(ids(r)).not.toContain('day_pnl_drift');
  });

  it('honours overridden tolerances', () => {
    const drifting = healthy({
      snapshot: { cashBalance: 49988, realizedPnl: -12, equity: 49988 },
      tracked: { dayRealizedPnl: 0, cumulativePnl: -12, ladderStep: 1 },
      tolerances: { dayPnlHalt: 10 },
    });
    expect(reconcileRules(drifting).verdict).toBe('halt');
  });
});

describe('reconcileRules — drawdown', () => {
  it('halts once equity reaches the drawdown floor', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 48000, realizedPnl: -500, equity: 48000 },
        tracked: { dayRealizedPnl: -500, cumulativePnl: -2000, ladderStep: 3 },
      })
    );
    expect(r.verdict).toBe('halt');
    expect(ids(r)).toContain('drawdown_breached');
  });

  it('warns when less than one daily cap of room remains', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 48500, realizedPnl: -200, equity: 48500 },
        tracked: { dayRealizedPnl: -200, cumulativePnl: -1500, ladderStep: 2 },
      })
    );
    expect(ids(r)).toContain('drawdown_within_one_day');
    expect(ids(r)).not.toContain('drawdown_breached');
  });
});

describe('reconcileRules — trailing drawdown floor', () => {
  const TRAILING: PresetAssumptions = { ...APEX_50K, ddMode: 'eod_trailing', safetyNetBuffer: 100 };

  it('halts on an equity a static floor would have called healthy', () => {
    // The account closed a day at 51,000, so its real floor is 49,000. Equity
    // 48,900 is dead. The static model saw a 48,000 floor and $900 of room.
    const input = {
      snapshot: { cashBalance: 48900, realizedPnl: -600, equity: 48900 },
      tracked: {
        dayRealizedPnl: -600, cumulativePnl: -1100, ladderStep: 3,
        eodBalances: [51000], historyComplete: true,
      },
    };
    expect(reconcileRules(healthy({ ...input, preset: TRAILING })).verdict).toBe('halt');
    expect(ids(reconcileRules(healthy({ ...input, preset: TRAILING })))).toContain('drawdown_breached');

    // Same numbers, static preset: not a halt. This difference is the bug.
    expect(reconcileRules(healthy({ ...input, preset: APEX_50K })).verdict).not.toBe('halt');
  });

  it('says the floor trailed, so the message is not confusing', () => {
    const r = reconcileRules(
      healthy({
        preset: TRAILING,
        snapshot: { cashBalance: 48900, realizedPnl: 0, equity: 48900 },
        tracked: { dayRealizedPnl: 0, cumulativePnl: -1100, ladderStep: 1, eodBalances: [51000] },
      })
    );
    const finding = r.findings.find((f) => f.id === 'drawdown_breached');
    expect(finding?.message).toContain('trailed up from $48000');
    expect(finding?.detail?.highWater).toBe(51000);
  });

  it('does not halt a profitable account whose floor has locked', () => {
    const r = reconcileRules(
      healthy({
        preset: TRAILING,
        snapshot: { cashBalance: 52500, realizedPnl: 0, equity: 52500 },
        tracked: {
          dayRealizedPnl: 0, cumulativePnl: 2500, ladderStep: 1,
          eodBalances: [52100, 52500], historyComplete: true,
        },
      })
    );
    // Floor locked at 50,100 — $2,400 of room, so no drawdown finding at all.
    expect(ids(r)).not.toContain('drawdown_breached');
    expect(ids(r)).not.toContain('drawdown_within_one_day');
  });

  it('warns when the floor came from incomplete history', () => {
    const r = reconcileRules(
      healthy({
        preset: TRAILING,
        snapshot: { cashBalance: 50800, realizedPnl: 0, equity: 50800 },
        tracked: {
          dayRealizedPnl: 0, cumulativePnl: 800, ladderStep: 1,
          eodBalances: [50800], historyComplete: false,
        },
      })
    );
    expect(ids(r)).toContain('drawdown_floor_understated');
    expect(r.verdict).toBe('warn');
  });

  it('leaves a brand-new account at its initial floor', () => {
    const r = reconcileRules(healthy({ preset: TRAILING, tracked: {
      dayRealizedPnl: 0, cumulativePnl: 0, ladderStep: 1, eodBalances: [], historyComplete: true,
    } }));
    expect(r.verdict).toBe('ok');
  });
});

describe('reconcileRules — inactivity', () => {
  // Apex lists "Inactivity Policy: YES" on both eval and PA accounts, so an
  // idle account can be closed. The threshold is per-preset because Apex's
  // pricing page does not state the window.
  const WITH_POLICY = { ...APEX_50K, inactivityAlertDays: 7 };

  it('warns once an account has been idle past the threshold', () => {
    const r = reconcileRules(healthy({ preset: WITH_POLICY, daysSinceLastTrade: 9 }));
    expect(ids(r)).toContain('account_inactive');
    expect(r.verdict).toBe('warn');
  });

  it('stays quiet inside the threshold', () => {
    const r = reconcileRules(healthy({ preset: WITH_POLICY, daysSinceLastTrade: 3 }));
    expect(ids(r)).not.toContain('account_inactive');
  });

  it('never halts — the remedy for an idle account is to trade it', () => {
    const r = reconcileRules(healthy({ preset: WITH_POLICY, daysSinceLastTrade: 400 }));
    expect(r.verdict).toBe('warn');
  });

  it('falls back to account age when the account has never traded', () => {
    const r = reconcileRules(
      healthy({ preset: WITH_POLICY, daysSinceLastTrade: null, accountAgeDays: 20 })
    );
    expect(ids(r)).toContain('never_traded');
    expect(r.findings.find((f) => f.id === 'never_traded')!.message).toMatch(/never placed a trade/);
  });

  it('does not flag a never-traded account that is still new', () => {
    const r = reconcileRules(
      healthy({ preset: WITH_POLICY, daysSinceLastTrade: null, accountAgeDays: 2 })
    );
    expect(ids(r)).not.toContain('never_traded');
  });

  it('is disabled when the preset sets no threshold', () => {
    const r = reconcileRules(healthy({ daysSinceLastTrade: 400 }));
    expect(ids(r)).not.toContain('account_inactive');
  });

  it('skips the check when idle time is unknown', () => {
    const r = reconcileRules(healthy({ preset: WITH_POLICY }));
    expect(ids(r)).not.toContain('account_inactive');
    expect(ids(r)).not.toContain('never_traded');
  });
});

describe('reconcileRules — preset verification age', () => {
  it('warns, but never halts, when a preset was never verified', () => {
    const r = reconcileRules(healthy({ preset: { ...APEX_50K, verifiedAt: null } }));
    expect(ids(r)).toContain('preset_never_verified');
    expect(r.verdict).toBe('warn');
  });

  it('warns when verification is older than the staleness window', () => {
    const r = reconcileRules(
      healthy({ preset: { ...APEX_50K, verifiedAt: new Date('2026-01-01T00:00:00Z') } })
    );
    expect(ids(r)).toContain('preset_stale');
    expect(r.verdict).toBe('warn');
  });

  it('stays quiet inside the staleness window', () => {
    const r = reconcileRules(healthy());
    expect(ids(r)).not.toContain('preset_stale');
  });

  it('never escalates staleness to a halt on its own', () => {
    const r = reconcileRules(
      healthy({
        preset: { ...APEX_50K, verifiedAt: new Date('2020-01-01T00:00:00Z'), staleAfterDays: 1 },
      })
    );
    expect(r.verdict).toBe('warn');
  });
});

describe('reconcileRules — verdict escalation', () => {
  it('reports the worst severity across several simultaneous findings', () => {
    const r = reconcileRules(
      healthy({
        snapshot: { cashBalance: 100000, realizedPnl: -600, equity: 100000 },
        tracked: { dayRealizedPnl: 0, cumulativePnl: 0, ladderStep: 1 },
        preset: { ...APEX_50K, verifiedAt: null },
      })
    );
    expect(r.verdict).toBe('halt');
    expect(ids(r)).toEqual(
      expect.arrayContaining(['preset_size_mismatch', 'day_pnl_drift_halt', 'preset_never_verified'])
    );
  });
});

describe('shouldBlockTrade', () => {
  it('blocks on a halt verdict', () => {
    const r = shouldBlockTrade({ verdict: 'halt', checkedAt: NOW });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('rule_reconciliation_halt');
  });

  it('allows on warn — a warning is information, not a stop', () => {
    expect(shouldBlockTrade({ verdict: 'warn', checkedAt: NOW }).blocked).toBe(false);
  });

  it('fails open when no check has ever run', () => {
    expect(shouldBlockTrade(null).blocked).toBe(false);
    expect(shouldBlockTrade({ verdict: null, checkedAt: null }).blocked).toBe(false);
  });

  it('fails open on an old check rather than stalling a working fleet', () => {
    const old = new Date(NOW.getTime() - 30 * 86_400_000);
    expect(shouldBlockTrade({ verdict: 'ok', checkedAt: old }).blocked).toBe(false);
  });
});
