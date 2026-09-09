import { describe, it, expect } from 'vitest';
import {
  entitlementFor, canAddAccountOnTier, parseStripeStatus,
  TIERS, PAST_DUE_GRACE_DAYS, SubscriptionState,
} from './subscription';

const NOW = new Date('2026-09-09T12:00:00Z');
const state = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  status: 'active', tierId: 'pro', pastDueSince: null, currentPeriodEnd: null, ...over,
});
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('entitlementFor — open positions are never abandoned', () => {
  it('keeps managing open positions in EVERY status', () => {
    // The whole point. A billing lapse must never strand an MNQ position with
    // a live stop and nobody moving it.
    const statuses = [
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused', 'none',
    ] as const;
    for (const s of statuses) {
      const e = entitlementFor(state({ status: s, pastDueSince: daysAgo(90) }), NOW);
      expect(e.canManageOpen, s).toBe(true);
    }
  });

  it('says so in the reason when it stops new trades', () => {
    const e = entitlementFor(state({ status: 'none' }), NOW);
    expect(e.canOpenNewTrades).toBe(false);
    expect(e.reason).toContain('Open positions are still being managed');
  });
});

describe('entitlementFor — paid states', () => {
  it('allows trading while active or trialing', () => {
    expect(entitlementFor(state({ status: 'active' }), NOW).canOpenNewTrades).toBe(true);
    expect(entitlementFor(state({ status: 'trialing' }), NOW).canOpenNewTrades).toBe(true);
  });

  it('carries the tier limits through', () => {
    const e = entitlementFor(state({ tierId: 'starter' }), NOW);
    expect(e.maxAccounts).toBe(1);
    expect(e.allPresets).toBe(false);
    expect(entitlementFor(state({ tierId: 'fleet' }), NOW).maxAccounts).toBe(20);
  });
});

describe('entitlementFor — past_due grace', () => {
  it('keeps trading on day one of a failed charge', () => {
    // Stripe is still retrying. An expired card should not read the same as a
    // deliberate cancellation.
    const e = entitlementFor(state({ status: 'past_due', pastDueSince: daysAgo(1) }), NOW);
    expect(e.canOpenNewTrades).toBe(true);
    expect(e.inGrace).toBe(true);
    expect(e.graceDaysLeft).toBe(PAST_DUE_GRACE_DAYS - 1);
    expect(e.reason).toContain('Update your card');
  });

  it('stops new trades once the grace window closes', () => {
    const e = entitlementFor(state({ status: 'past_due', pastDueSince: daysAgo(PAST_DUE_GRACE_DAYS) }), NOW);
    expect(e.canOpenNewTrades).toBe(false);
    expect(e.inGrace).toBe(false);
    expect(e.canManageOpen).toBe(true);
  });

  it('is still inside grace on the final day', () => {
    const e = entitlementFor(state({ status: 'past_due', pastDueSince: daysAgo(PAST_DUE_GRACE_DAYS - 1) }), NOW);
    expect(e.canOpenNewTrades).toBe(true);
    expect(e.graceDaysLeft).toBe(1);
  });

  it('grants full grace when the start of past_due is unknown', () => {
    const e = entitlementFor(state({ status: 'past_due', pastDueSince: null }), NOW);
    expect(e.canOpenNewTrades).toBe(true);
  });
});

describe('entitlementFor — cancellation', () => {
  it('keeps trading until the paid period actually ends', () => {
    const e = entitlementFor(
      state({ status: 'canceled', currentPeriodEnd: new Date('2026-09-30T00:00:00Z') }), NOW
    );
    expect(e.canOpenNewTrades).toBe(true);
    expect(e.reason).toContain('2026-09-30');
  });

  it('stops once that period has passed', () => {
    const e = entitlementFor(
      state({ status: 'canceled', currentPeriodEnd: new Date('2026-09-01T00:00:00Z') }), NOW
    );
    expect(e.canOpenNewTrades).toBe(false);
  });
});

describe('entitlementFor — admins', () => {
  it('never gates an admin, whatever the subscription says', () => {
    const e = entitlementFor(state({ status: 'none', tierId: null }), NOW, 'admin');
    expect(e.canOpenNewTrades).toBe(true);
    expect(e.maxAccounts).toBe(TIERS.fleet.maxAccounts);
  });
});

describe('canAddAccountOnTier', () => {
  const ent = (tierId: 'starter' | 'pro' | 'fleet') => entitlementFor(state({ tierId }), NOW);

  it('allows up to the tier limit and refuses past it', () => {
    expect(canAddAccountOnTier(ent('starter'), 0).allowed).toBe(true);
    expect(canAddAccountOnTier(ent('starter'), 1).allowed).toBe(false);
    expect(canAddAccountOnTier(ent('pro'), 4).allowed).toBe(true);
    expect(canAddAccountOnTier(ent('pro'), 5).allowed).toBe(false);
  });

  it('names the plan and the usage so the message is actionable', () => {
    const r = canAddAccountOnTier(ent('starter'), 1);
    expect(r.reason).toContain('Starter');
    expect(r.reason).toContain('1 broker account');
    expect(r.reason).toContain('Upgrade');
  });

  it('refuses with no subscription at all', () => {
    const none = entitlementFor(state({ status: 'none', tierId: null }), NOW);
    expect(canAddAccountOnTier(none, 0).allowed).toBe(false);
  });
});

describe('parseStripeStatus', () => {
  it('passes known statuses through', () => {
    expect(parseStripeStatus('active')).toBe('active');
    expect(parseStripeStatus('past_due')).toBe('past_due');
  });

  it('maps anything unrecognised to none rather than trusting it', () => {
    expect(parseStripeStatus('something_new')).toBe('none');
    expect(parseStripeStatus(null)).toBe('none');
    expect(parseStripeStatus(undefined)).toBe('none');
  });
});
