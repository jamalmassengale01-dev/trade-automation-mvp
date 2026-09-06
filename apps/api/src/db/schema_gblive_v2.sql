-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA ADDITIONS v2
-- Idempotent: safe to run repeatedly.
--
-- Makes the risk ladder, sniper mode, and day-lockout fully preset-driven
-- (editable via the Presets dashboard / API) instead of hardcoded constants,
-- and corrects two mismatches found against the real GB LIVE v5 Pine Script:
--   1. Ladder step multipliers are per-preset (Apex EOD presets use 1/1/2/4,
--      not a single global 1/1/2/3 — the multiplier depends on the preset's
--      own TP R and daily loss cap, since each step must fully recover all
--      prior losses in one win).
--   2. The real strategy uses a 4-step ladder with a "day lockout" on a
--      Step-4 loss (stop trading for the rest of the broker day, ladder
--      resets to Step 1 next day) — not a hard clamp at Step 3.
-- ============================================

-- ============================================
-- 1. PRESETS — per-preset ladder, sniper, and cap-step fields
-- ============================================
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS step2_mult           DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS step3_mult           DECIMAL(4,2) NOT NULL DEFAULT 2.0,
    ADD COLUMN IF NOT EXISTS step4_mult           DECIMAL(4,2) NOT NULL DEFAULT 4.0,
    -- Sniper Mode: when an account's progress toward preset.target_profit is
    -- within pass_zone_buffer dollars, risk switches from the ladder to a
    -- single reduced-risk, single-R "sniper" trade to finish the target safely.
    ADD COLUMN IF NOT EXISTS pass_zone_buffer      DECIMAL(10,2) NOT NULL DEFAULT 200,
    ADD COLUMN IF NOT EXISTS sniper_risk_pct       DECIMAL(5,2)  NOT NULL DEFAULT 50,   -- % of remaining target risked
    ADD COLUMN IF NOT EXISTS sniper_tp_r           DECIMAL(4,2)  NOT NULL DEFAULT 1.0,  -- both TP1 and TP2 at this R
    ADD COLUMN IF NOT EXISTS sniper_max_trades_day INTEGER       NOT NULL DEFAULT 2;

-- Correct cap_step to 4 (real strategy) — previous value of 3 under-escalated
-- risk relative to the actual GB LIVE ladder and never exercised day-lockout.
UPDATE presets SET cap_step = 4 WHERE cap_step = 3;

-- Per-preset step multipliers, matching the real script's per-preset blocks.
UPDATE presets SET step2_mult = 1.0, step3_mult = 2.0, step4_mult = 4.0 WHERE id = 'apex_50k_eod_eval';
UPDATE presets SET step2_mult = 1.0, step3_mult = 2.0, step4_mult = 2.0 WHERE id = 'apex_50k_eval_rush';
UPDATE presets SET step2_mult = 1.0, step3_mult = 2.0, step4_mult = 2.0 WHERE id = 'apex_50k_pa_funded';
UPDATE presets SET step2_mult = 1.0, step3_mult = 2.0, step4_mult = 4.0 WHERE id = 'tradeify_select_25k';

-- ============================================
-- 2. BROKER ACCOUNTS — target progress + day lockout
-- ============================================
ALTER TABLE broker_accounts
    -- Realized P&L since the account was assigned its preset (or since last
    -- reset). Drives remaining-target / Sniper Mode eligibility. Distinct from
    -- day_realized_pnl, which resets nightly at the 6PM ET broker-day boundary.
    ADD COLUMN IF NOT EXISTS cumulative_pnl DECIMAL(12,2) NOT NULL DEFAULT 0,
    -- Set when a Step-N loss occurs at the preset's cap_step (a "Step 4 loss").
    -- Blocks further entries for the rest of the broker day even if the
    -- trades-per-day count hasn't been reached; clears on day rollover.
    ADD COLUMN IF NOT EXISTS day_locked_out BOOLEAN NOT NULL DEFAULT false;

-- ============================================
-- 3. GB TRADES — per-trade R multiples (so Sniper trades can use 1R/1R
--    independent of the account's preset default) and a sniper flag
-- ============================================
ALTER TABLE gb_trades
    ADD COLUMN IF NOT EXISTS tp1_r     DECIMAL(4,2),
    ADD COLUMN IF NOT EXISTS tp2_r     DECIMAL(4,2),
    ADD COLUMN IF NOT EXISTS is_sniper BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing rows from their account's preset so nothing is left null.
UPDATE gb_trades gt
SET tp1_r = COALESCE(gt.tp1_r, p.tp1_r), tp2_r = COALESCE(gt.tp2_r, p.tp2_r)
FROM broker_accounts ba
JOIN presets p ON p.id = ba.preset_id
WHERE gt.broker_account_id = ba.id AND (gt.tp1_r IS NULL OR gt.tp2_r IS NULL);
