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
  "price": "{{plot_1}}",
  "stop_pts": {{plot_2}},
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

`{{plot_1}}` is entry price and `{{plot_2}}` is stop distance in points, per the
GB LIVE plot mapping. Use index-based placeholders — named `{{plot("Name")}}`
placeholders are broken in TradingView.

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

A valid alert can still be declined. Rejections are logged to **Risk Events** with a reason:

| Reason | Meaning |
|---|---|
| `outside_session` | Bar close not within 3:00–3:30 AM, 10:00–10:30 AM, or 2:00–2:30 PM ET |
| `session_used` | That session already traded today on this account |
| `max_trades_day` | 3-trade daily cap reached |
| `dll_headroom` | Step risk exceeds remaining daily-loss-limit room |
| `size_zero` | Stop too wide for the step risk to afford even 1 contract |
| `stale_signal` | Alert older than 10 minutes (retry storm / outage protection) |

The broker day rolls at **6:00 PM ET**, not midnight — daily counters reset then.

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
