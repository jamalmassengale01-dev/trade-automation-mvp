import { describe, it, expect } from 'vitest';
import { summariseAccounts } from './operations';

/**
 * The Operations page exists to answer one question before a session window:
 * would a signal trade right now?
 *
 * Every case below is about the same failure: claiming yes when the answer is
 * no. That is the only output this screen must never produce — a false "none
 * would trade" costs a glance, a false "all would trade" costs a trade you
 * believed was covered.
 */
describe('summariseAccounts', () => {
  it('does not claim readiness on an empty fleet', () => {
    // The original bug, seen on the first real deployment. The component
    // compared clear.length === accounts.length, which is 0 === 0, so a server
    // with no accounts announced "all would trade a signal right now" —
    // directly above a card explaining that nothing would.
    const s = summariseAccounts([], []);
    expect(s).not.toMatch(/all would trade/);
    expect(s).toBe('no accounts connected yet');
  });

  it('says none when every account is blocked', () => {
    expect(summariseAccounts(['Apex 1', 'Apex 2'], []))
      .toBe('none would trade a signal right now');
  });

  it('says all only when every account really is clear', () => {
    expect(summariseAccounts(['Apex 1', 'Apex 2'], ['Apex 1', 'Apex 2']))
      .toBe('all would trade a signal right now');
  });

  it('names the accounts when only some are clear', () => {
    // Which ones matters. "1 of 3 ready" tells you nothing about which one.
    expect(summariseAccounts(['Apex 1', 'Apex 2', 'Phidias 1'], ['Apex 2']))
      .toBe('Apex 2 would trade right now');
    expect(summariseAccounts(['Apex 1', 'Apex 2', 'Phidias 1'], ['Apex 1', 'Phidias 1']))
      .toBe('Apex 1, Phidias 1 would trade right now');
  });

  it('never says "all" unless the clear list covers the whole fleet', () => {
    // The property behind the bug, checked across sizes rather than by example.
    for (let total = 0; total <= 6; total++) {
      const names = Array.from({ length: total }, (_, i) => `acct-${i}`);
      for (let clear = 0; clear <= total; clear++) {
        const s = summariseAccounts(names, names.slice(0, clear));
        if (/all would trade/.test(s)) {
          expect(total, `claimed "all" with ${clear}/${total} clear`).toBeGreaterThan(0);
          expect(clear).toBe(total);
        }
      }
    }
  });
});
