/**
 * Stripe subscriptions.
 *
 * THREE THINGS THIS FILE EXISTS TO GET RIGHT
 *
 * 1. SIGNATURE VERIFICATION OVER THE RAW BODY. Stripe signs the exact bytes it
 *    sent. `express.json()` parses and discards them, and re-serialising the
 *    parsed object does not reproduce the original — key order and whitespace
 *    differ — so verification against a re-stringified body fails, and the
 *    usual "fix" is to skip verification. An unverified billing webhook is a
 *    free-subscription endpoint: anyone who knows the URL can POST
 *    `customer.subscription.updated` with status active. The route is mounted
 *    with express.raw() BEFORE the global JSON parser for this reason.
 *
 * 2. IDEMPOTENCY. Stripe retries and does not promise exactly-once delivery.
 *    Every event id is recorded before its effects are applied, so a redelivery
 *    is recognised and skipped.
 *
 * 3. THE PRICE COMES FROM THE SERVER. Checkout sessions are created from price
 *    IDs held in config, never from anything the client sends. A client-chosen
 *    price is a client-chosen bill.
 */

import Stripe from 'stripe';
import { query } from '../db';
import { parseStripeStatus, TierId } from '../strategy/subscription';
import logger from '../utils/logger';

const log = logger.child({ context: 'Stripe' });

const SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

/** Price IDs per tier, from the Stripe dashboard. Never client-supplied. */
const PRICE_BY_TIER: Record<TierId, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  pro:     process.env.STRIPE_PRICE_PRO ?? '',
  fleet:   process.env.STRIPE_PRICE_FLEET ?? '',
};

let client: Stripe | null = null;

/** Null when Stripe is not configured — billing routes then 503 rather than crash. */
export function stripeClient(): Stripe | null {
  if (!SECRET_KEY) return null;
  if (!client) client = new Stripe(SECRET_KEY);
  return client;
}

export function stripeConfigured(): boolean {
  return Boolean(SECRET_KEY && WEBHOOK_SECRET);
}

/** Which tiers have a price configured and can actually be sold. */
export function sellableTiers(): TierId[] {
  return (Object.keys(PRICE_BY_TIER) as TierId[]).filter((t) => PRICE_BY_TIER[t]);
}

// ---------------------------------------------------------------------------
// Customer + checkout
// ---------------------------------------------------------------------------

/** The user's Stripe customer, created on first need. */
async function ensureCustomer(userId: string): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Stripe is not configured');

  const existing = await query<{ stripe_customer_id: string | null; email: string; name: string }>(
    'SELECT stripe_customer_id, email, name FROM users WHERE id = $1',
    [userId]
  );
  const row = existing.rows[0];
  if (!row) throw new Error('User not found');
  if (row.stripe_customer_id) return row.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: row.email,
    name: row.name,
    metadata: { edgepilot_user_id: userId },
  });

  await query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [userId, customer.id]);
  log.info('Created Stripe customer', { userId, customerId: customer.id });
  return customer.id;
}

export interface CheckoutInput {
  userId: string;
  tier: TierId;
  successUrl: string;
  cancelUrl: string;
}

/** A Checkout session for a subscription. Returns the URL to redirect to. */
export async function createCheckoutSession(input: CheckoutInput): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Stripe is not configured');

  const price = PRICE_BY_TIER[input.tier];
  if (!price) throw new Error(`No Stripe price configured for tier '${input.tier}'`);

  const customerId = await ensureCustomer(input.userId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // Carried onto the subscription so a webhook can attribute it without
    // depending on a customer lookup that may race with creation.
    subscription_data: { metadata: { edgepilot_user_id: input.userId, tier: input.tier } },
    metadata: { edgepilot_user_id: input.userId, tier: input.tier },
  });

  if (!session.url) throw new Error('Stripe returned a session with no URL');
  return session.url;
}

/** Billing portal session, so customers manage cards and cancellations in Stripe. */
export async function createPortalSession(userId: string, returnUrl: string): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  const customerId = await ensureCustomer(userId);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** Tier from a subscription's price, falling back to its metadata. */
function tierFromSubscription(sub: Stripe.Subscription): TierId | null {
  const priceId = sub.items.data[0]?.price?.id;
  for (const [tier, id] of Object.entries(PRICE_BY_TIER)) {
    if (id && id === priceId) return tier as TierId;
  }
  const meta = sub.metadata?.tier;
  return meta && ['starter', 'pro', 'fleet'].includes(meta) ? (meta as TierId) : null;
}

