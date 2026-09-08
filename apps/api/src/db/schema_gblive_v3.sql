-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA v3
-- Prop firm calculator provenance.
-- Idempotent: safe to run repeatedly.
-- ============================================

-- Stores the raw prop-firm rulebook inputs a preset was derived from, so a
-- preset can be re-derived when a firm changes its rules without anyone having
-- to reconstruct which numbers produced base_risk / cap_step / step multipliers.
-- Shape: { calculator_version, derived_at, inputs: {...}, findings: [...] }
-- NULL means the preset was hand-entered rather than calculated.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS derived_from JSONB;

COMMENT ON COLUMN presets.derived_from IS
    'Raw prop-firm inputs + findings from the prop firm calculator. NULL if hand-entered.';
