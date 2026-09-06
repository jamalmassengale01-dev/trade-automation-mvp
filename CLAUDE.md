# EdgePilot — Prop Firm Trading Automation SaaS
## Claude Code Project Context

> Drop this file at the root of your Claude Code project. Claude Code reads it automatically at session start.

---

## WHAT THIS PRODUCT IS

**EdgePilot** is a SaaS platform that gives prop firm traders access to the GB LIVE v5 trading system plus fully automated execution — all in one subscription. Customers connect their Tradovate-based prop firm accounts (Apex Trader Funding, Tradeify, MFFU), pay a monthly subscription, and the system handles signal detection and order execution automatically.

The founder (Jamal) built and runs the GB LIVE system on his own Apex fleet of up to 20 accounts. EdgePilot productizes that system for other traders.

**Revenue model:** Monthly subscription per customer. $97–197/month target price point.

**Key competitive advantages:**
- Proprietary strategy (ICT Golden Bullet with custom entry/exit logic)
- Strategy logic stays server-side — customers never see the Pine Script
- All-in-one: signal + execution + dashboard, no TradingView or PMT subscription needed
- Battle-tested on live Apex eval accounts since June 2026

---

## TECH STACK DECISIONS

- **Backend:** Node.js (matches existing PMT webhook JSON familiarity)
- **Broker integration:** Tradovate REST API + WebSocket (covers Apex, Tradeify, MFFU — all use Tradovate)
- **Phase 1 MVP:** Webhook receiver that accepts TradingView signals + executes on Tradovate
- **Phase 2:** Server-side signal generation (eliminates TradingView dependency, protects IP)
- **Auth/billing:** Stripe subscriptions
- **Database:** PostgreSQL — customer accounts, ladder state, trade log per account

---

## BUILD PHASES

### Phase 1 — MVP (ship fast, get revenue)
Customer still uses TradingView with an invite-only GB LIVE Pine Script.
EdgePilot server receives webhooks and executes on their Tradovate accounts.
Customers never see the strategy code — just connect their broker and subscribe.

**Phase 1 components:**
1. Webhook endpoint — receives GB LIVE JSON payloads from TradingView
2. Tradovate OAuth — customer authenticates their broker account
3. Order execution — MKT entry + OSO bracket (dual TP equivalent)
4. Multi-account routing — one webhook fires to all customer accounts
5. Ladder state management — per-account step tracking in database
6. Basic dashboard — account status, last trade, P&L, ladder step
7. Stripe billing — subscription management

### Phase 2 — Full SaaS (IP protection + no TV dependency)
Server generates signals from live MNQ price feed via WebSocket.
Customers have zero visibility into strategy logic.
TradingView subscription no longer required for customers.

### Phase 3 — Platform
Multiple strategies, multiple instruments (ES, YM), Rithmic support, white-label.

---

## GB LIVE STRATEGY — TECHNICAL SPEC

### Signal Logic (for Phase 2 server-side implementation)
```
Instrument: MNQ (Micro E-mini Nasdaq-100)
Timeframe:  2-minute bars
Trend:      EMA fast (default 20) > EMA slow (default 50) = bullish bias
            EMA fast < EMA slow = bearish bias

Setup detection (two entry types):
  Type 1 — Sweep + FVG:
    Long:  price sweeps prior low (liquidity grab) → bullish FVG forms → entry on retest
    Short: price sweeps prior high → bearish FVG forms → entry on retest

  Type 2 — Reclaim + Displacement:
    Long:  price reclaims bullish structure with displacement candle
    Short: price reclaims bearish structure with displacement candle

Sessions (EARLY 30-min mode — signals only within these windows):
  London:  3:00–3:30 AM ET
  NY AM:   10:00–10:30 AM ET  ← highest probability
  NY PM:   2:00–2:30 PM ET

Signal fires: on bar CLOSE only (not intrabar)
Max trades per session: 1
Max trades per day: 3 (one per session)
```

