-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA v8
-- PA scaling tiers.
-- Idempotent: safe to run repeatedly.
-- ============================================
--
-- A funded Apex PA scales BOTH its position limit and its daily loss limit with
-- account profit. The headline "40 micro" on a 50K PA is the ceiling; a freshly
-- activated account is capped at 20. Sizing to the ceiling gets the order
-- rejected by Apex, which costs no penalty but silently skips the trade.
--
-- Stored as JSONB on the preset so a tier table travels with the catalog
-- version that published it, rather than living in a separate table that could
-- drift out of step with the rules it belongs to.
--   [{ level, minProfit, maxProfit|null, maxContracts, dailyLossCap }, ...]
-- NULL means the account does not scale (every evaluation).
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS scaling_tiers JSONB;

COMMENT ON COLUMN presets.scaling_tiers IS
    'PA scaling bands in MICRO contracts. NULL for non-scaling accounts.';

-- Apex sets the tier once per day from the prior session's CLOSING balance and
-- never changes it mid-session. Resolving from live cumulative P&L would let
-- size shift while a trade is open, which is not how the account behaves — so
-- the basis is snapshotted at the broker-day roll and held for the session.
ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS tier_basis_pnl DECIMAL(12,2);

COMMENT ON COLUMN broker_accounts.tier_basis_pnl IS
    'Cumulative P&L snapshot at the broker-day roll; fixes the scaling tier for the session.';

-- Seed the published Apex EOD PA table for the 50K funded preset (micros).
UPDATE presets SET scaling_tiers = '[
  {"level":1,"minProfit":0,"maxProfit":1499,"maxContracts":20,"dailyLossCap":1000},
  {"level":2,"minProfit":1500,"maxProfit":2999,"maxContracts":30,"dailyLossCap":1000},
  {"level":3,"minProfit":3000,"maxProfit":5999,"maxContracts":40,"dailyLossCap":2000},
  {"level":4,"minProfit":6000,"maxProfit":null,"maxContracts":40,"dailyLossCap":3000}
]'::jsonb
WHERE id = 'apex_50k_pa_funded' AND scaling_tiers IS NULL;

-- Existing funded accounts have no snapshot yet; seed from what they have.
UPDATE broker_accounts SET tier_basis_pnl = cumulative_pnl WHERE tier_basis_pnl IS NULL;
