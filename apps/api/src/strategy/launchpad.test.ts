import { describe, it, expect } from 'vitest';
import {
  consistencyStatus,
  qualifyingDays,
  payoutEligibility,
  PayoutRules,
  DailyPnl,
  APEX_EOD_PAYOUT_SCHEDULES,
  APEX_EOD_QUALIFYING_THRESHOLDS,
  splitForPayout,
  scheduledAmountFor,
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

describe('progressive profit splits', () => {
  const PREMIUM_SPLITS = [0.75, 0.8, 0.85, 0.9, 1.0];

  it('returns the rate for each payout number', () => {
    expect(splitForPayout(1, PREMIUM_SPLITS)).toBe(0.75);
    expect(splitForPayout(3, PREMIUM_SPLITS)).toBe(0.85);
    expect(splitForPayout(5, PREMIUM_SPLITS)).toBe(1.0);
  });

  it('holds the final rate forever rather than falling back to the first', () => {
    // The failure that matters: a mature Premium account dropping to 75% at
    // exactly the point it starts keeping everything.
    expect(splitForPayout(6, PREMIUM_SPLITS)).toBe(1.0);
    expect(splitForPayout(50, PREMIUM_SPLITS)).toBe(1.0);
  });

  it('falls back to the flat split when there is no schedule', () => {
    expect(splitForPayout(3, null, 0.8)).toBe(0.8);
    expect(splitForPayout(3, [], 0.8)).toBe(0.8);
    expect(splitForPayout(3, undefined)).toBe(1);
  });
});

describe('repeating payout schedules', () => {
  it('runs out on a finite schedule — an Apex PA closes', () => {
    const apex = [1500, 1500, 2000, 2500, 2500, 3000];
    expect(scheduledAmountFor(6, apex)).toBe(3000);
    expect(scheduledAmountFor(7, apex)).toBeNull();
  });

  it('keeps paying the last cap when the schedule repeats', () => {
    // Phidias: $2,000 per cycle, the CASH account does not close.
    expect(scheduledAmountFor(1, [2000], true)).toBe(2000);
    expect(scheduledAmountFor(99, [2000], true)).toBe(2000);
  });

  it('rejects nonsense payout numbers', () => {
    expect(scheduledAmountFor(0, [2000], true)).toBeNull();
    expect(scheduledAmountFor(1, [], true)).toBeNull();
  });
});

describe('payoutEligibility — net amount after split', () => {
  const profitable = (n: number, perDay: number) =>
    Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, pnl: perDay }));

  const phidiasPremium = {
    qualifyingDayThreshold: 150,
    requiredQualifyingDays: 5,
    safetyNetBalance: 50_100,
    minPayout: 500,
    consistencyPct: 30,
    payoutSchedule: [2000],
    payoutScheduleRepeats: true,
    splitSchedule: [0.75, 0.8, 0.85, 0.9, 1.0],
    profitSplit: 0.75,
  };

  it('applies the first-payout split to the requestable amount', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: profitable(8, 400),
      currentBalance: 53_200,
      payoutsAlreadyTaken: 0,
      rules: phidiasPremium,
    });
    expect(r.eligible).toBe(true);
    expect(r.requestableAmount).toBe(2000);
    expect(r.splitPct).toBe(0.75);
    expect(r.netAmount).toBe(1500);
  });

  it('pays the full amount once the split reaches 100%', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: profitable(8, 400),
      currentBalance: 53_200,
      payoutsAlreadyTaken: 6,
      rules: phidiasPremium,
    });
    expect(r.splitPct).toBe(1.0);
    expect(r.netAmount).toBe(2000);
  });

  it('does not close a repeating account after the schedule length', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: profitable(8, 400),
      currentBalance: 53_200,
      payoutsAlreadyTaken: 20,
      rules: phidiasPremium,
    });
    expect(r.payoutNumber).toBe(21);
    expect(r.isFinalPayout).toBe(false);
    expect(r.blockers.map((b) => b.reason)).not.toContain('all_payouts_taken');
  });

  it('still closes an Apex PA after its sixth payout', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: profitable(8, 400),
      currentBalance: 53_200,
      payoutsAlreadyTaken: 6,
      rules: { ...phidiasPremium, payoutSchedule: [1500, 1500, 2000, 2500, 2500, 3000],
               payoutScheduleRepeats: false, splitSchedule: null, profitSplit: 1 },
    });
    expect(r.payoutNumber).toBeNull();
    expect(r.blockers.map((b) => b.reason)).toContain('all_payouts_taken');
  });

  it('nets to the full amount on a 100% flat split (Apex)', () => {
    const r = payoutEligibility({
      daysSinceLastPayout: profitable(8, 400),
      currentBalance: 53_200,
      payoutsAlreadyTaken: 0,
      rules: { ...phidiasPremium, payoutSchedule: [1500], payoutScheduleRepeats: false,
               splitSchedule: null, profitSplit: 1, consistencyPct: 50 },
    });
    expect(r.splitPct).toBe(1);
    expect(r.netAmount).toBe(r.requestableAmount);
  });
});