### Risk Ladder
```
Base risk = DLL / 3
  Apex 50K: $1,000 DLL → base risk = $334
  
Step 1: $334  (base)
Step 2: $334  (same as Step 1)
Step 3: $668  (2× base)
Step 4: $1,002 (3× base — rarely fires, DLL usually blocks it)

Ladder resets to Step 1 on ANY win (full win or partial)
Ladder advances on loss
Cap at Step 3 in practice (Step 4 exceeds most prop firm DLLs)
```

### Contract Sizing
```
contracts = floor(base_risk / (stop_distance_pts × tick_value))
  MNQ tick value = $0.50 per tick = $2.00 per point
  
Minimum stop distance: configurable (default ~15 pts for MNQ)
Maximum contracts: 40 micros on Apex funded PA, 60 on eval

Group 1 qty = floor(contracts / 2)   // partial close at TP1
Group 2 qty = contracts - Group 1    // runner to TP2
Special case: if contracts == 1, Group 1 = 0, Group 2 = 1
```

### Exit Logic
```
TP1 (Group 1 close): entry + (stop_distance × 0.5R) for longs
                     entry - (stop_distance × 0.5R) for shorts
TP2 (Group 2 close): entry + (stop_distance × 2.0R) for longs
                     entry - (stop_distance × 2.0R) for shorts
Breakeven trigger:   moves Group 2 stop to entry - 1 tick after TP1 fills
Stop loss:           entry - stop_distance for longs
                     entry + stop_distance for shorts

All values rounded to nearest tick (0.25 pts on MNQ)
```

### DLL Headroom Gate
```
Before firing any signal, check:
  remaining_dll_room = daily_loss_cap + day_realized_pnl
  if step_risk > remaining_dll_room → suppress signal

This prevents broker rejection of orders that would breach the daily loss limit.
Track day_realized_pnl per account, reset at 6:00 PM ET (broker day boundary).
```

---

## WEBHOOK PAYLOAD — PHASE 1 (TradingView → EdgePilot server)

### Buy/Sell Signal
```json
{
  "strategy_name": "GB LIVE",
  "symbol": "MNQ1!",
  "date": "2026-09-15T10:14:00Z",
  "data": "buy",
  "quantity": 4,
  "price": "29526.50",
  "gtd_in_second": 120,
  "order_type": "MKT",
  "advance_tp_sl": [
    {
      "quantity": 2,
      "dollar_tp": 417.50,
      "dollar_sl": 334.00,
      "breakeven": 208.75
    },
    {
      "quantity": 2,
      "dollar_tp": 835.00,
      "dollar_sl": 334.00,
      "breakeven": 208.75
    }
  ],
  "multiple_accounts": [
    {
      "token": "CUSTOMER_PMT_TOKEN",
      "account_id": "APEX_ACCOUNT_ID",
      "quantity_multiplier": 1
    }
  ]
}
```

### Close All Signal
```json
{
  "strategy_name": "GB LIVE",
  "symbol": "MNQ1!",
  "date": "2026-09-15T10:30:00Z",
  "data": "close",
  "quantity": 0,
  "order_type": "MKT",
  "reverse_order_close": true
}
```

### Plot Index Mapping (TradingView → webhook)
```
{{plot_0}} = total contracts
{{plot_1}} = entry price (rounded to tick)
{{plot_2}} = stop distance in points (rounded to tick)
{{plot_3}} = breakeven distance in points (TP1 pts - 1 tick)
{{plot_4}} = TP2 distance in points
{{plot_5}} = TP1 distance in points
{{plot_6}} = Group 1 quantity (floor half)
{{plot_7}} = Group 2 quantity (remainder)
```

---

## TRADOVATE API INTEGRATION

### Authentication
```
Tradovate uses OAuth 2.0. Each customer authenticates once.
Store: access_token, refresh_token, expiry per customer account.
Auto-refresh tokens before expiry.

Endpoints:
  Auth:     POST https://live.tradovateapi.com/v1/auth/accesstokenrequest
  Refresh:  POST https://live.tradovateapi.com/v1/auth/renewaccesstoken
  Demo:     https://demo.tradovateapi.com/v1/ (for testing)
```

