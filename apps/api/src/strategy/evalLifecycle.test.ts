import { describe, it, expect } from 'vitest';
import {
  assessEval,
  staggerWarnings,
  daysBetween,
  addDays,
  EvalSnapshot,
  MIN_TRADING_DAYS_TO_PROJECT,
} from './evalLifecycle';

/** Apex 50K EOD eval bought Sept 1, expiring 30 calendar days later. */
const APEX_EVAL: EvalSnapshot = {
  outcome: 'in_progress',
  purchaseDate: '2026-09-01',
  expiresOn: '2026-10-01',
  passDate: null,
  activationDeadline: null,
  startBalance: 50000,
  targetProfit: 3000,
  maxDrawdown: 2000,
};

const assess = (over: Partial<Parameters<typeof assessEval>[0]> = {}) =>
  assessEval({
    snapshot: APEX_EVAL,
    currentBalance: 50000,
    today: '2026-09-11',
    tradingDaysObserved: 7,
    ...over,
  });

describe('date helpers', () => {
  it('counts whole days between dates', () => {
    expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30);
    expect(daysBetween('2026-10-01', '2026-09-01')).toBe(-30);
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
  });

  it('crosses a month boundary correctly', () => {
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
  });

  it('survives a DST transition without drifting a day', () => {
    // US DST ends 2026-11-01. UTC arithmetic must not lose an hour into a day.
    expect(daysBetween('2026-10-25', '2026-11-08')).toBe(14);
  });
});

describe('transitions', () => {
  it('passes when profit reaches target, and sets a 7-day activation deadline', () => {
    const r = assess({ currentBalance: 53000, today: '2026-09-20' });
    expect(r.outcome).toBe('passed');
    expect(r.changed).toBe(true);
    expect(r.daysToActivationDeadline).toBe(7);
    expect(r.reason).toMatch(/reached the \$3000 target/);
  });

  it('blows when the balance reaches the drawdown floor', () => {
    const r = assess({ currentBalance: 48000 });
    expect(r.outcome).toBe('blown');
    expect(r.urgency).toBe('lapsed');
  });

  it('blows on touching the floor exactly, not only below it', () => {
    expect(assess({ currentBalance: 48000 }).outcome).toBe('blown');
    expect(assess({ currentBalance: 48000.01 }).outcome).toBe('in_progress');
  });

  it('expires once past the window without reaching target', () => {
    const r = assess({ currentBalance: 51500, today: '2026-10-03' });
    expect(r.outcome).toBe('expired');
    expect(r.reason).toMatch(/2 day\(s\) ago/);
  });

  it('passing on the final day beats expiry, and still earns the full window', () => {
    // Both conditions true on the same day — passing must win.
    const r = assess({ currentBalance: 53000, today: '2026-10-01' });
    expect(r.outcome).toBe('passed');
    expect(r.daysToActivationDeadline).toBe(7);
  });

  it('blowing beats passing if the numbers somehow allow both', () => {
    const weird = { ...APEX_EVAL, targetProfit: 0 };
    expect(assess({ snapshot: weird, currentBalance: 47000 }).outcome).toBe('blown');
  });
});

describe('terminal outcomes are never revisited', () => {
  it('a passed eval stays passed even if the balance later collapses', () => {
    const passed: EvalSnapshot = {
      ...APEX_EVAL, outcome: 'passed', passDate: '2026-09-20',
      activationDeadline: '2026-09-27',
    };
    const r = assess({ snapshot: passed, currentBalance: 40000, today: '2026-09-22' });
    expect(r.outcome).toBe('passed');
    expect(r.changed).toBe(false);
  });

  it('counts down the activation deadline and escalates near it', () => {
    const passed: EvalSnapshot = {
      ...APEX_EVAL, outcome: 'passed', passDate: '2026-09-20',
      activationDeadline: '2026-09-27',
    };
    expect(assess({ snapshot: passed, today: '2026-09-22' }).urgency).toBe('watch');
    expect(assess({ snapshot: passed, today: '2026-09-26' }).urgency).toBe('critical');
  });

  it('flags a lapsed activation window as forfeited', () => {
    const passed: EvalSnapshot = {
      ...APEX_EVAL, outcome: 'passed', passDate: '2026-09-20',
      activationDeadline: '2026-09-27',
    };
    const r = assess({ snapshot: passed, today: '2026-09-30' });
    expect(r.urgency).toBe('lapsed');
    expect(r.notes.join(' ')).toMatch(/forfeited/);
  });
});

