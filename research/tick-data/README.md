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

Current status: **all four pass** (+8.14 / +0.03 / -0.12 / +16.62).

Do not read a result from this harness if a gate is failing.

## The pilot

```bash
# 1. Download one month of MNQ MBP-1 from Databento's portal as CSV.
#    $125 in signup credits should cover it. MBP-1, not OHLCV — the whole
#    point is the aggressor side on each trade.

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