### Order Placement (MKT entry with dual-TP bracket)
```
Tradovate's bracket equivalent = placeOCO or OSO (Order Sends Order)

Entry: POST /order/placeorder
  {
    "accountId": 12345,
    "action": "Buy",
    "symbol": "MNQM6",
    "orderQty": 4,
    "orderType": "Market",
    "isAutomated": true
  }

On fill → place bracket:
  Group 1 TP: limit order at entry + TP1_pts, qty = Group1_qty
  Group 1 SL: stop order at entry - SL_pts, qty = Group1_qty
  Group 2 TP: limit order at entry + TP2_pts, qty = Group2_qty
  Group 2 SL: stop order at entry - SL_pts, qty = Group2_qty

On Group 1 TP fill → modify Group 2 stop to breakeven:
  PUT /order/modifyorder
  { "orderId": group2_sl_id, "stopPrice": entry_price - 1_tick }

Use WebSocket to monitor fills:
  wss://live.tradovateapi.com/v1/websocket
  Subscribe to: user/syncrequest, order, position, fill
```

### Contract Month Mapping
```
MNQ rolls quarterly: H (Mar), M (Jun), U (Sep), Z (Dec)
Symbol: MNQM6 = June 2026, MNQU6 = September 2026, etc.
Always use the front month contract.
Detect rollover: switch symbol ~1 week before expiry.
```

---

## DATABASE SCHEMA (PostgreSQL)

### Core Tables
```sql
-- Customer accounts
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  subscription_status TEXT, -- active, past_due, canceled
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tradovate broker connections per customer
CREATE TABLE broker_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  account_id TEXT NOT NULL,          -- Tradovate account ID (e.g. APEX<account-number>)
  prop_firm TEXT,                    -- apex, tradeify, mffu
  tradovate_user_id INTEGER,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  preset TEXT DEFAULT 'apex_50k_eod_eval',  -- which GB preset to use
  seed_balance DECIMAL(12,2),
  ladder_step INTEGER DEFAULT 1,
  day_realized_pnl DECIMAL(12,2) DEFAULT 0,
  last_day_key DATE,                 -- for 6PM ET day boundary tracking
  trades_today INTEGER DEFAULT 0,
  london_used BOOLEAN DEFAULT false,
  nyam_used BOOLEAN DEFAULT false,
  nypm_used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trade log per account
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id UUID REFERENCES broker_accounts(id),
  session TEXT,                      -- london, nyam, nypm
  direction TEXT,                    -- long, short
  entry_price DECIMAL(10,2),
  sl_price DECIMAL(10,2),
  tp1_price DECIMAL(10,2),
  tp2_price DECIMAL(10,2),
  contracts INTEGER,
  step_at_entry INTEGER,
  step_risk DECIMAL(10,2),
  outcome TEXT,                      -- W, W~, L, BE, L!
  pnl DECIMAL(10,2),
  entry_time TIMESTAMPTZ,
  exit_time TIMESTAMPTZ,
  tradovate_order_ids JSONB
);

-- Preset configurations
CREATE TABLE presets (
  id TEXT PRIMARY KEY,               -- apex_50k_eod_eval, apex_50k_pa_funded, etc.
  start_balance DECIMAL(12,2),
  target_profit DECIMAL(12,2),
  max_drawdown DECIMAL(12,2),
  daily_loss_cap DECIMAL(12,2),
  base_risk DECIMAL(10,2),
  max_contracts INTEGER,
  dd_mode TEXT,                      -- eod_trailing, intraday, static
  tp1_r DECIMAL(4,2) DEFAULT 0.5,
  tp2_r DECIMAL(4,2) DEFAULT 2.0,
  cap_step INTEGER DEFAULT 3
);
```

---

## PROP FIRM PRESETS

### Apex 50K EOD Eval
```
start_balance:  50000
target_profit:  3000
max_drawdown:   2000
daily_loss_cap: 1000
base_risk:      334    (DLL/3)
max_contracts:  60     (micros, eval limit)
dd_mode:        eod_trailing
cap_step:       3
pass_rate:      85.5%  (MC verified)
avg_days_pass:  16.5
```

