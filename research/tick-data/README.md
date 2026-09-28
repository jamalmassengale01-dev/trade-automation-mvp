# Order-flow probe

Tests whether order flow — who initiated each trade — predicts direction on MNQ,
using the same protocol that screened fourteen OHLCV entry conditions and found
nothing. `PLAN.md` has the reasoning, including the reasons this may not work.

**Status: harness built and validated. No real data yet.**

## Why this exists

Both prior screens were limited by the same thing: every condition had to fit in
a few lines of Pine over OHLCV. Order flow is the one category with a documented
short-horizon mechanism that Pine cannot see at any price.

## Run the gates first

```bash
python3 validate.py
```

Four checks, all against synthetic data, roughly a minute:

```
lookahead control                z >= +5      can it see an edge at all
coin-flip control                |z| < 2.5    does it invent one
real condition, no edge planted  |z| < 2.5    false positive check
real condition, edge planted     z >= +5      can it find a real one
```

The last two are the pair that matters — identical condition and code, on data
with and without a planted flow-to-return relationship. A lookahead control only
proves the harness can see something enormous. Telling a real effect from its
absence is the job.

Current status: **all four pass** (+8.14 / +0.79 / -0.12 / +16.62).

Three further gates cover the export format rather than the statistics, because
a real Databento file can differ from the synthetic one in ways that do not
crash: prices as 1e-9 fixed-point integers, several expirations in one file, and
a session window that is an hour wrong outside winter.

```
1e-9 fixed-point prices       must give a trade list identical to decimals
two contracts in one export   must be refused, not interleaved
session window across DST     09:30 ET in session in January AND June
```

Do not read a result from this harness if a gate is failing.

## The pilot

### Ordering the data without overpaying

The portal quoted **$845.91** for the spec as first written. Three settings, all
under *Customize download*:

| | |
|---|---|
| **Dataset** | `GLBX.MDP3` |
| **Schema** | **`trades`**, not `mbp-1`. The probe reads `ts_event`, `action`, `side`, `price`, `size` and nothing else — no bid, no ask. MBP-1 adds a book snapshot per quote change, which is most of the bytes and all discarded. |
| **Symbols** | **One contract**, via *raw symbol* symbology. Left blank you are buying every product on CME Globex — that is what the 504 GB was. |
| **Time range** | One month inside Sep 2023 – Mar 2025. The Mar 2025 – Sep 2026 holdout stays sealed. |
| **Encoding** | CSV. Decimal or fixed-point prices both work — the ingest detects which. |

**The search box on the browse page indexes products, not expirations.** `MNQ`
is there; `MNQH4` is not, and searching for it returns nothing. Select the `MNQ`
product first, then name the contract inside *Customize download* with the
symbology type set to **raw symbol**.

Which contract, for a one-month pilot — MNQ rolls quarterly on H/M/U/Z:

| month | front contract |
|---|---|
| Sep – mid-Dec 2023 | `MNQZ3` |
| mid-Dec 2023 – mid-Mar 2024 | `MNQH4` |
| mid-Mar – mid-Jun 2024 | `MNQM4` |
| mid-Jun – mid-Sep 2024 | `MNQU4` |
| mid-Sep – mid-Dec 2024 | `MNQZ4` |
| mid-Dec 2024 – Mar 2025 | `MNQH5` |

Pick a month that sits wholly inside one row — January 2024 on `MNQH4` is the
clean default.

**Not the continuous symbols** (`MNQ.v.0`, `MNQ.c.0`) for the pilot. They splice
expirations without back-adjusting, so the series carries a several-hundred-point
gap at each roll; the ingest refuses such a file as two contracts, which is right.
Rolling is a problem for the full 18-month buy, not for one month.

Read the portal's figure before buying. The point of the table is which lever to
pull, not what it will cost.

```bash
# 1. Download one month of MNQ trades from Databento's portal as CSV.
#    Not OHLCV — the whole point is the aggressor side on each trade.

# 2. Probe it
python3 flow_probe.py mnq_jan2024.csv --idea delta-momentum --out trades.csv

# 3. Score it with the protocol that has absorbed five bug fixes
python3 ../entry-screen/edge.py trades.csv delta-momentum
```

One month gives 60-100 trades. **That cannot clear a significance bar and is not
meant to.** The pilot is a go/no-go on effect size: if the point estimate sits on
the coin-flip line with no hint of separation, stop before buying history.

## Files

| | |
|---|---|
| `flow_probe.py` | ingest, 5-minute bars with order-flow features, entry simulator, export |
| `synth.py` | synthetic MBP-1 with an optional planted edge, for the gates |
| `validate.py` | the four gates |
| `PLAN.md` | why, what it costs, and how it fails |

## Measurement protocol

Identical to `entry-edge-tester.pine`, so results are comparable with the
fourteen already screened: entry on bar close, one position at a time, stop at
1x ATR(14) floored at 15 points, a distant 5R probe target, 240-bar time stop,
maximum favourable excursion recorded per trade and converted to R.

No take-profit search, no ladder, no breakeven, no split exits. Those
redistribute an edge and cannot create one, and including them lets a losing
entry be tuned into something that looks profitable.

The output is deliberately the same CSV shape `edge.py` already reads. That is
what carries the coin-flip baseline, the cluster-robust errors, the split-half
check, the EV-above-cost gate and the non-finite-stop guard across the tool
change for free.

## Adding an idea

One function, `condition()` in `flow_probe.py`. Return +1, -1 or 0.

Declare the whole batch before running any of it, and raise the significance bar
for the count — `research/entry-screen/RESULTS.md` records what happens when
that discipline slips.

## Two things the harness will not save you from

**Order-flow edges decay in seconds; this strategy holds for minutes.** A signal
that predicts twenty seconds ahead cannot pay for a 15-point stop where
commission is already 3.5% of R. The ideas here are restricted to the slow end
deliberately — 15-minute aggregation, session-scale imbalance, absorption.

**Harvesting a fast edge may be prohibited anyway.** DayTraders' rules name
"excessive trade volume over short periods"; Apex names hands-off systems. If
only sub-minute features separate, that is the answer and the project stops.
