import { describe, it, expect } from 'vitest';
import { rootSymbol, getInstrument, roundToTick, dollarsToPoints } from './instruments';
import { drawdownState } from './drawdown';
import { stepRisk, nextStep, classifyOutcome, clampStep } from './ladder';
import { contractsFor, splitGroups, computeLevels, realizedPnl, avgPrice } from './sizing';
import { getSession, brokerDayKey, etParts, toDayKey } from './sessions';
import {
  checkGate, resetIfNewDay, dllHeadroom, AccountDayState,
  remainingTarget, isSniperEligible, sniperRisk, checkSniperGate,
} from './gate';

// ------------------------------------------------------------------
// instruments
// ------------------------------------------------------------------
describe('instruments', () => {
  it('extracts roots from TradingView and Tradovate symbol forms', () => {
    expect(rootSymbol('MNQ1!')).toBe('MNQ');
    expect(rootSymbol('MNQM6')).toBe('MNQ');
    expect(rootSymbol('ESU6')).toBe('ES');
    expect(rootSymbol('M2KZ6')).toBe('M2K');
    expect(rootSymbol('mnq')).toBe('MNQ');
    expect(rootSymbol('AAPL')).toBe('AAPL');
  });

  it('knows MNQ tick economics', () => {
    const mnq = getInstrument('MNQ1!')!;
    expect(mnq.tickSize).toBe(0.25);
    expect(mnq.pointValue).toBe(2);
    expect(getInstrument('ZZZ')).toBeNull();
  });

  it('rounds to tick without float drift', () => {
    expect(roundToTick(29526.499999, 0.25)).toBe(29526.5);
    expect(roundToTick(29526.37, 0.25)).toBe(29526.25);
    expect(roundToTick(29526.38, 0.25)).toBe(29526.5);
    expect(roundToTick(2345.67, 0.1)).toBe(2345.7);
    expect(roundToTick(41000.4, 1)).toBe(41000);
  });

  it('converts dollars to points for a leg', () => {
    // $334 SL on 2 MNQ ($2/pt) = 83.5 pts
    expect(dollarsToPoints(334, 2, getInstrument('MNQ')!)).toBe(83.5);
    expect(dollarsToPoints(334, 0, getInstrument('MNQ')!)).toBe(0);
  });
});

// ------------------------------------------------------------------
// ladder
// ------------------------------------------------------------------
describe('ladder', () => {
  it('scales base risk per step using the default multipliers: 1x, 1x, 2x, 4x', () => {
    expect(stepRisk(334, 1)).toBe(334);
    expect(stepRisk(334, 2)).toBe(334);
    expect(stepRisk(334, 3)).toBe(668);
    expect(stepRisk(334, 4, { capStep: 4 })).toBe(1336);
  });

  it('caps at capStep', () => {
    expect(stepRisk(334, 4)).toBe(668); // capStep default 3 -> step 4 clamps to step 3's multiplier
    expect(clampStep(9, 3)).toBe(3);
    expect(clampStep(0)).toBe(1);
  });

  it('accepts per-preset multipliers (e.g. an intraday preset using 1/2/3/3)', () => {
    const multipliers = { step2: 2, step3: 3, step4: 3 };
    expect(stepRisk(167, 1, { multipliers })).toBe(167);
    expect(stepRisk(167, 2, { multipliers })).toBe(334);
    expect(stepRisk(167, 3, { multipliers, capStep: 4 })).toBe(501);
    expect(stepRisk(167, 4, { multipliers, capStep: 4 })).toBe(501);
  });

  it('caps step risk at the daily loss cap when provided', () => {
    expect(stepRisk(334, 3, { dailyLossCap: 500 })).toBe(500);
    expect(stepRisk(334, 2, { dailyLossCap: 500 })).toBe(334);
  });

  it('resets on any win, advances on loss, holds on BE', () => {
    expect(nextStep(3, 'W')).toBe(1);
    expect(nextStep(3, 'W~')).toBe(1);
    expect(nextStep(1, 'L')).toBe(2);
    expect(nextStep(2, 'L')).toBe(3);
    expect(nextStep(3, 'L')).toBe(3);
    expect(nextStep(3, 'L!')).toBe(3);
    expect(nextStep(2, 'BE')).toBe(2);
  });

  it('classifies outcomes', () => {
    expect(classifyOutcome({ pnl: 835, tp1Hit: true, tp2Hit: true })).toBe('W');
    expect(classifyOutcome({ pnl: 200, tp1Hit: true, tp2Hit: false })).toBe('W~');
    expect(classifyOutcome({ pnl: 0.5, tp1Hit: false, tp2Hit: false })).toBe('BE');
    expect(classifyOutcome({ pnl: -334, tp1Hit: false, tp2Hit: false })).toBe('L');
    expect(classifyOutcome({ pnl: -334, tp1Hit: false, tp2Hit: false, breachedDll: true })).toBe('L!');
  });
});

