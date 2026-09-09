-- Consistency rule and evaluation minimum trading days.
--
-- Both were previously constants. services/launchpad.ts selected a literal
-- `50 AS p_consistency_pct`, so every account in the system was judged against
-- Apex's 50% rule regardless of which firm it belonged to. That is wrong in
-- the permissive direction for a stricter firm: Phidias enforces 30% on funded
-- CASH accounts, so a payout the dashboard called eligible would be refused by
-- the firm. Being told a payout is ready when it is blocked is worse than not
-- being told, because it is acted on.
--
-- NULL / 0 means the firm imposes no consistency rule at all — which is not
-- hypothetical, it is Phidias' evaluation phase. consistencyStatus() already
-- treats 0 as "nothing can dominate, always ok", so the semantics line up
-- without a special case.
--
-- min_trading_days is the EVALUATION requirement (Apex 1, Phidias Fundamental
-- 3, Phidias Premium 1). It is deliberately NOT the same thing as
-- required_qualifying_days, which is the funded-phase gap between payouts —
-- conflating them would let an eval preset silently inherit a payout cadence.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS consistency_pct  DECIMAL(5,2),
    ADD COLUMN IF NOT EXISTS min_trading_days INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presets_consistency_pct_check') THEN
        ALTER TABLE presets ADD CONSTRAINT presets_consistency_pct_check
            CHECK (consistency_pct IS NULL OR (consistency_pct >= 0 AND consistency_pct <= 100));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presets_min_trading_days_check') THEN
        ALTER TABLE presets ADD CONSTRAINT presets_min_trading_days_check
            CHECK (min_trading_days >= 0);
    END IF;
END $$;

COMMENT ON COLUMN presets.consistency_pct IS
    'No single day may be >= this percent of profit since the last payout. NULL or 0 = the firm imposes no consistency rule.';
COMMENT ON COLUMN presets.min_trading_days IS
    'Minimum trading days to PASS AN EVALUATION. Distinct from required_qualifying_days, which is the funded gap between payouts.';

-- Backfill the rules as each firm publishes them.
UPDATE presets SET consistency_pct = 50, min_trading_days = 1
WHERE prop_firm = 'apex' AND consistency_pct IS NULL;

-- Phidias: no consistency rule during evaluation, 30% once funded.
UPDATE presets SET consistency_pct = NULL, min_trading_days = 3
WHERE id = 'phidias_fund_50k_eval';
UPDATE presets SET consistency_pct = 30, min_trading_days = 3
WHERE id = 'phidias_fund_50k_cash';
UPDATE presets SET consistency_pct = NULL, min_trading_days = 1
WHERE id = 'phidias_prem_50k_eval';
UPDATE presets SET consistency_pct = 30, min_trading_days = 1
WHERE id = 'phidias_prem_50k_cash';
