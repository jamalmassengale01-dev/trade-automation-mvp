import { describe, it, expect } from 'vitest';
import { applyAdjustment } from './pnlAdjustment';

/**
 * Input validation runs before any database work, so these exercise the guards
 * without a connection. The arithmetic is verified end-to-end against live
 * Postgres — an adjustment must move `accountDrawdownState`, not just a row —
 * because that is a property of three modules agreeing, which a mock would not
 * establish.
 */
describe('applyAdjustment — input guards', () => {
  const ok = { accountId: 'a1', dayKey: '2026-09-02', amount: 100, reason: 'manual trade' };

  it('rejects a calendar-formatted day key', async () => {
    // The broker day is not the calendar date — Apex rolls at 6 PM ET. Taking
    // a loosely formatted date would file the correction against the wrong day
    // and move the trailing floor by the wrong amount.
    await expect(applyAdjustment({ ...ok, dayKey: '09/02/2026' }))
      .rejects.toThrow(/YYYY-MM-DD/);
  });

  it('rejects an empty or malformed day key', async () => {
    for (const dayKey of ['', '2026-9-2', '2026-09-02T00:00:00Z', 'yesterday']) {
      await expect(applyAdjustment({ ...ok, dayKey })).rejects.toThrow(/YYYY-MM-DD/);
    }
  });

  it('rejects a zero amount', async () => {
    // A zero adjustment writes an audit row that claims a correction happened
    // and changes nothing — worse than refusing it.
    await expect(applyAdjustment({ ...ok, amount: 0 })).rejects.toThrow(/non-zero/);
  });

  it('rejects a non-finite amount', async () => {
    for (const amount of [NaN, Infinity, -Infinity]) {
      await expect(applyAdjustment({ ...ok, amount })).rejects.toThrow(/non-zero/);
    }
  });

  it('requires a reason', async () => {
    // An unexplained adjustment is indistinguishable from a bug when someone
    // is working out why an account blew.
    for (const reason of ['', '  ', 'x']) {
      await expect(applyAdjustment({ ...ok, reason })).rejects.toThrow(/reason is required/);
    }
  });

  it('accepts a negative amount — corrections go both ways', async () => {
    // Reaches the database and fails there, which proves validation passed.
    await expect(applyAdjustment({ ...ok, amount: -250 }))
      .rejects.not.toThrow(/non-zero|YYYY-MM-DD|reason is required/);
  });
});
