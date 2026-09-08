-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA v4
-- Rule reconciliation + preset provenance.
-- Idempotent: safe to run repeatedly.
-- ============================================

-- ---- Preset provenance -------------------------------------------------
-- A prop firm's DLL and max drawdown are enforced firm-side and are NOT
-- exposed by the Tradovate API, so they cannot be fetched and verified
-- automatically. The honest mechanism is a human confirming them against the
-- firm's rules page on a cadence, and the software making the age of that
-- confirmation impossible to ignore.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_by      TEXT,
    ADD COLUMN IF NOT EXISTS source_url       TEXT,
    ADD COLUMN IF NOT EXISTS stale_after_days INTEGER NOT NULL DEFAULT 90;

COMMENT ON COLUMN presets.verified_at IS
    'When a human last confirmed these numbers against the firm''s published rules.';
COMMENT ON COLUMN presets.stale_after_days IS
    'Days after verified_at before this preset is surfaced as stale.';

-- Seeded presets have never been verified by a human against a live rules
-- page, so leave verified_at NULL rather than backfilling a fake timestamp —
-- "never verified" is the truthful state and the UI should say so.

-- ---- Rule reconciliation results ---------------------------------------
-- One row per check. The executor reads the newest row per account rather
-- than calling the broker inline, so a signal is never delayed by a broker
-- round-trip and a broker outage cannot stall execution.
CREATE TABLE IF NOT EXISTS account_rule_checks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_account_id   UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    preset_id           TEXT,
    checked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- ok | warn | halt | error
    verdict             TEXT NOT NULL,
    -- What the broker reported at check time (ground truth).
    broker_balance      DECIMAL(12,2),
    broker_realized_pnl DECIMAL(12,2),
    broker_equity       DECIMAL(12,2),
    -- What we believed at check time.
    tracked_day_pnl     DECIMAL(12,2),
    tracked_cum_pnl     DECIMAL(12,2),
    implied_start       DECIMAL(12,2),
    findings            JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_rule_checks_account_time
    ON account_rule_checks (broker_account_id, checked_at DESC);

COMMENT ON TABLE account_rule_checks IS
    'Rule reconciliation: preset assumptions vs what the broker actually reports.';
