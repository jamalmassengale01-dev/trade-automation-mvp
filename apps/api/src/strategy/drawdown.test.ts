import { describe, it, expect } from 'vitest';
import {
  drawdownState,
  drawdownHeadroom,
  eodBalancesFromDailyPnl,
  DrawdownInput,
} from './drawdown';

// Apex 50K EOD Trail, the reference case.
const APEX_50K: Omit<DrawdownInput, 'eodBalances' | 'currentEquity'> = {
  ddMode: 'eod_trailing',
  startBalance: 50_000,
  maxDrawdown: 2_000,
  lockBuffer: 100,
};

const at = (eodBalances: number[], currentEquity: number, over: Partial<DrawdownInput> = {}) =>
  drawdownState({ ...APEX_50K, eodBalances, currentEquity, ...over });

describe('drawdownState — Apex EOD trailing', () => {
  it('starts at start minus max drawdown', () => {
    const s = at([], 50_000);
    expect(s.floor).toBe(48_000);
    expect(s.locked).toBe(false);
    expect(s.room).toBe(2_000);
  });

  it('trails up behind a new end-of-day high', () => {
    // This is the case the old static model got wrong: real floor 49,000, not 48,000.
    const s = at([51_000], 50_800);
    expect(s.floor).toBe(49_000);
    expect(s.highWater).toBe(51_000);
    expect(s.room).toBe(1_800);
  });

  it('never trails back down after a losing day', () => {
    const s = at([51_000, 50_200], 50_200);
    expect(s.floor).toBe(49_000);
    expect(s.room).toBe(1_200);
  });

  it('does not drop below the initial floor on a day-one loss', () => {
    const s = at([49_000], 49_000);
    expect(s.floor).toBe(48_000);
    expect(s.highWater).toBe(50_000);
  });

  it('locks the floor at start + buffer and stops there', () => {
    // 52,100 is the documented safety-net balance for a 50K account.
    const s = at([52_100], 52_100);
    expect(s.floor).toBe(50_100);
    expect(s.locked).toBe(true);
    expect(s.lockAtBalance).toBe(52_100);
  });

  it('keeps the floor locked as the account climbs further', () => {
    const s = at([52_100, 56_000, 61_000], 61_000);
    expect(s.floor).toBe(50_100);
    expect(s.locked).toBe(true);
    // All profit above the locked floor is now genuinely at risk of being kept.
    expect(s.room).toBe(10_900);
  });

  it('reports the balance needed to lock before it is reached', () => {
    const s = at([51_000], 51_000);
    expect(s.locked).toBe(false);
    expect(s.lockAtBalance).toBe(52_100);
  });

  it('reports negative room once breached', () => {
    const s = at([51_000], 48_500);
    expect(s.room).toBe(-500);
  });
});

describe('drawdownState — other modes', () => {
  it('static_fixed never trails, however profitable', () => {
    const s = at([60_000], 60_000, { ddMode: 'static_fixed' });
    expect(s.floor).toBe(48_000);
    expect(s.locked).toBe(true);
    expect(s.room).toBe(12_000);
  });

  it('trails forever when there is no lock rule', () => {
    const s = at([60_000], 60_000, { lockBuffer: null });
    expect(s.floor).toBe(58_000);
    expect(s.locked).toBe(false);
    expect(s.lockAtBalance).toBeNull();
  });

  it('intraday mode trails the peaks it is given', () => {
    // Same arithmetic; the caller is responsible for feeding peaks not closes.
    // Kept below the lock threshold so this asserts trailing, not locking.
    const s = at([51_500], 51_000, { ddMode: 'intraday_trailing' });
    expect(s.floor).toBe(49_500);
    expect(s.locked).toBe(false);
  });

  it('applies the lock to intraday mode as well', () => {
    // An intraday peak of 53,000 implies a floor of 51,000, but the lock caps
    // it at 50,100 — the buffer is a property of the account, not the mode.
    const s = at([53_000], 51_000, { ddMode: 'intraday_trailing' });
    expect(s.floor).toBe(50_100);
    expect(s.locked).toBe(true);
  });
});

describe('drawdownState — incomplete history', () => {
  it('flags an unlocked floor derived from partial history as understated', () => {
    // Missing profitable days produce a floor that is too LOW, i.e. too much
    // apparent room. That must never pass silently.
    const s = at([51_000], 51_000, { historyComplete: false });
    expect(s.understated).toBe(true);
  });

  it('does not flag a locked floor — it cannot rise further', () => {
    const s = at([52_100], 52_100, { historyComplete: false });
    expect(s.locked).toBe(true);
    expect(s.understated).toBe(false);
  });

  it('does not flag complete history', () => {
    expect(at([51_000], 51_000, { historyComplete: true }).understated).toBe(false);
  });
});

describe('eodBalancesFromDailyPnl', () => {
  it('accumulates daily P&L into a balance series', () => {
    expect(eodBalancesFromDailyPnl(50_000, [500, -200, 800])).toEqual([50_500, 50_300, 51_100]);
  });

  it('returns nothing for an account with no recorded days', () => {
    expect(eodBalancesFromDailyPnl(50_000, [])).toEqual([]);
  });

  it('feeds drawdownState to the same floor as explicit balances', () => {
    const series = eodBalancesFromDailyPnl(50_000, [1_000, -800]);
    expect(at(series, 50_200).floor).toBe(49_000);
  });
});

describe('drawdownHeadroom', () => {
  const state = at([51_000], 50_800); // floor 49,000, room 1,800

  it('allows a step that fits', () => {
    const g = drawdownHeadroom(state, 334);
    expect(g.allowed).toBe(true);
    expect(g.roomAfter).toBe(1_466);
  });

  it('blocks a step larger than the room', () => {
    const g = drawdownHeadroom(state, 2_000);
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain('would end the account');
  });

  it('applies the buffer to the room, not to the risk', () => {
    // 10% of 1,800 held back = 1,620 usable.
    expect(drawdownHeadroom(state, 1_620, 10).allowed).toBe(true);
    expect(drawdownHeadroom(state, 1_621, 10).allowed).toBe(false);
  });

  it('blocks everything once the floor is breached', () => {
    const breached = at([51_000], 48_900);
    const g = drawdownHeadroom(breached, 1);
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain('no room at all');
  });

  it('blocks a step that the STATIC model would have allowed', () => {
    // The whole point. Equity 50,800 with a trailed floor of 49,000 leaves
    // 1,800; the old static floor of 48,000 implied 2,800 and would have let
    // a step-3 ladder risk of $2,004 through, into an account-ending loss.
    expect(drawdownHeadroom(state, 2_004).allowed).toBe(false);
    const staticState = at([51_000], 50_800, { ddMode: 'static_fixed' });
    expect(drawdownHeadroom(staticState, 2_004).allowed).toBe(true);
  });
});
