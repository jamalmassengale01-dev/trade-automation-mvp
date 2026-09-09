import { describe, it, expect } from 'vitest';
import { brokerDayKey, APEX_DAY_BOUNDARY, BrokerDayBoundary } from './sessions';

// Phidias ends its session at 10:00 PM UTC+2 — a European wall-clock time, so
// it is modelled in a European zone rather than as a fixed UTC offset.
const PHIDIAS: BrokerDayBoundary = { timeZone: 'Europe/Paris', hour: 22 };

describe('brokerDayKey — configurable firm day boundary', () => {
  it('defaults to Apex 6 PM ET, unchanged', () => {
    expect(brokerDayKey(new Date('2026-09-15T22:30:00Z'))).toBe('2026-09-16'); // 18:30 EDT
    expect(brokerDayKey(new Date('2026-09-15T21:59:00Z'))).toBe('2026-09-15'); // 17:59 EDT
    expect(brokerDayKey(new Date('2026-09-15T22:30:00Z'), APEX_DAY_BOUNDARY)).toBe('2026-09-16');
  });

  it('rolls a Phidias day at 22:00 Paris, not 18:00 ET', () => {
    // 20:00 UTC = 22:00 CEST = 16:00 EDT. Phidias has rolled; Apex has not.
    const t = new Date('2026-09-15T20:00:00Z');
    expect(brokerDayKey(t, PHIDIAS)).toBe('2026-09-16');
    expect(brokerDayKey(t, APEX_DAY_BOUNDARY)).toBe('2026-09-15');
  });

  it('keeps 19:59 UTC on the same Phidias day', () => {
    expect(brokerDayKey(new Date('2026-09-15T19:59:00Z'), PHIDIAS)).toBe('2026-09-15');
  });

  it('tracks European DST independently of US DST', () => {
    // 2026-10-28 is after the EU change (Oct 25) but before the US change
    // (Nov 1), so Paris is UTC+1 while New York is still UTC-4. A fixed
    // "UTC+2" offset would be an hour wrong for this whole week.
    const t = new Date('2026-10-28T21:00:00Z'); // 22:00 CET, 17:00 EDT
    expect(brokerDayKey(t, PHIDIAS)).toBe('2026-10-29');
    expect(brokerDayKey(t, APEX_DAY_BOUNDARY)).toBe('2026-10-28');
  });

  it('handles a month boundary', () => {
    expect(brokerDayKey(new Date('2026-09-30T20:00:00Z'), PHIDIAS)).toBe('2026-10-01');
  });
});
