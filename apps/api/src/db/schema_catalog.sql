-- ============================================
-- EDGEPILOT — FIRM RULE CATALOG (v6)
-- Idempotent: safe to run repeatedly.
-- ============================================
--
-- The catalog is what a customer picks from: "Apex 50K EOD Eval". They type
-- nothing. Knowing what Apex's rules are is the product's job, not theirs — a
-- customer who mistypes a daily loss cap gets an account sized from fiction.
--
-- Layering, deliberately:
--
--   catalog_entries   the SKU a customer chooses. Stable identity.
--   catalog_versions  append-only history of that SKU's numbers over time.
--   presets           UNCHANGED — still exactly what the executor reads.
--
-- Publishing a version updates the entry's preset row in place and appends a
-- version row. Accounts pick up new numbers on their next trade with no
-- reassignment, and the executor needs no knowledge of any of this.

CREATE TABLE IF NOT EXISTS catalog_entries (
    id              TEXT PRIMARY KEY,              -- apex_50k_eod_eval
    -- The preset this entry drives. One entry owns exactly one preset.
    preset_id       TEXT NOT NULL UNIQUE REFERENCES presets(id) ON DELETE RESTRICT,
    display_name    TEXT NOT NULL,                 -- "Apex 50K EOD Eval"
    prop_firm       TEXT NOT NULL,                 -- apex, tradeify, mffu
    account_size    INTEGER NOT NULL,              -- 50000
    phase           TEXT NOT NULL CHECK (phase IN ('eval', 'funded')),
    description     TEXT,
    -- Unpublished entries are drafts: admins see them, customers never do.
    is_published    BOOLEAN NOT NULL DEFAULT false,
    sort_order      INTEGER NOT NULL DEFAULT 100,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_published
    ON catalog_entries (is_published, sort_order);

COMMENT ON TABLE catalog_entries IS
    'Customer-facing prop firm SKUs. Customers pick one; they never enter rule values.';

-- Append-only. Never UPDATE a published row — an audit trail that can be
-- rewritten answers no questions about what an account was trading under.
CREATE TABLE IF NOT EXISTS catalog_versions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_id       TEXT NOT NULL REFERENCES catalog_entries(id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    -- Full snapshot of the preset field values this version published.
    preset_values  JSONB NOT NULL,
    -- The raw prop-firm inputs fed to the calculator, when derived that way.
    derived_from   JSONB,
    -- Calculator findings at publish time (unreachable steps, cap collisions).
    findings       JSONB NOT NULL DEFAULT '[]'::jsonb,
    changelog      TEXT,
    published_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    published_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- When the firm's rules themselves took effect, if different from publish.
    effective_from DATE,
    UNIQUE (entry_id, version)
);

CREATE INDEX IF NOT EXISTS idx_catalog_versions_entry
    ON catalog_versions (entry_id, version DESC);

COMMENT ON TABLE catalog_versions IS
    'Append-only history of each catalog entry. Never updated after publish.';

-- Which catalog entry an account was assigned from, and at which version.
-- Lets the fleet view flag accounts running numbers that have since changed.
ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS catalog_entry_id      TEXT REFERENCES catalog_entries(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS catalog_version_at_assign INTEGER;

-- ---- Adopt the existing presets as catalog entries ---------------------
-- These already power live accounts. Left UNPUBLISHED on purpose: none has
-- been verified against a firm's rules page yet (presets.verified_at is NULL
-- for all of them), and publishing an unverified rule set to customers is the
-- exact failure this layer exists to prevent. Verify, then publish.
INSERT INTO catalog_entries
    (id, preset_id, display_name, prop_firm, account_size, phase, description, is_published, sort_order, current_version)
SELECT
    p.id, p.id, p.name, p.prop_firm, p.start_balance::INTEGER, p.phase,
    p.notes, false,
    CASE p.phase WHEN 'eval' THEN 100 ELSE 200 END,
    1
FROM presets p
ON CONFLICT (id) DO NOTHING;

-- Seed version 1 for each adopted entry from its current preset values.
INSERT INTO catalog_versions (entry_id, version, preset_values, changelog)
SELECT
    ce.id, 1,
    to_jsonb(p) - 'created_at' - 'derived_from',
    'Imported from the pre-catalog preset table.'
FROM catalog_entries ce
JOIN presets p ON p.id = ce.preset_id
WHERE NOT EXISTS (
    SELECT 1 FROM catalog_versions cv WHERE cv.entry_id = ce.id AND cv.version = 1
);

-- Backfill the assignment pointer for accounts already on one of these presets.
UPDATE broker_accounts ba
SET catalog_entry_id = ce.id,
    catalog_version_at_assign = ce.current_version
FROM catalog_entries ce
WHERE ba.preset_id = ce.preset_id AND ba.catalog_entry_id IS NULL;
