import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSession, testSessionOverride, effectiveSessionWindows } from './sessions';

/** A Date at a given ET wall-clock time (2026-09-08 is EDT, UTC-4). */
function et(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 8, hour + 4, minute, 0));
}

const ORIGINAL = { env: process.env.GB_TEST_SESSION, node: process.env.NODE_ENV };

beforeEach(() => {
  delete process.env.GB_TEST_SESSION;
  process.env.NODE_ENV = 'development';
});

afterEach(() => {
  if (ORIGINAL.env === undefined) delete process.env.GB_TEST_SESSION;
  else process.env.GB_TEST_SESSION = ORIGINAL.env;
  process.env.NODE_ENV = ORIGINAL.node;
});

describe('session override — off by default', () => {
  it('is inactive when the variable is unset', () => {
    expect(testSessionOverride()).toBeNull();
    expect(effectiveSessionWindows()).toEqual(
      expect.objectContaining({ nyam: expect.objectContaining({ startMin: 600, endMin: 630 }) })
    );
  });

  it('leaves the real windows alone', () => {
    expect(getSession(et(10, 15))).toBe('nyam');
    expect(getSession(et(3, 15))).toBe('london');
    expect(getSession(et(14, 15))).toBe('nypm');
    expect(getSession(et(16, 56))).toBeNull();
  });

  it('ignores a value that is not a session name', () => {
    for (const bad of ['always', 'true', '1', 'NYAM ', 'yes']) {
      process.env.GB_TEST_SESSION = bad;
      // 'NYAM ' trims and lowercases to a valid name; the rest must not activate.
      if (bad.trim().toLowerCase() === 'nyam') continue;
      expect(testSessionOverride()).toBeNull();
    }
  });
});

describe('session override — production refuses it', () => {
  it('will not activate under NODE_ENV=production, whatever the value', () => {
    process.env.NODE_ENV = 'production';
    for (const s of ['nyam', 'london', 'nypm']) {
      process.env.GB_TEST_SESSION = s;
      expect(testSessionOverride()).toBeNull();
      expect(getSession(et(16, 56))).toBeNull();
    }
  });
});

describe('session override — active in development', () => {
  beforeEach(() => { process.env.GB_TEST_SESSION = 'nyam'; });

  it('opens the named session all day', () => {
    expect(testSessionOverride()).toBe('nyam');
    for (const h of [0, 6, 12, 16, 20, 23]) {
      expect(getSession(et(h, 56))).toBe('nyam');
    }
  });

  it('does not shadow the other real windows', () => {
    // A timestamp inside London must still resolve to london, not the widened
    // nyam — otherwise the wrong used-flag column gets set.
    expect(getSession(et(3, 15))).toBe('london');
    expect(getSession(et(14, 15))).toBe('nypm');
  });

  it('still resolves its own real window to itself', () => {
    expect(getSession(et(10, 15))).toBe('nyam');
  });

  it('labels the widened window so it is obvious in logs', () => {
    expect(effectiveSessionWindows().nyam.label).toMatch(/WIDENED TO ALL DAY/);
  });

  it('widening london does not disturb nyam or nypm', () => {
    process.env.GB_TEST_SESSION = 'london';
    expect(getSession(et(10, 15))).toBe('nyam');
    expect(getSession(et(14, 15))).toBe('nypm');
    expect(getSession(et(20, 0))).toBe('london');
  });
});
