import { describe, it, expect } from 'vitest';
import {
  consistencyStatus,
  qualifyingDays,
  payoutEligibility,
  PayoutRules,
  DailyPnl,
  APEX_EOD_PAYOUT_SCHEDULES,
  APEX_EOD_QUALIFYING_THRESHOLDS,
} from './launchpad';

/** Apex 50K EOD PA, verified from the firm's payout page. */
const APEX_50K: PayoutRules = {
  qualifyingDayThreshold: 250,
  requiredQualifyingDays: 5,
  safetyNetBalance: 52100,
  minPayout: 500,
  consistencyPct: 50,
  payoutSchedule: APEX_EOD_PAYOUT_SCHEDULES[50000],
};

const day = (dayKey: string, pnl: number): DailyPnl => ({ dayKey, pnl });

/** Five days that each clear $250 and stay inside the consistency limit. */
const FIVE_GOOD_DAYS: DailyPnl[] = [
  day('2026-09-01', 400), day('2026-09-02', 350), day('2026-09-03', 500),
  day('2026-09-04', 300), day('2026-09-05', 450),
];

describe('qualifyingDays', () => {
  it('counts only days at or above the threshold', () => {
    const days = [day('a', 250), day('b', 249), day('c', 1000), day('d', -400), day('e', 0)];
    expect(qualifyingDays(days, 250).map((d) => d.dayKey)).toEqual(['a', 'c']);
  });

  it('treats the threshold as inclusive', () => {
    expect(qualifyingDays([day('a', 250)], 250)).toHaveLength(1);
  });

  it('a profitable-but-small day does not count', () => {
    // $83.50 is a partial-win day at step 1 — green, but not a qualifying day.
    expect(qualifyingDays([day('a', 83.5)], 250)).toHaveLength(0);
  });
});

describe('consistencyStatus', () => {
  it('reproduces the firm\'s worked example: a $1,500 day needs $3,000 total', () => {
    const s = consistencyStatus([day('a', 1500)], 50);
    expect(s.minTotalRequired).toBe(3000);
    expect(s.ok).toBe(false);
    expect(s.shortfall).toBe(1500);
  });

  it('passes once the best day is under half the total', () => {
    const s = consistencyStatus([day('a', 1500), day('b', 900), day('c', 700)], 50);
    expect(s.totalProfit).toBe(3100);
    expect(s.ok).toBe(true);
    expect(s.shortfall).toBe(0);
  });

  it('sits exactly on the boundary at 50%', () => {
    const s = consistencyStatus([day('a', 1000), day('b', 1000)], 50);
    expect(s.ratio).toBe(0.5);
    expect(s.ok).toBe(true);
  });

  it('a LOSING day makes consistency harder, not easier', () => {
    // The loss shrinks the total while the best day is unchanged, so the best
    // day's share rises. This is the counter-intuitive one.
    // Best day 1200 needs 2400 total. 2700 clears it; a -600 day drops the
    // total to 2100 and it no longer does.
    const before = consistencyStatus([day('a', 1000), day('b', 1200), day('c', 500)], 50);
    const after = consistencyStatus(
      [day('a', 1000), day('b', 1200), day('c', 500), day('d', -600)], 50
    );
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
    expect(after.totalProfit).toBeLessThan(before.totalProfit);
    expect(after.largestDay).toBe(before.largestDay);
  });

  it('is satisfied when nothing profitable has happened yet', () => {
    expect(consistencyStatus([day('a', -100)], 50).ok).toBe(true);
    expect(consistencyStatus([], 50).ok).toBe(true);
  });

  it('is disabled at 0%', () => {
    const s = consistencyStatus([day('a', 5000), day('b', 10)], 0);
    expect(s.ok).toBe(true);
    expect(s.minTotalRequired).toBe(0);
  });
});

