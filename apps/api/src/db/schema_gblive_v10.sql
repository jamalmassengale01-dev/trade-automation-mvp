-- Daily-loss-cap provenance.
--
-- Some firms (Phidias, for one) publish no daily loss limit at all. The
-- arithmetic for a self-imposed cap is identical to a firm-imposed one, so
-- every existing calculation works unchanged — but the failure mode does not.
-- A firm cap is enforced by the broker: if our day-P&L accounting drifts, the
-- firm flattens the account and our bug surfaces as a rejected order. A
-- self-imposed cap is enforced only here, so the same drift silently removes
-- the limit. That difference has to be recorded, not inferred from whether a
-- number happens to look round.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS daily_loss_cap_source TEXT NOT NULL DEFAULT 'firm';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'presets_daily_loss_cap_source_check'
    ) THEN
        ALTER TABLE presets
            ADD CONSTRAINT presets_daily_loss_cap_source_check
            CHECK (daily_loss_cap_source IN ('firm', 'internal'));
    END IF;
END $$;

COMMENT ON COLUMN presets.daily_loss_cap_source IS
    'firm = the prop firm enforces the daily cap; internal = self-imposed because the firm publishes none, and EdgePilot is the only enforcement.';
