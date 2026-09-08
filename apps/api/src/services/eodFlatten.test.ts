import { describe, it, expect } from 'vitest';
import { inFlattenWindow, DEFAULT_FLATTEN_ET_MINUTE } from './eodFlatten';

/** Build a Date at a given ET wall-clock time on a fixed weekday. */
function et(hour: number, minute: number): Date {
  // 2026-09-08 is a Tuesday; ET is UTC-4 in September (EDT).
  return new Date(Date.UTC(2026, 8, 8, hour + 4, minute, 0));
}

describe('inFlattenWindow', () => {
  it('fires exactly at the 4:55 PM ET cutoff', () => {
    expect(inFlattenWindow(et(16, 55))).toBe(true);
  });

  it('stays quiet before the cutoff', () => {
    for (const [h, m] of [[9, 30], [14, 30], [16, 0], [16, 54]] as const) {
      expect(inFlattenWindow(et(h, m))).toBe(false);
    }
  });

  it('covers the minutes up to Apex\'s 4:59 deadline', () => {
    for (const m of [55, 56, 57, 58, 59]) {
      expect(inFlattenWindow(et(16, m))).toBe(true);
    }
  });

  it('closes the window rather than firing all evening', () => {
    expect(inFlattenWindow(et(17, 5))).toBe(false);
    expect(inFlattenWindow(et(18, 30))).toBe(false);
    expect(inFlattenWindow(et(23, 0))).toBe(false);
  });

  it('leaves margin before the deadline it protects', () => {
    // 4:59 PM ET is Apex's line; the default must sit strictly before it, with
    // enough room for a market order to actually fill.
    expect(DEFAULT_FLATTEN_ET_MINUTE).toBeLessThan(16 * 60 + 59);
    expect(16 * 60 + 59 - DEFAULT_FLATTEN_ET_MINUTE).toBeGreaterThanOrEqual(3);
  });

  it('honours a custom cutoff', () => {
    const earlier = 16 * 60 + 30;
    expect(inFlattenWindow(et(16, 30), earlier)).toBe(true);
    expect(inFlattenWindow(et(16, 55), earlier)).toBe(false);
  });

  it('does not fire during any GB LIVE session window', () => {
    // London 3:00-3:30, NY AM 10:00-10:30, NY PM 2:00-2:30 ET.
    for (const [h, m] of [[3, 0], [3, 30], [10, 0], [10, 30], [14, 0], [14, 30]] as const) {
      expect(inFlattenWindow(et(h, m))).toBe(false);
    }
  });
});
