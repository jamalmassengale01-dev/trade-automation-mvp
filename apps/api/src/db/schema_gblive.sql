-- ============================================
-- EDGEPILOT / GB LIVE — SCHEMA ADDITIONS
-- Idempotent: safe to run repeatedly.
-- ============================================

-- ============================================
-- 1. PROP FIRM PRESETS
-- ============================================
CREATE TABLE IF NOT EXISTS presets (
    id              TEXT PRIMARY KEY,                 -- apex_50k_eod_eval, ...
    name            TEXT NOT NULL,
    prop_firm       TEXT NOT NULL,                    -- apex, tradeify, mffu
    phase           TEXT NOT NULL CHECK (phase IN ('eval', 'funded')),
    start_balance   DECIMAL(12,2) NOT NULL,
    target_profit   DECIMAL(12,2),
    max_drawdown    DECIMAL(12,2) NOT NULL,
    daily_loss_cap  DECIMAL(12,2) NOT NULL,
    base_risk       DECIMAL(10,2) NOT NULL,           -- usually daily_loss_cap / 3
    max_contracts   INTEGER NOT NULL,                 -- micros
    dd_mode         TEXT NOT NULL DEFAULT 'eod_trailing',
    tp1_r           DECIMAL(4,2) NOT NULL DEFAULT 0.5,
    tp2_r           DECIMAL(4,2) NOT NULL DEFAULT 2.0,
    cap_step        INTEGER NOT NULL DEFAULT 3,
    max_trades_day  INTEGER NOT NULL DEFAULT 3,
    profit_split    DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    notes           TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO presets (id, name, prop_firm, phase, start_balance, target_profit, max_drawdown,
                     daily_loss_cap, base_risk, max_contracts, dd_mode, tp1_r, tp2_r, cap_step, profit_split, notes)
VALUES
  ('apex_50k_eod_eval',   'Apex 50K EOD Eval',        'apex',     'eval',   50000, 3000, 2000, 1000, 334, 60, 'eod_trailing', 0.5, 2.0, 3, 1.0,
     'Standard eval. MC pass rate ~85.5%, ~16.5 days.'),
  ('apex_50k_eval_rush',  'Apex 50K Eval Rush',       'apex',     'eval',   50000, 3000, 2000, 1000, 500, 60, 'eod_trailing', 0.5, 2.0, 3, 1.0,
     'Higher base risk for faster pass (~10 days, ~69% pass). EVAL ONLY — never on a funded PA.'),
  ('apex_50k_pa_funded',  'Apex 50K PA Funded',       'apex',     'funded', 50000, 2600, 2000, 1000, 334, 40, 'eod_trailing', 0.5, 2.0, 3, 1.0,
     'Target = min balance to request first payout ($52,600). Verify PA DLL with Apex ($1,000 assumed).'),
  ('tradeify_select_25k', 'Tradeify Select 25K',      'tradeify', 'eval',   25000, 1500, 1000,  500, 167, 10, 'eod_trailing', 0.5, 2.0, 3, 0.8,
     'Verify current Tradeify rules before use.')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  prop_firm = EXCLUDED.prop_firm,
  phase = EXCLUDED.phase,
  start_balance = EXCLUDED.start_balance,
  target_profit = EXCLUDED.target_profit,
  max_drawdown = EXCLUDED.max_drawdown,
  daily_loss_cap = EXCLUDED.daily_loss_cap,
  base_risk = EXCLUDED.base_risk,
  max_contracts = EXCLUDED.max_contracts,
  dd_mode = EXCLUDED.dd_mode,
  tp1_r = EXCLUDED.tp1_r,
  tp2_r = EXCLUDED.tp2_r,
  cap_step = EXCLUDED.cap_step,
  profit_split = EXCLUDED.profit_split,
  notes = EXCLUDED.notes;

-- ============================================
-- 2. PER-ACCOUNT GB STATE (ladder + broker-day counters)
-- ============================================
ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS preset_id        TEXT REFERENCES presets(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS prop_firm        TEXT,
    ADD COLUMN IF NOT EXISTS account_phase    TEXT DEFAULT 'eval',
    ADD COLUMN IF NOT EXISTS ladder_step      INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS day_realized_pnl DECIMAL(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_day_key     DATE,
    ADD COLUMN IF NOT EXISTS trades_today     INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS london_used      BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS nyam_used        BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS nypm_used        BOOLEAN DEFAULT false;

-- ============================================
-- 3. GB TRADES — one row per account per signal, full bracket lifecycle
-- ============================================
CREATE TABLE IF NOT EXISTS gb_trades (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    broker_account_id UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    trade_request_id  UUID REFERENCES trade_requests(id) ON DELETE SET NULL,
    alert_id          UUID REFERENCES alerts_received(id) ON DELETE SET NULL,
    day_key           DATE NOT NULL,                  -- broker day (6 PM ET boundary)
    session           TEXT,                           -- london | nyam | nypm
    direction         TEXT NOT NULL CHECK (direction IN ('long', 'short')),
    symbol            TEXT NOT NULL,                  -- tradable contract, e.g. MNQM6
    root_symbol       TEXT NOT NULL,                  -- MNQ
    ref_price         DECIMAL(12,2),                  -- alert / bar-close price
    entry_price       DECIMAL(12,2),                  -- qty-weighted avg fill
    stop_pts          DECIMAL(10,2) NOT NULL,
    sl_price          DECIMAL(12,2),
    tp1_price         DECIMAL(12,2),
    tp2_price         DECIMAL(12,2),
    be_price          DECIMAL(12,2),
    contracts         INTEGER NOT NULL,
    g1_qty            INTEGER NOT NULL,
    g2_qty            INTEGER NOT NULL,
    step_at_entry     INTEGER NOT NULL,
    step_risk         DECIMAL(10,2) NOT NULL,
    gtd_seconds       INTEGER NOT NULL DEFAULT 120,   -- cancel unfilled entry after this
    state             TEXT NOT NULL DEFAULT 'entry_pending'
                      CHECK (state IN ('entry_pending', 'open', 'tp1_hit', 'closing', 'closed', 'failed')),
    outcome           TEXT CHECK (outcome IN ('W', 'W~', 'L', 'BE', 'L!')),
    pnl               DECIMAL(12,2),
    broker_orders     JSONB NOT NULL DEFAULT '{}',    -- { entry: [...], g1: {tp, sl}, g2: {tp, sl}, exit: [...] }
    fills             JSONB NOT NULL DEFAULT '[]',    -- [{ orderId, role, qty, price, at }]
    error_message     TEXT,
    entry_time        TIMESTAMP WITH TIME ZONE,
    exit_time         TIMESTAMP WITH TIME ZONE,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gb_trades_account_created ON gb_trades(broker_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gb_trades_open ON gb_trades(state) WHERE state NOT IN ('closed', 'failed');
CREATE INDEX IF NOT EXISTS idx_gb_trades_day ON gb_trades(broker_account_id, day_key);

DROP TRIGGER IF EXISTS update_gb_trades_updated_at ON gb_trades;
CREATE TRIGGER update_gb_trades_updated_at BEFORE UPDATE ON gb_trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 4. DAILY P&L HISTORY (feeds qualifying-day / consistency tracking later)
-- ============================================
CREATE TABLE IF NOT EXISTS account_daily_pnl (
    account_id    UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    day_key       DATE NOT NULL,
    realized_pnl  DECIMAL(12,2) NOT NULL DEFAULT 0,
    trades        INTEGER NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (account_id, day_key)
);
