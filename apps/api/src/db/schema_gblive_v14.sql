-- Progressive profit splits, and payout schedules that do not end.
--
-- profit_split was a single number, which assumes the trader's share never
-- changes. Phidias Premium climbs 75 → 80 → 85 → 90 → 100% across the first
-- five payouts and stays at 100% after that, so a flat 0.75 understates a
-- mature account by a third. The seeded Premium presets carried exactly that
-- error, with the real schedule sitting in a notes string.
--
-- payout_schedule_repeats is the other half. Its LENGTH currently caps how many
-- payouts an account can take, which is right for Apex — six payouts totalling
-- $13,000 and the Performance Account closes — and wrong for Phidias, where the
-- $2,000 cap is per cycle and the CASH account keeps paying. Their rules are
-- explicit that "there is no financial penalty for staying simulated". Without
-- this flag the dashboard would stop reporting payouts on an account still
-- making them.
ALTER TABLE presets
    ADD COLUMN IF NOT EXISTS split_schedule          JSONB,
    ADD COLUMN IF NOT EXISTS payout_schedule_repeats BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presets_split_schedule_check') THEN
        ALTER TABLE presets ADD CONSTRAINT presets_split_schedule_check
            CHECK (split_schedule IS NULL OR jsonb_typeof(split_schedule) = 'array');
    END IF;
END $$;

COMMENT ON COLUMN presets.split_schedule IS
    'Trader share by payout number, e.g. [0.75,0.80,0.85,0.90,1.00]. The LAST entry persists for every later payout. NULL = the flat profit_split applies.';
COMMENT ON COLUMN presets.payout_schedule_repeats IS
    'False: payout_schedule length is the maximum number of payouts and the account closes after them (Apex). True: it is a repeating cycle cap and the account continues (Phidias).';

-- Phidias Premium CASH: progressive split, unlimited $2,000 cycles.
UPDATE presets
   SET split_schedule = '[0.75, 0.80, 0.85, 0.90, 1.00]'::jsonb,
       payout_schedule = '[2000]'::jsonb,
       payout_schedule_repeats = true,
       notes = 'Progressive split 75/80/85/90/100 by payout number, 100% from the 5th onward. '
               '$2,000 cap per cycle, repeating — the CASH account does not close. '
               'Cash Account Reset $399, once, within 24h of liquidation.'
 WHERE id = 'phidias_prem_50k_cash';

-- Phidias Fundamental CASH: flat 80/20, unlimited $2,000 cycles.
UPDATE presets
   SET split_schedule = NULL,
       payout_schedule = '[2000]'::jsonb,
       payout_schedule_repeats = true
 WHERE id = 'phidias_fund_50k_cash';

-- Apex is unchanged and must stay finite: the PA closes at payout six.
UPDATE presets SET payout_schedule_repeats = false WHERE prop_firm = 'apex';
