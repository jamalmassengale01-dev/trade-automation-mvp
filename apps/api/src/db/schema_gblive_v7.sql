-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA v7
-- Inactivity tracking.
-- Idempotent: safe to run repeatedly.
-- ============================================
--
-- Apex's account pages list "Inactivity Policy: YES" for both eval and PA
-- accounts, which means an idle account can be closed rather than merely
-- criticised. The exact window is not stated on the pricing page, so this is
-- configurable per preset rather than hardcoded to a number we would be
-- guessing at.
--
-- The realistic failure this guards is silent: a TradingView alert expires, a
-- webhook stops firing, and nothing appears wrong because no errors occur —
-- there is simply an absence of trades. Absence is exactly what monitoring
-- built around events fails to notice.

ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS inactivity_alert_days INTEGER NOT NULL DEFAULT 7;

COMMENT ON COLUMN presets.inactivity_alert_days IS
    'Days without a trade before the account is flagged as at risk under the '
    'firm''s inactivity policy. 0 disables the check.';