### Apex 50K PA Funded
```
start_balance:  50000
target_profit:  2600   (safety net + min payout threshold)
max_drawdown:   2000
daily_loss_cap: 1000   (verify with Apex — assumed)
base_risk:      334
max_contracts:  40     (micros, PA limit)
dd_mode:        eod_trailing
payout_schedule: [1500, 1500, 2000, 2500, 2500, 3000]
total_extractable: 13000
consistency_rule: 50%  (no single day >= 50% of total since last payout)
qualifying_day_threshold: 250  (min daily profit to count as qualifying day)
```

---

## LAUNCHPAD — FLEET MANAGEMENT SYSTEM

This is the core product feature that separates EdgePilot from a simple webhook relay.
The LaunchPad manages a customer's entire prop firm account lifecycle:
eval → funded PA → 6 payouts → restart → repeat, across up to 20 simultaneous accounts.

---

### The Fleet Model

Every customer account follows this lifecycle:

```
BUY EVAL ($109)
    ↓
PASS EVAL (~16.5 days avg, 85.5% pass rate)
    ↓
FUNDED PA ACTIVATED
    ↓
TRADE + ACCUMULATE QUALIFYING DAYS
    ↓
REQUEST PAYOUT (every ~14 calendar days)
    ↓ × 6
PA CLOSES AT PAYOUT #6 ($13,000 total extracted)
    ↓
BUY NEW EVAL ($109) → REPEAT
```

Failed eval (14.5% of attempts): buy new $109 eval immediately, restart.

---

### Apex PA Payout Schedule (per account, 100% split)

```
Payout #1:  $1,500   (after 5 qualifying days + balance >= $52,600)
Payout #2:  $1,500   cumulative: $3,000
Payout #3:  $2,000   cumulative: $5,000
Payout #4:  $2,500   cumulative: $7,500
Payout #5:  $2,500   cumulative: $10,000
Payout #6:  $3,000   cumulative: $13,000  ← PA closes
```

Total extractable per PA cycle: **$13,000**
PA lifecycle: ~3 months (6 payouts × ~14 days each)
Monthly income equivalent: ~$3,807/account (12-month average, blow-adjusted)

---

### Qualifying Day Requirements

A payout request requires 5 qualifying trading days since the last payout.

```
Qualifying day = net daily profit >= $250 on the PA account
Non-qualifying days: partial-win-only days (+$83.50 at Step 1) do NOT count
P(qualifying day) = ~49.7% (based on GB LIVE session fire rates + win distribution)
Expected trading days to accumulate 5 qualifying days: ~10 days
Expected calendar days between payouts: ~14 days
```

**50% Consistency Rule:**
```
No single profitable day can be >= 50% of total profit since last payout.
If violated: payout button locked until diluted by more trading days.
Example: if you made $800 on one day and total profit is $1,400, that day
is 57% of total — payout blocked until total rises above $1,600.
EdgePilot must track this per account and surface it on the dashboard.
```

**Minimum balance to request payout (Apex 50K):**
```
Safety net = $2,000 DD + $100 = $52,100
Min payout = $500
Min balance to request = $50,000 + $2,100 + $500 = $52,600
Only profit ABOVE safety net ($52,100) is eligible for payout.
```

---

### Eval Pass Rate Statistics (Monte Carlo, 20,000 simulations)

```
Pass rate:           85.5%
Blown rate:          14.5%
Avg days to pass:    16.5 trading days (~3.5 calendar weeks)
Fast (P10):          7 days
Slow (P90):          30 days
Expected cost per funded account: $127 (109/0.855)
```

**The Eval Rush option ($500 base risk instead of $334):**
```
Pass rate:           68.8%
Blown rate:          31.2%
Avg days to pass:    10.1 days
E[days → funded]:    14.5 days vs 22.7 for standard
Use case:            EVAL ONLY — never on a funded PA
Rationale:           Blown evals cost $109; calendar time is the scarce resource
```