// ------------------------------------------------------------------
// sizing
// ------------------------------------------------------------------
describe('sizing', () => {
  it('sizes contracts from step risk and stop distance', () => {
    // $334 / (20 pts × $2) = 8.35 → 8
    expect(contractsFor(334, 20, 2, 60)).toBe(8);
    // $668 / (20 × 2) = 16.7 → 16
    expect(contractsFor(668, 20, 2, 60)).toBe(16);
    // cap
    expect(contractsFor(1002, 5, 2, 40)).toBe(40);
    // too wide a stop → 0
    expect(contractsFor(334, 200, 2, 60)).toBe(0);
    expect(contractsFor(334, 0, 2, 60)).toBe(0);
  });

  it('splits groups with the single-contract special case', () => {
    expect(splitGroups(4)).toEqual({ g1: 2, g2: 2 });
    expect(splitGroups(5)).toEqual({ g1: 2, g2: 3 });
    expect(splitGroups(1)).toEqual({ g1: 0, g2: 1 });
    expect(splitGroups(0)).toEqual({ g1: 0, g2: 0 });
  });

  it('computes long bracket levels rounded to tick', () => {
    const lv = computeLevels({ entry: 29526.5, direction: 'long', stopPts: 20, tickSize: 0.25 });
    expect(lv.sl).toBe(29506.5);
    expect(lv.tp1).toBe(29536.5);   // +10 (0.5R)
    expect(lv.tp2).toBe(29566.5);   // +40 (2.0R)
    expect(lv.be).toBe(29526.25);   // entry − 1 tick
  });

  it('computes short bracket levels mirrored', () => {
    const lv = computeLevels({ entry: 29526.5, direction: 'short', stopPts: 20, tickSize: 0.25 });
    expect(lv.sl).toBe(29546.5);
    expect(lv.tp1).toBe(29516.5);
    expect(lv.tp2).toBe(29486.5);
    expect(lv.be).toBe(29526.75);   // entry + 1 tick
  });

  it('respects custom R multiples and odd stop distances', () => {
    const lv = computeLevels({ entry: 100, direction: 'long', stopPts: 15.3, tickSize: 0.25, tp1R: 1, tp2R: 3 });
    expect(lv.sl).toBe(84.75);
    expect(lv.tp1).toBe(115.25);
    expect(lv.tp2).toBe(146);
  });

  it('computes realized P&L for the spec example (4 MNQ, 20pt stop, full win)', () => {
    // Group1 2 @ +10 pts, Group2 2 @ +40 pts → (20 + 80) × $2 = $200
    const pnl = realizedPnl({
      direction: 'long', entry: 29526.5, pointValue: 2,
      exits: [{ qty: 2, price: 29536.5 }, { qty: 2, price: 29566.5 }],
    });
    expect(pnl).toBe(200);
    const loss = realizedPnl({ direction: 'long', entry: 29526.5, pointValue: 2, exits: [{ qty: 4, price: 29506.5 }] });
    expect(loss).toBe(-160);
    const shortWin = realizedPnl({ direction: 'short', entry: 100, pointValue: 2, exits: [{ qty: 1, price: 90 }] });
    expect(shortWin).toBe(20);
  });

  it('averages fill prices by quantity', () => {
    expect(avgPrice([{ qty: 1, price: 100 }, { qty: 3, price: 104 }])).toBe(103);
    expect(avgPrice([])).toBe(0);
  });
});

