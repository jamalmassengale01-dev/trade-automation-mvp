/**
 * Subscription entitlements.
 *
 * What a paying customer may do, and what happens when they stop paying.
 *
 * THE PART THAT IS NOT OBVIOUS
 *
 * A billing gate on a trading system is not the same as a billing gate on a
 * web app. Locking someone out of a document editor at midnight is an
 * inconvenience; doing the equivalent here means an open MNQ position with a
 * live stop and nobody managing the bracket. A lapsed subscription must never
 * strand money in the market.
 *
 * So entitlement is split in two:
 *
 *   canOpenNewTrades  — revoked when payment lapses. This is the product.
 *   canManageOpen     — NEVER revoked. Brackets, breakeven moves, stop
 *                       management and the end-of-day flatten keep running for
 *                       every account with a position, paid or not, until the
 *                       position is closed.
 *
 * Withholding exit management from someone who owes $97 is not leverage, it is
 * a way to cost them thousands of dollars of someone else's money and be
 * responsible for it.
 *
 * GRACE
 *
 * Stripe retries a failed payment over several days before giving up. Cutting
 * a customer off on the first failed charge would punish an expired card the
 * same as a deliberate cancellation, so `past_due` keeps trading through a
 * grace window and only then stops.
 */

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'
  | 'none';

export type TierId = 'starter' | 'pro' | 'fleet';

export interface Tier {
  id: TierId;
  name: string;
  /** Broker accounts this tier may have active at once. */
  maxAccounts: number;
  /** false = the standard preset only. */
  allPresets: boolean;
  monthlyPriceUsd: number;
}

/** Matches the tiers described in CLAUDE.md. Prices live in Stripe; these are display only. */
export const TIERS: Record<TierId, Tier> = {
  starter: { id: 'starter', name: 'Starter', maxAccounts: 1,  allPresets: false, monthlyPriceUsd: 97 },
  pro:     { id: 'pro',     name: 'Pro',     maxAccounts: 5,  allPresets: true,  monthlyPriceUsd: 147 },
  fleet:   { id: 'fleet',   name: 'Fleet',   maxAccounts: 20, allPresets: true,  monthlyPriceUsd: 197 },
};

export function tierById(id: string | null | undefined): Tier | null {
  return id && id in TIERS ? TIERS[id as TierId] : null;
}

/** Days a past_due subscription keeps trading while Stripe retries the charge. */
export const PAST_DUE_GRACE_DAYS = 7;

export interface SubscriptionState {
  status: SubscriptionStatus;
  tierId: string | null;
  /** When the subscription first entered past_due. Null unless past_due. */
  pastDueSince: Date | null;
  /** End of the paid period. Access continues to here after a cancellation. */
  currentPeriodEnd: Date | null;
}

export interface Entitlement {
  /** May this customer's signals open NEW positions? */
  canOpenNewTrades: boolean;
  /**
   * May the system manage positions that are already open? Always true.
   * Present as a field rather than an assumption so the guarantee is visible
   * at every call site and cannot be quietly dropped.
   */
  canManageOpen: true;
  tier: Tier | null;
  maxAccounts: number;
  allPresets: boolean;
  /** Human-readable, shown to the customer. Absent when fully entitled. */
  reason?: string;
  /** True while inside the past_due grace window — trading, but warn. */
  inGrace: boolean;
  graceDaysLeft: number | null;
}

/** Admins are not customers and are never gated. */
export const ADMIN_ENTITLEMENT: Entitlement = {
  canOpenNewTrades: true,
  canManageOpen: true,
  tier: TIERS.fleet,
  maxAccounts: TIERS.fleet.maxAccounts,
  allPresets: true,
  inGrace: false,
  graceDaysLeft: null,
};

const DAY_MS = 86_400_000;

/**
 * Resolve what a subscription currently permits.
 *
 * `now` is injected so this stays pure and the grace boundary is testable.
 */
export function entitlementFor(
  state: SubscriptionState,
  now: Date = new Date(),
  role: 'admin' | 'customer' = 'customer'
): Entitlement {
  if (role === 'admin') return ADMIN_ENTITLEMENT;

  const tier = tierById(state.tierId);
  const base = {
    canManageOpen: true as const,
    tier,
    maxAccounts: tier?.maxAccounts ?? 0,
    allPresets: tier?.allPresets ?? false,
  };

  switch (state.status) {
    case 'active':
    case 'trialing':
      return { ...base, canOpenNewTrades: true, inGrace: false, graceDaysLeft: null };

    case 'past_due': {
      // Stripe is still retrying. Keep trading, but say so.
      const since = state.pastDueSince ?? now;
      const daysElapsed = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
      const daysLeft = PAST_DUE_GRACE_DAYS - daysElapsed;
      if (daysLeft > 0) {
        return {
          ...base,
          canOpenNewTrades: true,
          inGrace: true,
          graceDaysLeft: daysLeft,
          reason:
            `Payment failed. Trading continues for ${daysLeft} more day(s) while the charge is ` +
            'retried. Update your card to avoid interruption.',
        };
      }
      return {
        ...base,
        canOpenNewTrades: false,
        inGrace: false,
        graceDaysLeft: 0,
        reason:
          `Payment has been failing for ${PAST_DUE_GRACE_DAYS} days. New trades are paused. ` +
          'Open positions are still being managed and will be closed normally.',
      };
    }

    case 'canceled':
    case 'paused': {
      // A cancellation at period end is still paid up until that date.
      if (state.currentPeriodEnd && state.currentPeriodEnd > now) {
        return {
          ...base,
          canOpenNewTrades: true,
          inGrace: false,
          graceDaysLeft: null,
          reason: `Subscription ends ${state.currentPeriodEnd.toISOString().slice(0, 10)}.`,
        };
      }
      return {
        ...base,
        canOpenNewTrades: false,
        inGrace: false,
        graceDaysLeft: null,
        reason: 'Subscription ended. Open positions are still being managed.',
      };
    }

    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'none':
    default:
      return {
        ...base,
        canOpenNewTrades: false,
        inGrace: false,
        graceDaysLeft: null,
        maxAccounts: 0,
        allPresets: false,
        reason: 'No active subscription. Open positions are still being managed.',
      };
  }
}

/**
 * May this customer add another broker account on their tier?
 *
 * Separate from the prop-firm caps in accountLimits.ts and both apply — one is
 * what EdgePilot sells, the other is what the firm permits. The stricter wins,
 * and they fail differently: a tier limit is an upsell, a firm cap is a rule.
 */
export function canAddAccountOnTier(
  entitlement: Entitlement,
  currentAccountCount: number
): { allowed: boolean; reason?: string } {
  if (!entitlement.tier) {
    return { allowed: false, reason: 'No active subscription — no broker accounts are included.' };
  }
  if (currentAccountCount >= entitlement.maxAccounts) {
    return {
      allowed: false,
      reason:
        `The ${entitlement.tier.name} plan includes ${entitlement.maxAccounts} broker ` +
        `account${entitlement.maxAccounts === 1 ? '' : 's'} and ${currentAccountCount} ` +
        'are in use. Upgrade to add more.',
    };
  }
  return { allowed: true };
}

/** Stripe status string → our union, defaulting safely. */
export function parseStripeStatus(raw: string | null | undefined): SubscriptionStatus {
  const known: SubscriptionStatus[] = [
    'trialing', 'active', 'past_due', 'canceled', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused',
  ];
  return known.includes(raw as SubscriptionStatus) ? (raw as SubscriptionStatus) : 'none';
}