describe('payoutEligibility — the happy path', () => {
  it('clears when days, balance and consistency all pass', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS,
      currentBalance: 54000,
      payoutsAlreadyTaken: 0,
      rules: APEX_50K,
    });
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.payoutNumber).toBe(1);
    expect(r.scheduledAmount).toBe(1500);
  });

  it('caps the request at the scheduled amount, not all profit above the net', () => {
    // $54,000 leaves $1,900 above the safety net, but payout #1 caps at $1,500.
    const r = payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS,
      currentBalance: 54000,
      payoutsAlreadyTaken: 0,
      rules: APEX_50K,
    });
    expect(r.requestableAmount).toBe(1500);
  });

  it('caps at eligible profit when that is the smaller of the two', () => {
    // $53,000 leaves only $900 above the safety net.
    const r = payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS,
      currentBalance: 53000,
      payoutsAlreadyTaken: 0,
      rules: APEX_50K,
    });
    expect(r.eligible).toBe(true);
    expect(r.requestableAmount).toBe(900);
  });

  it('walks the schedule as payouts are taken', () => {
    const amounts = [0, 1, 2, 3, 4, 5].map(
      (taken) =>
        payoutEligibility({
          daysSinceLastPayout: FIVE_GOOD_DAYS,
          currentBalance: 56000,
          payoutsAlreadyTaken: taken,
          rules: APEX_50K,
        }).scheduledAmount
    );
    expect(amounts).toEqual([1500, 1500, 2000, 2500, 2500, 3000]);
    expect(amounts.reduce((a, b) => a! + b!, 0)).toBe(13000);
  });

  it('flags the sixth as final — the account closes after it', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS, currentBalance: 56000,
      payoutsAlreadyTaken: 5, rules: APEX_50K,
    });
    expect(r.isFinalPayout).toBe(true);
    expect(payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS, currentBalance: 56000,
      payoutsAlreadyTaken: 0, rules: APEX_50K,
    }).isFinalPayout).toBe(false);
  });
});

describe('payoutEligibility — blockers', () => {
  it('blocks on too few qualifying days and says how many are missing', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: [day('a', 400), day('b', 300)],
      currentBalance: 54000, payoutsAlreadyTaken: 0, rules: APEX_50K,
    });
    expect(r.eligible).toBe(false);
    expect(r.daysStillNeeded).toBe(3);
    expect(r.blockers.find((b) => b.reason === 'insufficient_qualifying_days')?.shortfall).toBe(3);
  });

  it('blocks below the request threshold and says by how much', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS,
      currentBalance: 52300, payoutsAlreadyTaken: 0, rules: APEX_50K,
    });
    // Needs 52,100 + 500 = 52,600
    const b = r.blockers.find((x) => x.reason === 'below_safety_net');
    expect(b?.shortfall).toBe(300);
  });

  it('blocks on consistency even when everything else passes', () => {
    // One huge day plus four minimal qualifying days.
    const lopsided = [
      day('a', 5000), day('b', 250), day('c', 250), day('d', 250), day('e', 250),
    ];
    const r = payoutEligibility({
      daysSinceLastPayout: lopsided, currentBalance: 56000,
      payoutsAlreadyTaken: 0, rules: APEX_50K,
    });
    expect(r.qualifyingDayCount).toBe(5);
    expect(r.eligible).toBe(false);
    expect(r.blockers.map((b) => b.reason)).toEqual(['consistency']);
  });

  it('blocks once all six payouts are taken', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: FIVE_GOOD_DAYS, currentBalance: 60000,
      payoutsAlreadyTaken: 6, rules: APEX_50K,
    });
    expect(r.eligible).toBe(false);
    expect(r.payoutNumber).toBeNull();
    expect(r.scheduledAmount).toBeNull();
    expect(r.blockers.map((b) => b.reason)).toContain('all_payouts_taken');
  });

  it('reports EVERY unmet requirement, not just the first', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: [day('a', 3000)],
      currentBalance: 52200, payoutsAlreadyTaken: 0, rules: APEX_50K,
    });
    const reasons = r.blockers.map((b) => b.reason).sort();
    expect(reasons).toEqual(['below_safety_net', 'consistency', 'insufficient_qualifying_days']);
  });

  it('requests nothing while blocked, whatever the balance', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: [day('a', 400)],
      currentBalance: 90000, payoutsAlreadyTaken: 0, rules: APEX_50K,
    });
    expect(r.requestableAmount).toBe(0);
  });
});

describe('published Apex tables', () => {
  it('every schedule has exactly six payouts', () => {
    for (const size of [25000, 50000, 100000, 150000]) {
      expect(APEX_EOD_PAYOUT_SCHEDULES[size]).toHaveLength(6);
    }
  });

  it('the 50K cycle totals the documented $13,000', () => {
    expect(APEX_EOD_PAYOUT_SCHEDULES[50000].reduce((a, b) => a + b, 0)).toBe(13000);
  });

  it('qualifying thresholds match the firm\'s payout table', () => {
    expect(APEX_EOD_QUALIFYING_THRESHOLDS).toMatchObject({
      25000: 100, 50000: 250, 100000: 300, 150000: 350,
    });
  });
});