---

### Fleet Scaling Logic

**Stagger rule (CRITICAL):**
```
Never start multiple evals on the same day.
Minimum 7 days between eval starts.
Reason: prevents multiple $99 activation windows (if using Standard product)
        and creates continuous staggered payout stream.
```

**Self-financing:**
```
First payout ($1,500) arrives ~35 days after eval purchase.
At that point: income covers all subsequent eval costs.
Monthly overhead ($110 TradingView + PMT) becomes irrelevant at 1+ funded accounts.
```

**Fleet income milestones:**
```
1 funded account:   ~$3,807/mo
5 funded accounts:  ~$19,035/mo
10 funded accounts: ~$38,070/mo
20 funded accounts: ~$76,140/mo (Apex maximum)
```

---

### Dashboard Features Required (LaunchPad View)

Each customer account needs these tracked and displayed:

```
EVAL ACCOUNTS:
  - Eval start date
  - Current balance vs $3,000 target
  - Progress % toward target
  - Ladder step (1-4)
  - Day P&L + DLL room remaining
  - Trades today (0/3 max)
  - Session limits (LON / AM / PM used)
  - Expected pass date (start_date + 16.5 days)
  - Alert: if eval hasn't traded in 48+ hours

FUNDED PA ACCOUNTS:
  - Current payout number (1-6)
  - Profit since last payout
  - Qualifying days banked (toward next 5)
  - 50% consistency status (OK / BLOCKED)
  - Current balance vs $52,600 payout threshold
  - Days since last payout
  - Estimated next payout eligibility date
  - Total extracted this PA cycle
  - Alert: when payout becomes eligible

FLEET OVERVIEW:
  - Total accounts (eval + funded)
  - Total monthly income run rate
  - Total extracted all-time
  - Next payout expected (date + amount)
  - Accounts nearing PA completion (payout #5 or #6)
  - Recommended action (buy new eval, request payout, etc.)
```

---

### LaunchPad Database Additions

```sql
-- Payout tracking per PA account
CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id UUID REFERENCES broker_accounts(id),
  payout_number INTEGER,          -- 1 through 6
  amount DECIMAL(10,2),           -- actual payout received
  requested_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  status TEXT                     -- pending, approved, denied
);

-- Qualifying day tracking
CREATE TABLE qualifying_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id UUID REFERENCES broker_accounts(id),
  trade_date DATE,
  daily_pnl DECIMAL(10,2),
  qualifies BOOLEAN,              -- true if daily_pnl >= 250
  payout_cycle INTEGER            -- which payout cycle this counts toward
);

-- Eval purchase tracking
CREATE TABLE evals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  broker_account_id UUID REFERENCES broker_accounts(id),
  purchase_date DATE,
  eval_cost DECIMAL(10,2),
  activation_cost DECIMAL(10,2) DEFAULT 0,
  prop_firm TEXT,
  account_size INTEGER,
  outcome TEXT,                   -- in_progress, passed, blown, expired
  pass_date DATE,
  funded_date DATE,
  days_to_pass INTEGER
);
```

---

### Automated Actions (LaunchPad Engine)

EdgePilot should automate or alert on these events:

```
1. EVAL PASSES
   → Send customer notification: "Your eval passed! Activate within 7 days."
   → If No Activation Fee product: auto-activate (no customer action needed)
   → Update broker_account record: status = funded, seed_balance = 50000

2. PAYOUT ELIGIBLE
   → Detect: qualifying_days >= 5 AND balance >= 52600 AND consistency_ok
   → Send customer notification: "Payout #X available. Amount: $X,XXX"
   → Customer submits payout request through Apex dashboard (manual step)
   → EdgePilot tracks pending payout status

3. PA COMPLETES (payout #6)
   → Send customer notification: "PA complete. Total extracted: $13,000."
   → Recommend: "Buy new eval to restart this account slot"
   → Optionally auto-purchase new eval if customer has pre-authorized it

4. EVAL BLOWN
   → Send customer notification: "Eval blown. Restarting automatically."
   → Auto-purchase new eval if customer has pre-authorized + funds available
   → Reset account state, begin new eval tracking

5. NO ACTIVITY ALERT
   → If no trades fired in 48+ hours on an active account
   → Alert customer: "No trades detected. Check your alerts and subscriptions."
   → Common causes: TradingView alert expired, PMT disconnected, market holiday

6. DLL APPROACHING
   → If day_realized_pnl < -$700 (70% of DLL consumed)
   → Alert customer: "Account approaching daily loss limit. $300 remaining."
```

