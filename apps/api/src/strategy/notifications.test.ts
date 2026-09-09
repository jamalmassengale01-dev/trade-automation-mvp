import { describe, it, expect } from 'vitest';
import { classifyEvent, withinCooldown, formatTitle, RiskEventLike } from './notifications';

const ev = (ruleType: string, over: Partial<RiskEventLike> = {}): RiskEventLike => ({
  type: 'warning', ruleType, accountId: 'acct-1', message: 'something happened', ...over,
});

describe('classifyEvent — what reaches a person', () => {
  it('suppresses routine gate rejections', () => {
    // These are the gates working. There are dozens a week and notifying on
    // them would bury the events that matter.
    for (const r of ['gb_outside_session', 'gb_session_used', 'gb_max_trades_day', 'gb_trade_already_open']) {
      const d = classifyEvent(ev(r, { type: 'rejection' }));
      expect(d.notify, r).toBe(false);
      expect(d.suppressedBecause).toContain('working as designed');
    }
  });

  it('treats an account ending as critical', () => {
    for (const r of ['rule_drawdown_breached', 'gb_dll_breached', 'eval_blown', 'rule_reconciliation_halt']) {
      const d = classifyEvent(ev(r, { type: 'kill_switch' }));
      expect(d.notify, r).toBe(true);
      expect(d.severity, r).toBe('critical');
    }
  });

  it('treats a passed evaluation as critical — a fee clock starts', () => {
    const d = classifyEvent(ev('eval_passed'));
    expect(d.severity).toBe('critical');
    expect(d.title).toContain('activation fee');
    // Daily, not hourly: a 7-day window wants a reminder, not nagging.
    expect(d.cooldownSeconds).toBe(24 * 3600);
  });

  it('warns without escalating on drift and idle accounts', () => {
    for (const r of ['rule_day_pnl_drift', 'rule_inactivity', 'rule_drawdown_within_one_day']) {
      expect(classifyEvent(ev(r)).severity, r).toBe('warning');
    }
  });

  it('notifies on an unknown rule type rather than dropping it', () => {
    // A filter that silently swallows the unfamiliar is how a real alert goes
    // missing. Unknown is more likely new than safe.
    const d = classifyEvent(ev('some_rule_nobody_classified'));
    expect(d.notify).toBe(true);
    expect(d.title).toContain('Unclassified');
  });

  it('escalates an unknown kill_switch to critical', () => {
    const d = classifyEvent(ev('brand_new_disaster', { type: 'kill_switch' }));
    expect(d.severity).toBe('critical');
  });

  it('keys dedupe per account, so one blown account does not mute another', () => {
    const a = classifyEvent(ev('rule_drawdown_breached', { accountId: 'a' }));
    const b = classifyEvent(ev('rule_drawdown_breached', { accountId: 'b' }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('keys dedupe per condition, so one alert does not mute a different one', () => {
    const a = classifyEvent(ev('rule_drawdown_breached', { accountId: 'a' }));
    const b = classifyEvent(ev('gb_dll_breached', { accountId: 'a' }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('handles an event with no account', () => {
    const d = classifyEvent(ev('eod_flatten_failed', { accountId: null }));
    expect(d.dedupeKey).toContain('no-account');
  });

  it('gives every notifiable event a non-zero cooldown', () => {
    // Without one, the 15-minute reconciler sweep produces 96 identical
    // messages a day and the channel stops being read.
    for (const r of ['rule_drawdown_breached', 'rule_inactivity', 'unknown_thing']) {
      expect(classifyEvent(ev(r)).cooldownSeconds, r).toBeGreaterThan(0);
    }
  });
});

describe('withinCooldown', () => {
  const now = new Date('2026-09-09T12:00:00Z');

  it('suppresses a repeat inside the window', () => {
    expect(withinCooldown(new Date('2026-09-09T11:30:00Z'), 3600, now)).toBe(true);
  });

  it('allows one past the window', () => {
    expect(withinCooldown(new Date('2026-09-09T10:30:00Z'), 3600, now)).toBe(false);
  });

  it('never suppresses a first send', () => {
    expect(withinCooldown(null, 3600, now)).toBe(false);
  });

  it('never suppresses when the cooldown is zero', () => {
    expect(withinCooldown(new Date('2026-09-09T11:59:59Z'), 0, now)).toBe(false);
  });
});

describe('formatTitle', () => {
  it('leads with severity and names the account', () => {
    const d = classifyEvent(ev('rule_drawdown_breached'));
    expect(formatTitle(d, 'Apex 1')).toBe('🔴 Apex 1: Account blown — drawdown floor breached');
  });

  it('omits the account when there is none', () => {
    const d = classifyEvent(ev('rule_inactivity'));
    expect(formatTitle(d, null)).toBe('🟡 Account idle — inactivity policy at risk');
  });
});
