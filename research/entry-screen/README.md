# Entry screen

Two tools for answering one question about a candidate entry condition:

> Does it predict direction, or is it a coin flip?

**`entry-edge-tester.pine`** — a TradingView strategy. Paste an entry condition into
SECTION 1; it takes the trade with a 1R stop and a distant probe target, and records
how far price travelled.

**`edge.py`** — reads the exported trade list and reports hit rates against the
coin-flip baseline, with a cluster-robust standard error, a split-half stability
check and expected value net of commission.

```
python3 edge.py <export.csv> "<label>"
```

## Why the coin-flip line is the yardstick

With a stop at 1R, a driftless random walk touches a target of T×R before stopping
with probability **1/(1+T)**. A 0.5R target therefore hits **66.7%** of the time with
no edge whatsoever; 1R hits 50%, 2R hits 33.3%.

A "66% win rate" means nothing until you know the target. Predictive power is a hit
rate *above* that line. Exits, position sizing and risk ladders redistribute what the
entry produces — none of them manufacture an edge.

## What it deliberately does not do

No take-profit tuning, no ladder, no breakeven, no split exits. Those change what you
harvest from an edge and cannot create one, and including them lets a losing entry be
tuned into a backtest that looks profitable.

## Discipline this encodes

- **Set the bar before looking.** Screening k ideas at family-wise 5% needs roughly
  z ≥ 2.5 for nine, 2.8 for eighteen. `edge.py`'s `BAR` holds it.
- **Two more gates past significance.** An effect present in only half its own
  discovery window is not tradeable; an effect smaller than commission is not either.
- **Keep a sealed holdout.** It is worth exactly one honest test. Spend it once.
- **Never re-specify after seeing a result.** Testing a narrower date range, a
  different target, or one side only — each turns a real number into a meaningless one.

`PV` at the top of `edge.py` is the instrument's point value: MNQ 2.0, MES 5.0,
MYM 0.5. Change it when changing symbol.

---

## Setup, once

**1. Chart.** Symbol `MNQ1!`, timeframe **5m**.

**2. Load the script.** Pine Editor → paste the whole file over whatever is there →
**Save** → **Add to chart**.

**3. Reset the inputs.** Settings (gear icon) → bottom-left **Defaults** → **Reset
settings to defaults**.

> Do this every single time you load a new version. TradingView keeps your old input
> values and silently applies them to the new script. This has invalidated runs
> before — including one where a session window was left on and one where the
> per-day cap differed from the one intended.

**4. Set the date range.** In the Strategy Tester panel, click the date button
(currently reading "May 31, 2026 — Sep 16, 2026"):

- Start: **1 September 2023**
- End: **1 March 2025**
- Turn **Deep Backtesting ON** — you should see the pink `DEEP` badge appear

That end date matters. **1 Mar 2025 to today stays sealed** for whatever survives
screening. Do not look at it.

---

## Running one idea

**1.** Pine Editor → find `SECTION 1` near the top.

**2.** Find the two marker lines:

```pine
// ===== replace from here =====================================================
...
// ===== to here ===============================================================
```

Select everything between them and paste the idea's block over it. **All four lines,
plus the blank one** — the `emaFast` / `emaSlow` definitions go too. Keep the markers
themselves. Everything below `SECTION 2` stays untouched.

Your block only has to end up defining two booleans named `longEntry` and
`shortEntry`. Nothing outside SECTION 1 refers to anything declared inside it, so
deleting the EMA lines leaves nothing dangling.

> An earlier version of the tester plotted `emaFast` and `emaSlow` near the bottom,
> so deleting them produced **"Undeclared identifier 'emaFast'"** 120 lines below the
> edit. Those plots are gone. If you see that error, you are on the old file.

**3.** Save (Ctrl+S). The chart reloads.

**4.** Check the **Inputs** tab:

| Input | Value |
|---|---|
| Restrict to a time window | **OFF**, unless the idea says otherwise |
| Trigger only when the signal turns on | **ON** |
| Max trades per day | **3**, raise to 10 for idea #3 |
| Far target (R) | **5** |

**5.** Export the trade list — **not** the on-chart table.

