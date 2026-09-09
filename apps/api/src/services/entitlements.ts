/**
 * What a given user is currently entitled to.
 *
 * The rules are pure and live in strategy/subscription.ts; this reads the
 * mirrored subscription row and applies them.
 *
 * Reads the LOCAL mirror, never Stripe. This is consulted on the signal path,
 * and a payment provider's availability must not decide whether a trade fires.
 * The mirror is kept current by webhook and can be re-synced on demand.
 */

import { query } from '../db';
import {
  entitlementFor, Entitlement, SubscriptionState,
  parseStripeStatus, canAddAccountOnTier,
} from '../strategy/subscription';

export interface UserEntitlement extends Entitlement {
  userId: string;
  status: string;
  accountsInUse: number;
}

interface Row extends Record<string, unknown> {
  role: 'admin' | 'customer';
  status: string | null;
  tier_id: string | null;
  past_due_since: Date | null;
  current_period_end: Date | null;
  accounts_in_use: string;
}

/**
 * Resolve a user's entitlement.
 *
 * A user with no subscription row is 'none' rather than an error: that is a
 * signed-up customer who has not paid yet, which is a normal state.
 */
export async function entitlementForUser(
  userId: string,
  now: Date = new Date()
): Promise<UserEntitlement> {
  const r = await query<Row>(
    `SELECT u.role,
            s.status, s.tier_id, s.past_due_since, s.current_period_end,
            (SELECT COUNT(*) FROM broker_accounts ba
              WHERE ba.user_id = u.id AND ba.is_active = true) AS accounts_in_use
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  const row = r.rows[0];

  if (!row) {
    // Unknown user: no trading, no accounts. Never throws — this sits on the
    // signal path and a lookup miss must degrade to "not entitled", not to an
    // exception that takes down alert processing for every other account.
    const state: SubscriptionState = {
      status: 'none', tierId: null, pastDueSince: null, currentPeriodEnd: null,
    };
    return { ...entitlementFor(state, now), userId, status: 'none', accountsInUse: 0 };
  }

  const state: SubscriptionState = {
    status: parseStripeStatus(row.status),
    tierId: row.tier_id,
    pastDueSince: row.past_due_since,
    currentPeriodEnd: row.current_period_end,
  };

  return {
    ...entitlementFor(state, now, row.role),
    userId,
    status: state.status,
    accountsInUse: parseInt(row.accounts_in_use ?? '0', 10),
  };
}

/** Tier account allowance check, using live usage. */
export async function checkTierAccountAllowance(
  userId: string
): Promise<{ allowed: boolean; reason?: string; entitlement: UserEntitlement }> {
  const entitlement = await entitlementForUser(userId);
  const verdict = canAddAccountOnTier(entitlement, entitlement.accountsInUse);
  return { ...verdict, entitlement };
}
