-- ============================================
-- EDGEPILOT — LAUNCHPAD (v10)
-- Payout lifecycle for funded accounts.
-- Idempotent: safe to run repeatedly.
-- ============================================
--
-- The execution engine answers "should this trade fire?". This tracks the
-- thing that actually pays: eval -> funded PA -> 6 payouts -> restart.

-- ---- Preset payout rules ----------------------------------------------
-- Every one of these is a firm rule, so it belongs with the preset and
-- travels with the catalog version that published it.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS qualifying_day_threshold DECIMAL(10,2) NOT NULL DEFAULT 250,
    ADD COLUMN IF NOT EXISTS required_qualifying_days INTEGER      NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS min_payout               DECIMAL(10,2) NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS safety_net_buffer        DECIMAL(10,2) NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS payout_schedule          JSONB;

COMMENT ON COLUMN presets.qualifying_day_threshold IS
    'Minimum net daily profit for a day to count toward the payout requirement.';
COMMENT ON COLUMN presets.payout_schedule IS
    'Ordered per-payout caps. Array length is the maximum number of payouts.';

-- Apex EOD PA schedules, from the firm's payout table.
UPDATE presets SET payout_schedule = '[1500,1500,2000,2500,2500,3000]'::jsonb,
                   qualifying_day_threshold = 250
WHERE start_balance = 50000 AND payout_schedule IS NULL;

UPDATE presets SET payout_schedule = '[1000,1000,1000,1000,1000,1000]'::jsonb,
                   qualifying_day_threshold = 100
WHERE start_balance = 25000 AND payout_schedule IS NULL;

-- ---- Payouts -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS payouts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    broker_account_id UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    payout_number     INTEGER NOT NULL,
    amount            DECIMAL(12,2) NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'denied')),
    requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at       TIMESTAMPTZ,
    notes             TEXT,
    -- One row per payout number per account: a cycle has exactly six, and a
    -- duplicate #3 would silently corrupt every later eligibility check.
    UNIQUE (broker_account_id, payout_number)
);

CREATE INDEX IF NOT EXISTS idx_payouts_account ON payouts (broker_account_id, payout_number);

-- ---- Evaluation lifecycle ---------------------------------------------
CREATE TABLE IF NOT EXISTS evals (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    broker_account_id UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    prop_firm         TEXT NOT NULL,
    account_size      INTEGER NOT NULL,
    purchase_date     DATE NOT NULL,
    eval_cost         DECIMAL(10,2) NOT NULL DEFAULT 0,
    activation_cost   DECIMAL(10,2) NOT NULL DEFAULT 0,
    -- Apex evals expire 30 days from purchase with no resets, so a slow pass
    -- is a lost fee rather than a delayed one. Tracked per eval because it is
    -- a deadline, not a preference.
    expires_on        DATE,
    outcome           TEXT NOT NULL DEFAULT 'in_progress'
                      CHECK (outcome IN ('in_progress', 'passed', 'blown', 'expired')),
    pass_date         DATE,
    funded_date       DATE,
    -- 7 calendar days from the pass being marked, or the PA opportunity lapses.
    activation_deadline DATE,
    days_to_pass      INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evals_outcome ON evals (outcome, expires_on);
CREATE INDEX IF NOT EXISTS idx_evals_account ON evals (broker_account_id);

-- Qualifying days are DERIVED from account_daily_pnl rather than stored:
-- whether a day qualifies depends on the preset's threshold, which can change
-- when a firm updates its rules. Storing the verdict would freeze a judgement
-- made under rules that no longer apply.
