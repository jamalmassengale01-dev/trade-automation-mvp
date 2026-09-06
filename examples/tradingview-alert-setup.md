# TradingView Alert Setup

How to point a TradingView strategy at this server. Your strategy logic does not
change — only the alert's **Webhook URL** and **Message** do.

---

## 1. Webhook URL

Get it from the dashboard: **Strategies → your strategy → copy webhook URL**. It looks like:

```
https://your-domain.com/webhook/tradingview/<strategy-id>?secret=<webhook-secret>
```

The secret travels in the URL because **TradingView alerts cannot send custom HTTP
headers**. Serve this over HTTPS so the secret isn't exposed in transit.

In the alert dialog: **Notifications → Webhook URL** → paste. Leave everything else default.

Recommended alert settings for GB LIVE:

| Setting | Value |
|---|---|
| Condition | Long Signal / Short Signal / Close All Signal |
| Trigger | **Once Per Bar Close** (never intrabar) |
| Expiry | Open-ended |

---

## 2. Alert message — minimal form (recommended)

This is everything the server actually needs. Paste into **Message**:

```json
{
  "strategy_name": "GB LIVE",
  "symbol": "{{ticker}}",
  "date": "{{timenow}}",
  "data": "buy",
  "price": "{{plot_0}}",
  "stop_pts": {{plot_1}},
  "gtd_in_second": 120,
  "order_type": "MKT"
}
```

Use `"data": "sell"` on the short alert. For the close-all alert:

```json
{
  "strategy_name": "GB LIVE",
  "symbol": "{{ticker}}",
  "date": "{{timenow}}",
  "data": "close",
  "order_type": "MKT",
  "reverse_order_close": true
}
```

`{{plot_0}}` is entry price and `{{plot_1}}` is stop distance in points, in the
EdgePilot Edition script (the two PMT plots are declared first, before any chart
decoration, specifically so their index never shifts). Use index-based
placeholders — named `{{plot("Name")}}` placeholders are broken in TradingView.

**Everything else has moved server-side.** The EdgePilot Edition script no
longer has a preset selector, risk ladder, DLL tracking, or Sniper Mode logic —
none of it can be correct on a single chart feeding N broker accounts, each
with its own independent progress and step. All of that now lives on the
**Presets** dashboard page, edited per account, with no script change and no
redeploy. See `CLAUDE.md` → LaunchPad section for what each preset field does.

---

## 3. What the server ignores (and why)

These fields are accepted for backward compatibility but are **not used** to place trades:

| Field | Why it's ignored |
|---|---|
| `quantity` | The server sizes each account from its own ladder step and preset base risk. One alert can't know 20 accounts' individual ladder states. |
| `multiple_accounts` | Routing is configured per strategy via copier mappings in the dashboard. |
| `dollar_tp` | Take-profit levels come from the preset's R-multiples (`tp1_r`, `tp2_r`), applied to the actual fill price. |
| `breakeven` | Breakeven is computed as entry ± 1 tick after TP1 fills. |

So you can delete the `multiple_accounts` array and your PMT token from the alert entirely.

The fields that **do** matter: `data` (direction), `symbol`, `date`, and a stop
distance — either `stop_pts`, or `advance_tp_sl` as below.

---

## 4. Legacy form (still supported)

Your existing PickMyTrade-shaped payload works with no edits:

```json
{
  "strategy_name": "GB LIVE",
  "symbol": "MNQ1!",
  "date": "{{timenow}}",
  "data": "buy",
  "quantity": {{plot_0}},
  "price": "{{plot_1}}",
  "gtd_in_second": 120,
  "order_type": "MKT",
  "advance_tp_sl": [
    { "quantity": {{plot_6}}, "dollar_tp": 417.50, "dollar_sl": 334.00, "breakeven": 208.75 },
    { "quantity": {{plot_7}}, "dollar_tp": 835.00, "dollar_sl": 334.00, "breakeven": 208.75 }
  ]
}
```

Here the stop distance is recovered as `dollar_sl / (quantity × pointValue)` — for
MNQ at $2/pt, `334 / (2 × 2) = 83.5 pts`.

Prefer `stop_pts`: it depends only on the strategy's own stop level, whereas the
dollar form depends on a contract count the server discards, so the two can drift.
If both are present, `stop_pts` wins.

---

## 5. Server-side gates

A valid alert can still be declined, independently per account. Rejections are
logged to **Risk Events** with a reason:

| Reason | Meaning |
|---|---|
| `outside_session` | Bar close not within 3:00–3:30 AM, 10:00–10:30 AM, or 2:00–2:30 PM ET |
| `session_used` | That session already traded today on this account |
| `max_trades_day` | Daily trade cap reached (preset-configurable) |
| `dll_headroom` | Step (or Sniper) risk exceeds remaining daily-loss-limit room |
| `day_locked_out` | A loss at the ladder's cap step locked out the rest of the broker day |
| `trade_already_open` | This account already has an open GB trade — a second signal in the same window (e.g. a whipsaw) is correctly rejected rather than opening a second position |
| `sniper_session` | Sniper Mode only trades London and NY AM, never NY PM |
| `sniper_max_trades_day` | Sniper Mode's own (tighter) daily trade cap reached |
| `size_zero` | Stop too wide for the risk to afford even 1 contract |
| `stale_signal` | Alert older than 10 minutes (retry storm / outage protection) |

The broker day rolls at **6:00 PM ET**, not midnight — daily counters reset then.

**Sniper Mode** activates automatically, per account, when that account's
progress toward its preset's `target_profit` is within `pass_zone_buffer`
dollars — evaluated independently for every account a signal fans out to, since
each has its own progress. It is never triggered by anything the alert carries.
While active: risk becomes a percentage of the remaining target (capped at the
daily loss cap), both take-profit legs sit at the same R-multiple, and the
ladder is untouched by the outcome. All of this is configurable per preset on
the **Presets** page — including turning it off (`pass_zone_buffer: 0`).

---

## 6. Testing without TradingView

```bash
curl -X POST "http://localhost:3001/webhook/tradingview/<STRATEGY_ID>?secret=<SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "strategy_name": "GB LIVE",
    "symbol": "MNQ1!",
    "date": "2026-09-15T14:14:00Z",
    "data": "buy",
    "price": "29526.50",
    "stop_pts": 20,
    "gtd_in_second": 120,
    "order_type": "MKT"
  }'
```

`date` must fall inside a session window or the alert is correctly rejected with
`outside_session`. The example above is 10:14 AM ET (NY AM).