describe('projection — refuses to guess', () => {
  it('offers nothing below the minimum sample', () => {
    const r = assess({ currentBalance: 51000, tradingDaysObserved: MIN_TRADING_DAYS_TO_PROJECT - 1 });
    expect(r.daysToTargetAtRate).toBeNull();
    expect(r.projectionRange).toBeNull();
    expect(r.projectionBlockedBy).toBe('insufficient_sample');
    expect(r.onTrack).toBeNull();
    expect(r.notes.join(' ')).toMatch(/too few to project from/);
  });

  it('offers nothing when the account is flat or down', () => {
    expect(assess({ currentBalance: 50000 }).projectionBlockedBy).toBe('no_progress');
    expect(assess({ currentBalance: 49000 }).projectionBlockedBy).toBe('no_progress');
  });

  it('does not present a rate as a date on two good days', () => {
    // The trap: $500 over 2 days looks like $250/day and a confident estimate.
    const r = assess({ currentBalance: 50500, tradingDaysObserved: 2 });
    expect(r.ratePerTradingDay).toBe(250);
    expect(r.daysToTargetAtRate).toBeNull();
  });
});

describe('projection — units and honesty', () => {
  it('converts a trading-day rate into calendar days before comparing', () => {
    // $1,000 over 10 trading days = $100/trading day. $2,000 to go = 20 trading
    // days ≈ 28 calendar days, NOT 20.
    const r = assess({ currentBalance: 51000, tradingDaysObserved: 10, today: '2026-09-15' });
    expect(r.ratePerTradingDay).toBe(100);
    expect(r.daysToTargetAtRate).toBe(28);
  });

  it('brackets the estimate rather than claiming a single day', () => {
    const r = assess({ currentBalance: 51000, tradingDaysObserved: 10, today: '2026-09-15' });
    expect(r.projectionRange!.fast).toBeLessThan(r.daysToTargetAtRate!);
    expect(r.projectionRange!.slow).toBeGreaterThan(r.daysToTargetAtRate!);
  });

  it('judges on-track by the SLOW end, not the optimistic one', () => {
    // $1,235 over 10 trading days -> ~20 calendar days central, 12-28 range,
    // with 20 days left. The fast end fits and the slow end does not, so this
    // is exactly the case where picking the optimistic bound would mislead.
    const r = assess({ currentBalance: 51235, tradingDaysObserved: 10, today: '2026-09-11' });
    expect(r.daysRemaining).toBe(20);
    expect(r.projectionRange!.fast).toBeLessThanOrEqual(20);
    expect(r.projectionRange!.slow).toBeGreaterThan(20);
    expect(r.onTrack).toBe(false);
  });

  it('is on track when even the slow end fits inside the window', () => {
    // $2,500 in 5 trading days = $500/day; $500 to go is well under a week.
    const r = assess({ currentBalance: 52500, tradingDaysObserved: 5, today: '2026-09-08' });
    expect(r.onTrack).toBe(true);
    expect(r.urgency).toBe('ok');
  });

  it('says so plainly when the pace will not get there', () => {
    const r = assess({ currentBalance: 51000, tradingDaysObserved: 10, today: '2026-09-15' });
    expect(r.notes.join(' ')).toMatch(/does not reach target on the current pace/);
  });
});

describe('urgency', () => {
  it('escalates to critical inside the last three days', () => {
    const r = assess({ currentBalance: 52000, tradingDaysObserved: 12, today: '2026-09-29' });
    expect(r.urgency).toBe('critical');
  });

  it('escalates when off pace with a week or less left', () => {
    const r = assess({ currentBalance: 51000, tradingDaysObserved: 10, today: '2026-09-26' });
    expect(r.urgency).toBe('critical');
  });

  it('stays calm early on a healthy eval', () => {
    const r = assess({ currentBalance: 52000, tradingDaysObserved: 6, today: '2026-09-08' });
    expect(r.urgency).toBe('ok');
  });
});

describe('staggerWarnings', () => {
  it('flags a five-pack all starting the same day', () => {
    const w = staggerWarnings(Array(5).fill('2026-09-15'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/5 evaluations start on 2026-09-15/);
    expect(w[0]).toMatch(/hits every one at once/);
  });

  it('flags starts closer together than the target gap', () => {
    const w = staggerWarnings(['2026-09-01', '2026-09-04']);
    expect(w[0]).toMatch(/3 day\(s\) apart/);
  });

  it('is quiet when properly staggered', () => {
    expect(staggerWarnings(['2026-09-01', '2026-09-08', '2026-09-15'])).toEqual([]);
  });

  it('does not care what order the dates arrive in', () => {
    expect(staggerWarnings(['2026-09-15', '2026-09-01', '2026-09-08'])).toEqual([]);
  });

  it('has nothing to say about a single eval', () => {
    expect(staggerWarnings(['2026-09-01'])).toEqual([]);
  });
});