---

### MC-Verified Income Numbers (20,000 simulations)

Use these for all customer-facing projections and marketing:

```
Per account:
  Monthly income:        ~$3,807/mo (blow-adjusted, 100% split)
  PA total:              $13,000 per 3-month cycle
  Eval pass rate:        85.5%
  Blown rate:            14.5%
  Cost per funded acct:  ~$127
  Monthly blow risk:     1.2% per funded account

Fleet projections (honest, MC-verified):
  5 accounts:   ~$19,000/mo
  10 accounts:  ~$38,000/mo
  20 accounts:  ~$76,000/mo

  ⚠ These numbers assume 60% win rate which is UNVALIDATED from live data.
  Always present these as projections, not guarantees.
  Customer marketing should use conservative figures (~50% of above).
```

---

### Founder's Fleet (Reference Implementation)

Jamal's personal setup is EdgePilot's live proof of concept.
Everything built must work on his accounts first.

```
Prop firm:      Apex Trader Funding
Account type:   50K EOD Trail (No Activation Fee)
Eval cost:      $109 per eval (with sale code — verify current pricing)
Max accounts:   20 PAs
Current status: Restarting September 15, 2026 (5-pack purchase)
Expected:       4.3 funded accounts from first 5-pack
                Monthly income at 10 accounts: ~$38,000
                Fleet target: 20 accounts by January 1, 2027

```

---



### Subscription Tiers (suggested)
```
Starter:    $97/mo  — 1 broker account, standard preset only
Pro:        $147/mo — up to 5 broker accounts, all presets
Fleet:      $197/mo — up to 20 broker accounts, all presets + priority support
```

### IP Protection Rules
```
- GB LIVE Pine Script is NEVER distributed to customers
- Strategy logic lives server-side only in Phase 2
- Phase 1: invite-only TradingView script (obfuscated, no source access)
- Customers get: dashboard + execution + signals. Not: code.
```

### Account Limits
```
- Max 20 Apex PAs per Tradovate account (Apex rule)
- EdgePilot enforces this per customer
- Each customer can have multiple Tradovate accounts (different prop firms)
```

---

## CURRENT OWNER SETUP (reference / dogfood)

Jamal's personal fleet uses this system on his own Apex accounts.
This is the reference implementation — his setup should always work perfectly.

```
Webhook (Phase 1):  https://api.pickmytrade.trade/v2/add-trade-data-latest?t=<REDACTED>
PMT token:          <REDACTED — keep in .env, never commit>
Apex accounts:      <REDACTED — stored in broker_accounts.credentials, never commit>
TradingView:        MNQ1! 2-minute chart, GB LIVE v5, Apex 50K EOD Eval preset
Alert frequency:    Once Per Bar Close
Conditions:         "Long Signal", "Short Signal", "Close All Signal"
Order type:         MKT
GTD:                120 seconds
```

---

## KEY CONSTRAINTS & GOTCHAS

### Tradovate
```
- WebSocket disconnects silently — implement heartbeat + auto-reconnect
- Token expires every 24h — refresh proactively at 22h
- Order fills arrive async — never assume fill on order placement
- Demo API: demo.tradovateapi.com (use for dev/test, not production)
- Contract symbol includes month: MNQM6, MNQU6, MNQZ6, MNQH7
- isAutomated: true required on all orders for compliance
```

### Prop Firm Rules
```
- DLL resets at 6:00 PM ET (NOT midnight) — broker day boundary
- EOD trailing floor updates once per broker day at floor lock time
- 50% consistency rule can DELAY payouts even when balance is high
- 7-day eval expiry: passed eval must be activated within 7 days or it expires
- Apex max accounts: 20 PAs hard ceiling
```