In the Strategy Tester panel: the grid icon next to the chart icon (top left of the
panel) switches to **List of Trades**. The download arrow at the right of that panel
exports it as CSV. Keep the file — `edge.py` reads it.

> **Why not the table.** Deep Backtesting runs the strategy on a separate
> extended-history feed. The table is drawn by the script instance running on the
> ordinary chart feed, which at 5-minute resolution holds only weeks of bars — so
> when your range sits further back than that, the table sees no trades at all and
> reports `0 trades` beside a Key stats panel reading thousands. Neither number is
> wrong; the two runs cannot see each other.
>
> The table is still correct for short ranges inside the chart's own history. For the
> Sep 2023 – Mar 2025 window it will always read zero, and that is not a failure.

The CSV carries a **Run-up** column — maximum favourable excursion per trade, which
is exactly what the horizons are built from. Each entry's `sd=` comment carries that
trade's stop distance, so Run-up converts to R.

---

## Reading the table

```
ENTRY EDGE TEST        847 trades
target   coin flip   measured    edge     EV/trade
0.25R       80.0%      78.1%    -0.49s    -0.052R
0.50R       66.7%      62.9%    -0.83s    -0.085R
...
VERDICT   NO EDGE
```

Only two things matter:

- **Trades.** Under 100 and it says NEED MORE TRADES. That is not advice, it is a
  refusal — the interval is wider than any edge you would act on.
- **The edge column, in sigma.** You are looking for **+2.6 or better at several
  adjacent horizons**. Not one green cell. Several, next to each other.

Ignore the EV column for screening. It is there for context, not for decisions.

**The long/short slice at the bottom is greyed out on purpose.** It is where you go
hunting for the one cut that looks good, which is how the London result happened.

---

## If something clears the bar

Stop. Do not adjust anything. In this exact order:

1. **Switch the symbol to `MES1!`.** Change nothing else. Re-read the table.
2. **Then, and only then, move the date range to 1 Mar 2025 – today.** One run. One.
3. If it survives both, it is worth building on. If it fails either, it is dead.

If it fails either, it is dead. Do not tune it and try again: the holdout is spent the
moment you use it twice, and then you have no test left.

---

## If you get zero trades again

Work down this list:

1. **Date range and DEEP** — the most common cause by far.
2. **`Restrict to a time window` is ON** when the idea doesn't need it. A one-hour
   window will starve most signals.
3. **`Max trades per day` too low** for a high-frequency idea.
4. **The idea genuinely never fires.** Temporarily set `transitionOnly` OFF and see if
   the count moves. If it is still zero, the condition is never true and the Pine needs
   looking at.
5. **Click the "Script execution" badge** in the Strategy Tester toolbar. If it is
   showing a runtime error, that is the answer and I need to see it.

---

## The nine ideas

**Named, not numbered.** An earlier version of this file numbered them 1-9, which
collided with the numbering in the round-2 notes — `#8` meant *high-volume impulse*
here and *turn of month* there. The `source` column is the only numbering that maps
back to a GPT reply.

| Idea | source | Notes |
|---|---|---|
| Treasury → MNQ | R2 #6 | clearest mechanism, run first |
| Close-location persistence | R2 #9 | best sample size |
| Same-interval-yesterday | R1 #3 | raise Max trades per day to 10 |
| ES → NQ convergence | R2 #10 | needs the contract-roll guard |
| Opening → closing half-hour | R1 #4 | one clean trade per day |
| VIX stress | R2 #7 | window ON, `0930-1600` |
| ATR shock reversal | R1 #1 | fires in correlated bursts |
| High-volume impulse | R1 #2 | then repeat with window ON as a control |
| 20-bar momentum | R1 #5 | fires in correlated bursts |

Set the **Idea label** input to match before every run. It rides into the CSV, and
it is the only way to tell from an export which idea produced it — three runs were
scored against the wrong idea before that input existed.

> An earlier note here said to hold the two burst-firing ideas to 3 sigma. That was
> a guess standing in for a calculation. `edge.py` now computes a cluster-robust
> standard error, which measures the correlation instead of guessing at it — and
> measured it at ×0.99–1.04, i.e. negligible. The bar stays at 2.6 for all nine.

Expect most to fail. That is the normal outcome, and at ten minutes each it is cheap.
