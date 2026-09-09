-- Stripe subscriptions.
--
-- Stripe is the source of truth for billing; this is a local mirror so the
-- executor can answer "may this account open a trade?" without a network call
-- on the signal path. The mirror is updated by webhook and can be re-synced
-- from Stripe, so a missed event is recoverable rather than permanent.
--
-- One row per user. Multi-subscription customers are not a thing here — a
-- customer is on one plan.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS subscriptions (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    stripe_customer_id     TEXT NOT NULL,
    stripe_subscription_id TEXT UNIQUE,
    stripe_price_id        TEXT,

    tier_id                TEXT CHECK (tier_id IN ('starter', 'pro', 'fleet')),
    status                 TEXT NOT NULL DEFAULT 'none',

    -- Set the first time a subscription enters past_due and cleared when it
    -- recovers. The grace window is measured from here rather than from the
    -- latest failed invoice, so repeated retries cannot keep resetting it.
    past_due_since         TIMESTAMPTZ,
    current_period_end     TIMESTAMPTZ,
    cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions (stripe_customer_id);

-- Processed webhook events, for idempotency.
--
-- Stripe retries deliveries and does not promise exactly-once. Without this a
-- retried invoice.paid could extend a period twice, and a retried
-- subscription.deleted could revoke access that was since restored. The event
-- id is Stripe's, so the same delivery is recognised however it arrives.
CREATE TABLE IF NOT EXISTS stripe_events (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload      JSONB
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_processed ON stripe_events (processed_at DESC);

COMMENT ON TABLE subscriptions IS
    'Local mirror of Stripe subscription state. Stripe is authoritative; re-sync rather than hand-edit.';
COMMENT ON COLUMN subscriptions.past_due_since IS
    'When the subscription first entered past_due. The grace window runs from here so retries cannot reset it.';
