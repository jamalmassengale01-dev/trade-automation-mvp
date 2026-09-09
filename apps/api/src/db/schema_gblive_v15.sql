-- Account category and size, so per-firm account caps can be enforced.
--
-- accountLimits.ts models the caps (Apex 20 PAs; Phidias 5 CASH Fundamental +
-- 5 CASH Premium + 5 E2L with 150K counting double) but had nothing to count.
-- broker_accounts recorded neither which category an account belongs to nor how
-- big it is, so the cap could be described and not applied.
--
-- Size is stored on the account rather than read from the preset because the
-- two are not the same fact. A preset is which RULES an account trades under
-- and can be reassigned; the size is what the firm sold, it never changes, and
-- a Phidias 150K consumes two slots whichever preset is pointed at it.
ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS account_category TEXT,
    ADD COLUMN IF NOT EXISTS account_size     INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broker_accounts_category_check') THEN
        ALTER TABLE broker_accounts ADD CONSTRAINT broker_accounts_category_check
            CHECK (account_category IS NULL OR account_category IN
                ('eval', 'pa', 'cash_fundamental', 'cash_premium', 'e2l'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broker_accounts_size_check') THEN
        ALTER TABLE broker_accounts ADD CONSTRAINT broker_accounts_size_check
            CHECK (account_size IS NULL OR account_size > 0);
    END IF;
END $$;

COMMENT ON COLUMN broker_accounts.account_category IS
    'Which cap this account counts against. NULL = not a prop-firm account (mock, generic copier) and uncounted.';
COMMENT ON COLUMN broker_accounts.account_size IS
    'Account size in dollars as sold by the firm. Drives slot weight — a Phidias 150K CASH counts as two.';

-- Backfill from the preset where one is assigned. This is a best guess for
-- existing rows, not a rule: phase tells us eval vs funded, and Apex funded
-- accounts are PAs. Anything ambiguous is left NULL and therefore uncounted,
-- which is the safe direction — an uncounted account cannot wrongly block a
-- legitimate purchase.
UPDATE broker_accounts ba
   SET account_size = p.start_balance::int
  FROM presets p
 WHERE p.id = ba.preset_id AND ba.account_size IS NULL;

UPDATE broker_accounts ba
   SET account_category = CASE
         WHEN p.phase = 'eval' THEN 'eval'
         WHEN p.prop_firm = 'apex' AND p.phase = 'funded' THEN 'pa'
         WHEN p.prop_firm = 'phidias' AND p.id LIKE '%prem%' THEN 'cash_premium'
         WHEN p.prop_firm = 'phidias' AND p.id LIKE '%fund%' THEN 'cash_fundamental'
         ELSE NULL
       END
  FROM presets p
 WHERE p.id = ba.preset_id AND ba.account_category IS NULL;

CREATE INDEX IF NOT EXISTS idx_broker_accounts_user_category
    ON broker_accounts (user_id, account_category)
    WHERE account_category IS NOT NULL;
