-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA v9
-- Daily-loss-limit safety buffer.
-- Idempotent: safe to run repeatedly.
-- ============================================
--
-- The firm measures its daily loss limit on total equity including unrealized;
-- the gate measures realized only. Those are near-equivalent here because the
-- account holds one trade at a time and that trade's worst case is bounded by
-- the step risk just approved — but commissions and slippage are counted by
-- neither, so actual loss runs a little above planned loss with zero margin.
--
-- 10% is deliberately well inside the point where it would cost a trade: on
-- the Apex 50K ladder any buffer up to ~$336 declines nothing that currently
-- happens, because step 3 ($668) is already unreachable after two losses.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS dll_buffer_pct DECIMAL(5,2) NOT NULL DEFAULT 10;

COMMENT ON COLUMN presets.dll_buffer_pct IS
    'Percent of daily_loss_cap held back for commissions and slippage before the gate compares.';
