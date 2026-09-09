-- Phidias presets, from the firm's own rules page.
--
-- Left as DRAFTS (verified_at NULL) like every other preset: publishing is the
-- act of a human confirming the numbers against the firm's page, and seeding a
-- row does not constitute that.
--
-- Three things here differ structurally from Apex and are the reason these are
-- seeded rather than hand-entered:
--
--  1. NO DAILY LOSS LIMIT. Phidias publishes none, so daily_loss_cap is
--     self-imposed at half the drawdown and daily_loss_cap_source says so. The
--     firm's own worked example spells out why this is not optional: with a
--     $50,000 start and a $47,500 floor, "even if you make $1,000 in the
--     morning, your EOD stop loss remains at $47,500 — allowing a maximum loss
--     of $3,500 for the rest of that day."
--
--  2. THE EOD FLOOR LOCK IS PHASE-DEPENDENT. On evaluation the drawdown
--     "always persists until the end of the evaluation" — it never stops
--     trailing, so safety_net_buffer is NULL. On funded accounts it stops at
--     start + $100, so the buffer is 100. Same firm, same account, different
--     phase, different rule.
--
-- The 30% funded consistency rule and the evaluation minimum-days requirement
-- (3 Fundamental / 1 Premium) have no columns on this table yet and live in
-- notes for now rather than being silently dropped.
--
--  3. THE DAY ROLLS AT 10:00 PM UTC+2, not 6:00 PM ET. Stored as an hour in
--     Europe/Paris so the firm's own DST applies.
--
-- E2L is deliberately NOT seeded. Its drawdowns ($500-$1,000) are smaller than
-- a single Apex step-3 risk, and its targets run 3-3.85x the drawdown against
-- ~1.5x for every other account here. The ladder can be sized down to fit —
-- the calculator lands on $109 base risk for the 50K — but at that size the
-- target is a months-long grind that has to be completed TWICE, once on
-- evaluation and again on the CASH account, before any bonus is paid. It is a
-- viable product for a different strategy, not for this one.

-- safety_net_buffer was NOT NULL, which quietly asserted that every firm's
-- trailing floor eventually locks. Phidias evaluations disprove it: the floor
-- "always persists until the end of the evaluation". NULL now means exactly
-- that — a floor that never stops trailing — which is also the conservative
-- reading, since a floor that keeps rising leaves less room, not more.
ALTER TABLE presets ALTER COLUMN safety_net_buffer DROP NOT NULL;

COMMENT ON COLUMN presets.safety_net_buffer IS
    'Dollars above start at which a trailing drawdown floor locks. NULL = it never locks.';

INSERT INTO presets (id, name, prop_firm, phase, start_balance, target_profit, max_drawdown,
                     daily_loss_cap, daily_loss_cap_source, base_risk, max_contracts, dd_mode,
                     safety_net_buffer, tp1_r, tp2_r, cap_step, profit_split,
                     required_qualifying_days, qualifying_day_threshold, min_payout,
                     broker_day_tz, broker_day_hour, flatten_minute, notes)
VALUES
  ('phidias_fund_50k_eval', 'Phidias Fundamental 50K Eval', 'phidias', 'eval',
     50000, 4000, 2500, 1250, 'internal', 417, 100, 'eod_trailing',
     NULL,          -- evaluation floor never stops trailing
     0.5, 2.0, 3, 0.80,
     0, 0,          -- evaluation has no payout cycle
     500,
     'Europe/Paris', 22, 21 * 60 + 45,
     'No daily loss limit — the $1250 cap is self-imposed. Evals never expire; resets $116, unlimited. Flat 80/20 split.'),

  ('phidias_fund_50k_cash', 'Phidias Fundamental 50K CASH', 'phidias', 'funded',
     50000, 2600, 2500, 1250, 'internal', 417, 100, 'eod_trailing',
     100,           -- funded floor locks at start + $100
     0.5, 2.0, 3, 0.80,
     10, 150,       -- 10 trading days between payouts, $150 qualifies a day
     500,
     'Europe/Paris', 22, 21 * 60 + 45,
     'Withdrawal threshold $52,600; balance may not fall below $50,100. Payout cap $2,000/cycle. Qualifying day = $150.'),

  -- Premium is the better fit for this strategy: payouts every 5 trading days
  -- rather than 10, one minimum day instead of three, a split that climbs to
  -- 100% after five payouts, and a one-time Cash Account Reset if the funded
  -- account is liquidated. Same drawdown and target as Fundamental.
  ('phidias_prem_50k_eval', 'Phidias Premium 50K Eval', 'phidias', 'eval',
     50000, 4000, 2500, 1250, 'internal', 417, 100, 'eod_trailing',
     NULL,
     0.5, 2.0, 3, 0.75,   -- first payout is 75%; it climbs per payout
     0, 0,
     500,
     'Europe/Paris', 22, 21 * 60 + 45,
     'Overnight permitted (unused — GB LIVE is intraday). CASH funded 1 trading day after pass.'),

  ('phidias_prem_50k_cash', 'Phidias Premium 50K CASH', 'phidias', 'funded',
     50000, 2600, 2500, 1250, 'internal', 417, 100, 'eod_trailing',
     100,
     0.5, 2.0, 3, 0.75,
     5, 150,        -- payouts every 5 trading days, $150 qualifies a day
     500,
     'Europe/Paris', 22, 21 * 60 + 45,
     'Progressive split 75/80/85/90/100 by payout number — profit_split is the FIRST payout only and rises. Payout cap $2,000/cycle. Cash Account Reset $399, once, within 24h of liquidation.')

ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  target_profit = EXCLUDED.target_profit,
  max_drawdown = EXCLUDED.max_drawdown,
  daily_loss_cap = EXCLUDED.daily_loss_cap,
  daily_loss_cap_source = EXCLUDED.daily_loss_cap_source,
  base_risk = EXCLUDED.base_risk,
  max_contracts = EXCLUDED.max_contracts,
  dd_mode = EXCLUDED.dd_mode,
  safety_net_buffer = EXCLUDED.safety_net_buffer,
  broker_day_tz = EXCLUDED.broker_day_tz,
  broker_day_hour = EXCLUDED.broker_day_hour,
  flatten_minute = EXCLUDED.flatten_minute,
  required_qualifying_days = EXCLUDED.required_qualifying_days,
  qualifying_day_threshold = EXCLUDED.qualifying_day_threshold,
  notes = EXCLUDED.notes;
