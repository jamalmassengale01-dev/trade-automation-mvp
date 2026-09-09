-- Per-firm trading day boundary and flatten time.
--
-- Both were hardcoded to Apex: the broker day rolled at 6:00 PM ET and
-- positions flattened at 4:55 PM ET. Neither is universal. Phidias ends its
-- session at 10:00 PM UTC+2 — about 4:00 PM ET — and forbids overnight holds
-- on Fundamental accounts, so an Apex-shaped flatten runs an hour after that
-- firm's day has already closed.
--
-- The boundary is stored as an hour in a named IANA zone rather than a UTC
-- offset so each firm's own daylight-saving rule applies to its own boundary.
-- EU and US clocks change on different dates, and for the week between them a
-- fixed offset is silently an hour wrong.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS broker_day_tz   TEXT    NOT NULL DEFAULT 'America/New_York',
    ADD COLUMN IF NOT EXISTS broker_day_hour INTEGER NOT NULL DEFAULT 18,
    -- Minutes past midnight in broker_day_tz at which open positions are
    -- flattened. NULL disables the sweep for firms that permit overnight holds.
    ADD COLUMN IF NOT EXISTS flatten_minute  INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presets_broker_day_hour_check') THEN
        ALTER TABLE presets ADD CONSTRAINT presets_broker_day_hour_check
            CHECK (broker_day_hour BETWEEN 0 AND 23);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presets_flatten_minute_check') THEN
        ALTER TABLE presets ADD CONSTRAINT presets_flatten_minute_check
            CHECK (flatten_minute IS NULL OR flatten_minute BETWEEN 0 AND 1439);
    END IF;
END $$;

-- Existing Apex presets keep the behaviour they already had.
UPDATE presets SET flatten_minute = 16 * 60 + 55
WHERE flatten_minute IS NULL AND prop_firm = 'apex';

COMMENT ON COLUMN presets.broker_day_tz IS
    'IANA zone in which broker_day_hour is expressed. Apex: America/New_York. Phidias: Europe/Paris.';