// ------------------------------------------------------------------
// sessions — ET with DST
// ------------------------------------------------------------------
describe('sessions', () => {
  it('detects NY AM in EDT (UTC-4) and EST (UTC-5)', () => {
    expect(getSession(new Date('2026-09-15T14:14:00Z'))).toBe('nyam'); // 10:14 EDT
    expect(getSession(new Date('2026-01-15T15:14:00Z'))).toBe('nyam'); // 10:14 EST
    expect(getSession(new Date('2026-01-15T14:14:00Z'))).toBeNull();   // 09:14 EST
  });

  it('detects London and NY PM, inclusive of the closing minute', () => {
    expect(getSession(new Date('2026-09-15T07:00:00Z'))).toBe('london'); // 03:00 EDT
    expect(getSession(new Date('2026-09-15T07:30:00Z'))).toBe('london'); // 03:30 EDT (bar close)
    expect(getSession(new Date('2026-09-15T07:31:00Z'))).toBeNull();
    expect(getSession(new Date('2026-09-15T18:10:00Z'))).toBe('nypm');   // 14:10 EDT
    expect(getSession(new Date('2026-09-15T16:00:00Z'))).toBeNull();     // 12:00 EDT
  });

  it('rolls the broker day at 6 PM ET', () => {
    expect(brokerDayKey(new Date('2026-09-15T21:30:00Z'))).toBe('2026-09-15'); // 17:30 EDT
    expect(brokerDayKey(new Date('2026-09-15T22:00:00Z'))).toBe('2026-09-16'); // 18:00 EDT
    expect(brokerDayKey(new Date('2026-09-16T03:59:00Z'))).toBe('2026-09-16'); // 23:59 EDT
    expect(brokerDayKey(new Date('2026-09-16T04:00:00Z'))).toBe('2026-09-16'); // 00:00 EDT
    // month boundary
    expect(brokerDayKey(new Date('2026-09-30T23:00:00Z'))).toBe('2026-10-01'); // 19:00 EDT Sep 30
    // EST
    expect(brokerDayKey(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16'); // 18:30 EST
  });

  it('parses ET parts', () => {
    const p = etParts(new Date('2026-09-15T14:14:33Z'));
    expect(p).toMatchObject({ year: 2026, month: 9, day: 15, hour: 10, minute: 14, second: 33 });
  });

  it('normalises DB dates to keys', () => {
    expect(toDayKey('2026-09-15')).toBe('2026-09-15');
    expect(toDayKey(new Date(Date.UTC(2026, 8, 15)))).toBe('2026-09-15');
    expect(toDayKey(null)).toBeNull();
  });
});

// ------------------------------------------------------------------
// gate
// ------------------------------------------------------------------
describe('gate', () => {
  const base: AccountDayState = {
    ladderStep: 1, dayRealizedPnl: 0, lastDayKey: '2026-09-15',
    tradesToday: 0, londonUsed: false, nyamUsed: false, nypmUsed: false, dayLockedOut: false,
  };
  const preset = { dailyLossCap: 1000 };

  it('resets counters on a new broker day only', () => {
    const dirty = { ...base, dayRealizedPnl: -500, tradesToday: 2, nyamUsed: true, dayLockedOut: true };
    const same = resetIfNewDay(dirty, '2026-09-15');
    expect(same.reset).toBe(false);
    expect(same.state).toBe(dirty);
    const next = resetIfNewDay(dirty, '2026-09-16');
    expect(next.reset).toBe(true);
    expect(next.state).toMatchObject({ dayRealizedPnl: 0, tradesToday: 0, nyamUsed: false, lastDayKey: '2026-09-16', ladderStep: 1, dayLockedOut: false });
  });

  it('rejects everything once locked out for the day, regardless of session/count/DLL', () => {
    const locked = { ...base, dayLockedOut: true };
    expect(checkGate({ state: locked, preset, session: 'nyam', stepRisk: 334 }).reason).toBe('day_locked_out');
    expect(checkSniperGate({ state: locked, preset: sniperPreset, session: 'nyam', risk: 100 }).reason).toBe('day_locked_out');
  });

  it('allows a clean first trade', () => {
    expect(checkGate({ state: base, preset, session: 'nyam', stepRisk: 334 })).toEqual({ allowed: true });
  });

  it('rejects outside session and reused session', () => {
    expect(checkGate({ state: base, preset, session: null, stepRisk: 334 }).reason).toBe('outside_session');
    expect(checkGate({ state: { ...base, nyamUsed: true }, preset, session: 'nyam', stepRisk: 334 }).reason).toBe('session_used');
    expect(checkGate({ state: { ...base, nyamUsed: true }, preset, session: 'nypm', stepRisk: 334 }).allowed).toBe(true);
  });

  it('rejects after 3 trades', () => {
    expect(checkGate({ state: { ...base, tradesToday: 3 }, preset, session: 'nypm', stepRisk: 334 }).reason).toBe('max_trades_day');
  });

  it('enforces DLL headroom: room = cap + dayPnl', () => {
    expect(dllHeadroom(1000, -700)).toBe(300);
    // down $700, step 1 ($334) > $300 room → blocked
    expect(checkGate({ state: { ...base, dayRealizedPnl: -700 }, preset, session: 'nypm', stepRisk: 334 }).reason).toBe('dll_headroom');
    // down $600, room $400 ≥ $334 → allowed
    expect(checkGate({ state: { ...base, dayRealizedPnl: -600 }, preset, session: 'nypm', stepRisk: 334 }).allowed).toBe(true);
    // step 3 ($668) after one loss of $334 → room $666 → blocked by $2
    expect(checkGate({ state: { ...base, dayRealizedPnl: -334 }, preset, session: 'nypm', stepRisk: 668 }).reason).toBe('dll_headroom');
  });

  describe('drawdown headroom', () => {
    // Apex 50K that closed a day at 51,000: floor trailed to 49,000.
    const trailed = drawdownState({
      ddMode: 'eod_trailing', startBalance: 50_000, maxDrawdown: 2_000,
      lockBuffer: 100, eodBalances: [51_000], currentEquity: 50_500,
    });

    it('blocks a step that fits the daily cap but not the drawdown room', () => {
      // $668 is well inside the $1,000 daily cap, but only $500 sits above the
      // trailed floor. Losing it would end the account, not the day.
      const tight = drawdownState({
        ddMode: 'eod_trailing', startBalance: 50_000, maxDrawdown: 2_000,
        lockBuffer: 100, eodBalances: [51_000], currentEquity: 49_500,
      });
      expect(checkGate({ state: base, preset, session: 'nyam', stepRisk: 668 }).allowed).toBe(true);
      expect(
        checkGate({ state: base, preset, session: 'nyam', stepRisk: 668, drawdown: tight }).reason
      ).toBe('drawdown_headroom');
    });

    it('allows a step that fits both', () => {
      expect(checkGate({ state: base, preset, session: 'nyam', stepRisk: 334, drawdown: trailed }).allowed).toBe(true);
    });

    it('skips the check entirely when no drawdown state is supplied', () => {
      // An account with no recorded history must behave as it did before,
      // not be blocked by the absence of data.
      expect(checkGate({ state: base, preset, session: 'nyam', stepRisk: 334 }).allowed).toBe(true);
    });

    it('reports the floor in the rejection so the cause is legible', () => {
      // Must stay under the $1,000 daily cap, or the DLL gate rejects it first
      // and the drawdown check is never reached.
      const tight = drawdownState({
        ddMode: 'eod_trailing', startBalance: 50_000, maxDrawdown: 2_000,
        lockBuffer: 100, eodBalances: [51_000], currentEquity: 49_500,
      });
      const g = checkGate({ state: base, preset, session: 'nyam', stepRisk: 668, drawdown: tight });
      expect(g.reason).toBe('drawdown_headroom');
      expect(g.details).toMatchObject({ floor: 49_000, room: 500, stepRisk: 668 });
    });

    it('runs after the session and count gates, not before', () => {
      // A blown account outside its session should still say 'outside_session':
      // the cheapest true reason is the most useful one.
      const dead = drawdownState({
        ddMode: 'eod_trailing', startBalance: 50_000, maxDrawdown: 2_000,
        lockBuffer: 100, eodBalances: [51_000], currentEquity: 48_000,
      });
      expect(checkGate({ state: base, preset, session: null, stepRisk: 334, drawdown: dead }).reason)
        .toBe('outside_session');
    });
  });
});

const sniperPreset = { targetProfit: 3000, passZoneBuffer: 200, dailyLossCap: 1000, sniperRiskPct: 50, sniperMaxTradesDay: 2 };

describe('sniper mode', () => {
  const base: AccountDayState = {
    ladderStep: 1, dayRealizedPnl: 0, lastDayKey: '2026-09-15',
    tradesToday: 0, londonUsed: false, nyamUsed: false, nypmUsed: false, dayLockedOut: false,
  };

  it('computes remaining target and eligibility per account, independent of the signal', () => {
    expect(remainingTarget(3000, 2850)).toBe(150);
    expect(remainingTarget(3000, 0)).toBe(3000);
    expect(remainingTarget(3000, 3000)).toBe(0);
    expect(remainingTarget(3000, 3200)).toBe(0); // never negative
    expect(remainingTarget(null, 500)).toBe(Infinity); // funded/no-target preset never sniper-eligible

    expect(isSniperEligible(150, 200)).toBe(true);
    expect(isSniperEligible(0, 200)).toBe(false); // already there — normal target-reached logic takes over
    expect(isSniperEligible(500, 200)).toBe(false); // too far out, use the ladder
    expect(isSniperEligible(150, 0)).toBe(false); // buffer disabled
  });

  it('sizes sniper risk as a % of remaining target, capped at the daily loss cap', () => {
    expect(sniperRisk(150, 50, 1000)).toBe(75);
    expect(sniperRisk(3000, 50, 1000)).toBe(1000); // capped
  });

  it('restricts sniper trades to London and NY AM, never NY PM', () => {
    expect(checkSniperGate({ state: base, preset: sniperPreset, session: 'london', risk: 75 }).allowed).toBe(true);
    expect(checkSniperGate({ state: base, preset: sniperPreset, session: 'nyam', risk: 75 }).allowed).toBe(true);
    expect(checkSniperGate({ state: base, preset: sniperPreset, session: 'nypm', risk: 75 }).reason).toBe('sniper_session');
    expect(checkSniperGate({ state: base, preset: sniperPreset, session: null, risk: 75 }).reason).toBe('outside_session');
  });

  it('caps sniper trades at sniperMaxTradesDay, tighter than the normal 3/day', () => {
    expect(checkSniperGate({ state: { ...base, tradesToday: 2 }, preset: sniperPreset, session: 'london', risk: 75 }).reason).toBe('sniper_max_trades_day');
    expect(checkSniperGate({ state: { ...base, tradesToday: 1 }, preset: sniperPreset, session: 'london', risk: 75 }).allowed).toBe(true);
  });

  it('still enforces per-session-once and DLL headroom for sniper trades', () => {
    expect(checkSniperGate({ state: { ...base, londonUsed: true }, preset: sniperPreset, session: 'london', risk: 75 }).reason).toBe('session_used');
    expect(checkSniperGate({ state: { ...base, dayRealizedPnl: -950 }, preset: sniperPreset, session: 'london', risk: 75 }).reason).toBe('dll_headroom');
  });
});
