import { describe, it, expect } from 'vitest';
import { normalizeGbLive, normalizeIncomingAlert, isGbLivePayload, gbAlertId } from './gbLiveSchema';
import { validateAlert } from './schema';

const buy = {
  strategy_name: 'GB LIVE',
  symbol: 'MNQ1!',
  date: '2026-09-15T14:14:00Z',
  data: 'buy',
  quantity: 4,
  price: '29526.50',
  gtd_in_second: 120,
  order_type: 'MKT',
  advance_tp_sl: [
    { quantity: 2, dollar_tp: 417.5, dollar_sl: 334.0, breakeven: 208.75 },
    { quantity: 2, dollar_tp: 835.0, dollar_sl: 334.0, breakeven: 208.75 },
  ],
  multiple_accounts: [{ token: 'x', account_id: 'y', quantity_multiplier: 1 }],
};

describe('gbLiveSchema', () => {
  it('detects GB LIVE payloads vs internal payloads', () => {
    expect(isGbLivePayload(buy)).toBe(true);
    expect(isGbLivePayload({ id: 'a', action: 'buy' })).toBe(false);
    expect(isGbLivePayload(null)).toBe(false);
  });

  it('normalizes a buy signal into the internal schema and passes validateAlert', () => {
    const r = normalizeGbLive(buy);
    expect(r.success).toBe(true);
    const a = r.alert!;
    expect(a.strategy).toBe('GB LIVE');
    expect(a.symbol).toBe('MNQ1!');
    expect(a.action).toBe('buy');
    expect(a.contracts).toBe(4);
    expect(a.price).toBe(29526.5);
    expect(a.timestamp).toBe(Date.parse('2026-09-15T14:14:00Z'));

    const v = validateAlert(a);
    expect(v.success).toBe(true);
    expect(v.data!.id).toHaveLength(32);
  });

  it('derives stop / tp distances in points from dollar legs (MNQ $2/pt)', () => {
    const meta = normalizeGbLive(buy).alert!.metadata as any;
    expect(meta.source).toBe('gb_live');
    expect(meta.gtdSeconds).toBe(120);
    expect(meta.bracket.legs).toHaveLength(2);
    // $334 / (2 × $2) = 83.5 pts
    expect(meta.bracket.stopPts).toBe(83.5);
    // $417.5 / (2 × 2) = 104.375 → rounded to tick 104.5
    expect(meta.bracket.tp1Pts).toBe(104.5);
    // $835 / 4 = 208.75
    expect(meta.bracket.tp2Pts).toBe(208.75);
  });

  it('produces a stable id for retries and different ids for different bars', () => {
    const a = normalizeGbLive(buy).alert!.id;
    const b = normalizeGbLive({ ...buy }).alert!.id;
    const c = normalizeGbLive({ ...buy, date: '2026-09-15T14:16:00Z' }).alert!.id;
    const d = normalizeGbLive({ ...buy, data: 'sell' }).alert!.id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(gbAlertId({ strategy_name: 's', symbol: 'x', data: 'buy' }, 1_000_000)).toHaveLength(32);
  });

  it('accepts a minimal payload with stop_pts and no advance_tp_sl', () => {
    const r = normalizeGbLive({
      strategy_name: 'GB LIVE',
      symbol: 'MNQ1!',
      date: '2026-09-15T14:14:00Z',
      data: 'buy',
      price: '29526.50',
      stop_pts: 20,
      gtd_in_second: 120,
      order_type: 'MKT',
    });
    expect(r.success).toBe(true);
    const meta = r.alert!.metadata as any;
    expect(meta.bracket.stopPts).toBe(20);
    expect(meta.bracket.legs).toEqual([]);
    expect(validateAlert(r.alert).success).toBe(true);
  });

  it('prefers stop_pts over the dollar-derived distance when both are present', () => {
    // dollar legs would derive 83.5 pts; stop_pts says 20 and must win
    const r = normalizeGbLive({ ...buy, stop_pts: 20 });
    expect((r.alert!.metadata as any).bracket.stopPts).toBe(20);
  });

  it('rounds stop_pts to the instrument tick', () => {
    const r = normalizeGbLive({ ...buy, advance_tp_sl: undefined, stop_pts: 20.31 });
    expect((r.alert!.metadata as any).bracket.stopPts).toBe(20.25);
  });

  it('rejects a non-positive stop_pts', () => {
    expect(normalizeGbLive({ ...buy, stop_pts: 0 }).success).toBe(false);
    expect(normalizeGbLive({ ...buy, stop_pts: -5 }).success).toBe(false);
  });

  it('normalizes a close-all signal without contracts or bracket', () => {
    const r = normalizeGbLive({
      strategy_name: 'GB LIVE', symbol: 'MNQ1!', date: '2026-09-15T14:30:00Z',
      data: 'close', quantity: 0, order_type: 'MKT', reverse_order_close: true,
    });
    expect(r.success).toBe(true);
    expect(r.alert!.action).toBe('close');
    expect(r.alert!.contracts).toBeUndefined();
    expect((r.alert!.metadata as any).bracket).toBeUndefined();
    expect((r.alert!.metadata as any).reverseOrderClose).toBe(true);
    expect(validateAlert(r.alert).success).toBe(true);
  });

  it('rejects bad payloads with a readable error', () => {
    const r = normalizeGbLive({ strategy_name: 'GB LIVE', symbol: 'MNQ1!', data: 'flat' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('data');
    const r2 = normalizeGbLive({ ...buy, advance_tp_sl: [{ quantity: 2, dollar_sl: -1 }] });
    expect(r2.success).toBe(false);
  });

  it('leaves the stopPts undefined for unknown instruments but still validates', () => {
    const r = normalizeGbLive({ ...buy, symbol: 'ZZZ1!' });
    expect(r.success).toBe(true);
    expect((r.alert!.metadata as any).bracket.stopPts).toBeUndefined();
  });

  it('falls back to now when date is missing, minute-bucketed for dedup', () => {
    const now = Date.parse('2026-09-15T14:14:33Z');
    const r = normalizeGbLive({ ...buy, date: undefined }, now);
    expect(r.success).toBe(true);
    expect(r.alert!.timestamp).toBe(now);
  });

  it('passes internal-format bodies through untouched', () => {
    const body = { id: 'abc', timestamp: 1, strategy: 's', symbol: 'ES', action: 'buy' };
    expect(normalizeIncomingAlert(body)).toEqual({ success: true, alert: body });
  });
});
