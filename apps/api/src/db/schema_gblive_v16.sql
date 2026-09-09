-- Notifications.
--
-- Every alert this system raises has until now landed in risk_events, which is
-- an audit trail: it records what happened but tells nobody. All six of the
-- automated actions described in CLAUDE.md — eval passed, payout eligible, PA
-- complete, eval blown, no activity, DLL approaching — end at "send customer
-- notification" and there was no channel to send one on.
--
-- Notifications are DERIVED from risk_events rather than raised alongside them.
-- Eleven call sites already write risk_events; asking each to also decide
-- whether a human cares would scatter that judgement across the codebase and
-- guarantee it drifts. The dispatcher reads the trail and decides once.
CREATE TABLE IF NOT EXISTS notifications (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    risk_event_id UUID REFERENCES risk_events(id) ON DELETE SET NULL,
    account_id    UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,

    severity      TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}',

    -- Collapses repeats of the same condition on the same account. The rule
    -- reconciler re-raises a standing halt every 15 minutes; without this the
    -- channel produces 96 identical messages a day and stops being read.
    dedupe_key    TEXT NOT NULL,

    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at       TIMESTAMPTZ
);

-- The dispatcher's two hot paths: find work, and find the last send for a key.
CREATE INDEX IF NOT EXISTS idx_notifications_pending
    ON notifications (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications (dedupe_key, sent_at DESC) WHERE status = 'sent';

-- How far the dispatcher has read. A cursor rather than a flag on risk_events,
-- so the audit trail stays append-only and a dispatcher bug cannot corrupt it.
CREATE TABLE IF NOT EXISTS notification_cursor (
    id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_event_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Start from now, not from the beginning of time: replaying the entire history
-- of risk_events into a freshly configured channel would deliver a wall of
-- stale alerts and immediately teach the reader to ignore it.
INSERT INTO notification_cursor (id, last_event_at)
VALUES (1, NOW())
ON CONFLICT (id) DO NOTHING;