### Signal Timing
```
- Bar close signals only — never fire intrabar
- 2-minute bars: each bar is 2 minutes of price action
- Session gates: signal only valid if bar close is WITHIN the session window
- Stale signal protection: if order isn't filled within 120s (GTD), cancel
```

### Known Issues (from live trading)
```
- STP entry orders only fill when price comes back to entry level → use MKT
- Named TradingView plot placeholders {{plot("Name")}} are broken → use {{plot_0}} etc.
- Internal tracking must use rounded tick values (not raw floats) to match broker fills
- Day P&L must track from 6:00 PM ET, not midnight, or DLL gate math is wrong
```

---

## FILE STRUCTURE (actual monorepo)
```
trade-automation-mvp/
├── CLAUDE.md                          ← this file
├── apps/
│   ├── api/                           ← Express + BullMQ backend (port 3001)
│   │   └── src/
│   │       ├── indexHardened.ts       ← server entry (HTTP + WebSocket)
│   │       ├── webhook/
│   │       │   ├── handlerHardened.ts ← /webhook/tradingview[/:strategyId]
│   │       │   ├── schema.ts          ← internal alert schema (zod)
│   │       │   └── gbLiveSchema.ts    ← GB LIVE / PMT payload → internal
│   │       ├── brokers/
│   │       │   ├── tradovateBroker.ts ← REST adapter (auth, orders, brackets)
│   │       │   ├── tradovate/ws.ts    ← fill/order stream, heartbeat, reconnect
│   │       │   └── bracketInterface.ts
│   │       ├── strategy/              ← GB LIVE logic (pure functions + manager)
│   │       │   ├── instruments.ts     ← tick size / point value per root
│   │       │   ├── ladder.ts          ← step risk, next step, outcome
│   │       │   ├── sizing.ts          ← contracts, groups, TP/SL/BE levels
│   │       │   ├── sessions.ts        ← ET session windows, 6PM broker day key
│   │       │   ├── gate.ts            ← session / 3-per-day / DLL headroom
│   │       │   └── bracketManager.ts  ← entry → fill → OCO → BE → close
│   │       ├── processor/
│   │       │   ├── alertProcessorHardened.ts
│   │       │   ├── gbLiveExecutor.ts  ← per-account GB path
│   │       │   └── orderProcessorHardened.ts
│   │       ├── services/symbolResolver.ts ← MNQ1! → MNQM6
│   │       ├── routes/                ← accounts, strategies, gb, alerts, orders…
│   │       └── db/
│   │           ├── schema.sql, schema_hardening.sql, schema_gblive.sql
│   │           └── migrate.ts, seed.ts
│   └── web/                           ← Next.js 14 dashboard (port 3000)
├── packages/shared-types/             ← shared TS types
└── docker/docker-compose.yml          ← postgres + redis
```

Tradovate auth note: Phase 1 uses **API key + dedicated password** (`/auth/accesstokenrequest`
with cid/sec), not the OAuth redirect flow — OAuth registration requires NinjaTrader partner
approval. Credentials live in `broker_accounts.credentials` JSONB.

---

## TESTING APPROACH
```
1. Use Tradovate DEMO environment for all dev/test
   - demo.tradovateapi.com (separate credentials from live)
   - Paper trading — no real money
   
2. Test webhook with curl:
   curl -X POST http://localhost:3000/webhook \
     -H "Content-Type: application/json" \
     -d '{"data":"buy","quantity":2,"order_type":"MKT",...}'

3. Verify bracket placement in Tradovate demo dashboard
   - Check Group 1 TP/SL placed correctly
   - Simulate TP1 fill → verify Group 2 stop moves to BE
   
4. Load test: simulate 20 accounts receiving same webhook simultaneously
```

---

*EdgePilot | GB LIVE v5 | Built by Jamal | September 2026*
*This file is the single source of truth for Claude Code sessions on this project.*