async function userIdForSubscription(sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.edgepilot_user_id;
  if (fromMeta) return fromMeta;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;
  const r = await query<{ id: string }>('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
  return r.rows[0]?.id ?? null;
}

/** Mirror a Stripe subscription into our table. */
async function upsertSubscription(sub: Stripe.Subscription): Promise<void> {
  const userId = await userIdForSubscription(sub);
  if (!userId) {
    log.error('Subscription webhook for an unknown user — mirror not updated', {
      subscriptionId: sub.id,
    });
    return;
  }

  const status = parseStripeStatus(sub.status);
  const tier = tierFromSubscription(sub);
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer!.id;
  const periodEndUnix = (sub as unknown as { current_period_end?: number }).current_period_end;
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;

  // past_due_since is set on the FIRST transition into past_due and cleared on
  // recovery. Overwriting it on every retry would keep pushing the grace
  // deadline forward and the customer would never actually be cut off.
  await query(
    `INSERT INTO subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
        tier_id, status, current_period_end, cancel_at_period_end,
        past_due_since, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $6 = 'past_due' THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id        = EXCLUDED.stripe_price_id,
       tier_id                = EXCLUDED.tier_id,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end,
       cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
       past_due_since = CASE
         WHEN EXCLUDED.status <> 'past_due' THEN NULL
         WHEN subscriptions.past_due_since IS NOT NULL THEN subscriptions.past_due_since
         ELSE NOW()
       END,
       updated_at = NOW()`,
    [
      userId, customerId, sub.id, sub.items.data[0]?.price?.id ?? null,
      tier, status, periodEnd, sub.cancel_at_period_end === true,
    ]
  );

  log.info('Subscription mirrored', { userId, status, tier, subscriptionId: sub.id });

  // A lapse is money and access changing hands — it belongs in the alert
  // stream, not only in a table.
  if (status === 'past_due' || status === 'unpaid' || status === 'canceled') {
    await query(
      `INSERT INTO risk_events (type, rule_type, message, details, created_at)
       VALUES ('warning', $1, $2, $3, NOW())`,
      [
        `subscription_${status}`,
        `Subscription for user ${userId} is ${status}. New trades stop when the grace window ends; ` +
        'open positions continue to be managed.',
        JSON.stringify({ userId, subscriptionId: sub.id, tier }),
      ]
    ).catch(() => undefined);
  }
}

export interface WebhookResult {
  received: true;
  eventId: string;
  type: string;
  duplicate: boolean;
  handled: boolean;
}

/**
 * Verify and handle a Stripe webhook.
 *
 * `rawBody` must be the exact bytes Stripe sent. Throws on a bad signature —
 * the caller returns 400 and nothing is applied.
 */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult> {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set');

  // Throws on tampering, on a wrong secret, and on a replayed old timestamp.
  const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);

  // Claim the event id first. A unique violation means a redelivery, and the
  // effects below are skipped rather than applied twice.
  const claim = await query(
    `INSERT INTO stripe_events (id, type, payload) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [event.id, event.type, JSON.stringify({ type: event.type })]
  );
  if (claim.rowCount === 0) {
    log.info('Duplicate Stripe event ignored', { eventId: event.id, type: event.type });
    return { received: true, eventId: event.id, type: event.type, duplicate: true, handled: false };
  }

  let handled = true;
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await upsertSubscription(event.data.object as Stripe.Subscription);
      break;

    case 'checkout.session.completed': {
      // The subscription object on this event is a reference; fetch the real
      // one so the mirror records its actual status and period rather than
      // whatever the session happened to carry.
      const session = event.data.object as Stripe.Checkout.Session;
      const subId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;
      if (subId) await upsertSubscription(await stripe.subscriptions.retrieve(subId));
      break;
    }

    case 'invoice.payment_failed':
    case 'invoice.paid': {
      const invoice = event.data.object as unknown as { subscription?: string | { id: string } };
      const subId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id;
      if (subId) await upsertSubscription(await stripe.subscriptions.retrieve(subId));
      break;
    }

    default:
      handled = false;
  }

  return { received: true, eventId: event.id, type: event.type, duplicate: false, handled };
}

/**
 * Re-read a user's subscription from Stripe and rewrite the mirror.
 *
 * Webhooks get missed — an endpoint down for an hour, a secret rotated
 * mid-flight. Without a way to re-sync, a missed event is permanent divergence
 * between what a customer pays for and what they get.
 */
export async function resyncSubscription(userId: string): Promise<boolean> {
  const stripe = stripeClient();
  if (!stripe) return false;

  const r = await query<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM users WHERE id = $1', [userId]
  );
  const customerId = r.rows[0]?.stripe_customer_id;
  if (!customerId) return false;

  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1, status: 'all' });
  const sub = subs.data[0];
  if (!sub) return false;

  await upsertSubscription(sub);
  return true;
}
