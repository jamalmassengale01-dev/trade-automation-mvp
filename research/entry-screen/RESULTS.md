# Entry screen results — MNQ 5m, Sep 2023 – Mar 2025

*Run with the tools in this directory. See README.md for how, and for why the
coin-flip line rather than the win rate is the yardstick.*

**COMPLETE. Nine ideas, no survivor.** Holdout Mar 2025 – Sep 2026 never opened.

Bar: **+2.6 sigma**, set before any result was seen (nine ideas, one-sided, FWER
5%). An idea also had to survive split-half stability and show EV above
commission. Coin flip at 0.5R is **66.7%** — that is the number to beat, not 50%.

| idea | source | n | best z | at | split-half | EV | verdict |
|---|---|---|---|---|---|---|---|
| high-volume impulse | R1 #2 | 3050 | **+2.36** | 0.5R | **-0.20 / +3.49** | -0.005R | DEAD |
| same-interval-yesterday | R1 #3 | 3174 | +1.39 | 4.0R | +1.17 / +0.85 | +0.017R | DEAD |
| close-location persistence | R2 #9 | 1578 | +1.26 | 2.0R | +1.81 / +0.08 | +0.014R | DEAD |
| Treasury → MNQ | R2 #6 | 3327 | +1.23 | 3.0R | +1.83 / -0.06 | +0.003R | DEAD |
| opening → closing half-hour | R1 #4 | 369 | +1.03 | 4.0R | +1.84 / -0.33 | +0.080R | DEAD |
| 20-bar momentum | R1 #5 | 2050* | +0.00 | 4.0R | -0.16 / +0.16 | -0.034R | DEAD |
| VIX stress (RTH) | R2 #7 | 1127*† | -0.47 | 0.5R | -0.92 / +0.27 | -0.039R | DEAD |
| ATR shock reversal | R1 #1 | 1232* | -1.77 | 1.0R | -1.77 / -0.56 | -0.083R | DEAD |
| ES → NQ convergence | R2 #10 | 6 | — | — | — | — | UNTESTABLE |
| ~~turn of month~~ | R2 #8 | — | — | — | — | — | WITHDRAWN before testing |

`*` run truncated early — see Corrections.  `†` effectively short-only.

**Nothing cleared the bar. Nothing showed EV above commission at the horizon
where it was most significant.** The single result above 2 sigma failed both
robustness checks.

---

## The one that came closest

**High-volume impulse** reached +2.36 at 0.5R, positive at all eight horizons.
It fails on two counts that matter more than significance:

- **Split-half.** First half z = **-0.20**, second half **+3.49**. The entire
  effect lives after June 2024; the first nine months sit exactly on the
  coin-flip line. Quarterly: -0.85, -0.48, +1.63, -0.89, +2.75, +0.93, +2.43.
- **EV.** At 0.5R it is **-0.005R per trade** against a commission cost of
  0.035R. A real-looking effect smaller than the cost of trading it.

**The control run is inconclusive, not exculpating.** GPT flagged that
`ta.sma(volume, 20)` spans the session boundary, so "volume > 1.5x average"
fires near-automatically at the RTH open and part of the effect may be a clock.
Re-run with the window ON at 0930-1600: 542 trades, 67.9% at 0.5R, best z +0.74.

That looks like the effect vanishing, but it is mostly lost power. n fell from
3050 to 542, so even an identical effect would only be expected to show z ~ +0.98;
it showed +0.61. Testing the two directly gives z = -0.37 — statistically
indistinguishable — and the control's 95% interval at 0.5R is 63.9-71.9%, which
contains both the baseline and the full-run figure. The point estimate shrank
(2.0pp above baseline to 1.2pp), consistent with a partial clock artifact, but
this cannot be resolved on 542 trades. The verdict does not depend on it: the
split-half and EV failures stand on their own.

A useful by-product: restricting to RTH raised ATR-based stops from ~15 to ~48
points, cutting cost from 0.035R to 0.013R per trade. Same effect the 45-minute
run showed, by a different route.

The temptation it created is worth recording, because it is exactly how the old
London result happened: test 2024-onward only, or harvest at 3R, or drop the
short side. Each picks a specification after seeing which one looks good, and
turns +2.36 into a number that means nothing.

## The rest

**Treasury → MNQ** carried the strongest prior of the nine — rates move first,
equities follow, mechanism documented — and it is flat. 3327 trades, full
window, balanced both sides, mildly NEGATIVE at every horizon below 1.5R.
Nothing was wrong with the run.

**Opening → closing half-hour** was the best-designed test: one genuinely
independent trade per day, no clustering, 369 observations. 66.9% against 66.7%.

**Same-interval-yesterday** is the cleanest null — 66.6% against 66.7%. Notable
because GPT rated it highest, and because its bar-offset bug (288 vs 276
bars/day) was fixed first so it got a fair test rather than a guaranteed failure.

**ATR shock reversal** was 1.6-2.7 sigma NEGATIVE at every horizon: buying a
1.5-ATR drop did worse than a coin flip. The tempting move was to flip the sign.
**20-bar momentum tests continuation directly and was preregistered**, so the
flip got an honest test — and came back 2-3 sigma negative too. Chasing that
shape would have built on a hypothesis its own preregistered test refutes. That
rule paid for itself once in this screen.

**A pattern that did not hold up.** After ATR shock and 20-bar momentum both came
back negative, high-volume impulse was expected to fail the same way, since it
also conditions on a large move. It was positive at every horizon. Two
overlapping ideas on one instrument were never evidence of a pattern, which was
flagged at the time and should have carried more weight.

**ES → NQ convergence** fired 6 times in 18 months once the contract-roll guard
was added — a power problem, not a null. The preregistered beta-adjusted variant
is more permissive and would reach maybe 10-12, still an order of magnitude
short. The binding constraint is the 0.3% ES move; lowering it would be choosing
a specification after seeing the result.

**VIX stress** (†) needed two runs. The first had the session window OFF and
produced 7 longs against 1400 shorts: CBOE:VIX is not calculated 24h while MNQ
trades 23, so outside Cboe's hours the series repeats its last value and the long
leg, which needs a VIX downtick, cannot fire. With the window ON the entries
correctly confine to hours 09-15, but the split is still **2 long to 1125
short** — the long leg barely fires even inside Cboe's hours. So this is a
short-only test and the stated hypothesis was never fully tested. Recorded DEAD
anyway: every horizon negative, best -0.47.

---

## Corrections made during screening

Recorded because each cost real time and each would otherwise be rediscovered.

- **Two numbering schemes collided, and it corrupted the first run.** The round-1
  notes numbered the first batch of ideas 1-5 (`#2` = high-volume impulse); a
  later list renumbered the surviving nine 1-9 (`#2` = close-location). "Run idea #2" therefore
  produced high-volume impulse, and it was filed as close-location for most of
  the day. **Ideas are named, never numbered.**

- **The misattribution was then papered over with a fabricated mechanism.**
  Faced with the same idea apparently producing 3050 and 1578 trades, a confident
  explanation was constructed — transition-only triggering left off, correlated
  episodes inflating the fire rate. It was wrong. They were different ideas.
  "Unknown" was the correct answer, and this is recorded because a plausible
  mechanism invented to fit a discrepancy is much harder to notice than an
  admitted gap.

- **The Idea label input fixes this class of problem.** It rides into every entry
  comment and identifies the run from its CSV alone. Three exports were scored
  against the wrong idea before it existed.

- **Day-weighted clustering check was wrong and was replaced.** Weighting each
  day equally lets a one-trade day count as much as a twelve-trade day; low-count
  days skew high, so it returned +4.7 on an idea whose trade-level z was +2.3.
  Now a cluster-robust SE on the pooled rate. Measured inflation across all runs:
  ×0.98-1.06. Clustering was never the problem.

- **The on-chart table cannot see a Deep Backtesting run.** It reports 0 trades
  beside a Key stats panel reading thousands, because the table is drawn by the
  script instance on the ordinary chart feed. Use the CSV export.

- **Runs silently truncate.** Three did, at different dates, with the date range
  verified correct, no script error, and LESS compute than runs that completed.
  Cause never established. `edge.py` now checks the date span of every export.
  No truncated run was borderline, so nothing is compromised.

- **Exits were attached one bar late.** `position_size` reads zero on the bar an
  entry is submitted, so a guarded `strategy.exit` left one bar unprotected.

- **Continuous contracts splice.** `ES1!` and `MNQ1!` roll quarterly and do not
  necessarily splice on the same bar or with the same back-adjustment, so a
  multi-bar return spanning the roll is a bookkeeping jump. Every trade in the
  first ES → NQ run landed on a roll date. A splice guard was added.

- **The tester claimed common identifier names.** Its internals were called
  `atr`, `pos` and `flat` — in a script built to have arbitrary code pasted into
  it. An idea defining its own `atr` failed to compile with "already defined"
  pointing ninety lines away. Now `mAtr` / `mPos` / `mFlat`.

- **"Reset settings to defaults" sets the session window OFF.** Tick it after the
  reset, not before.

---

## What this does and does not establish

**Does:** these nine specific entry conditions, on MNQ 5-minute bars over Sep
2023 – Mar 2025, do not predict direction well enough to clear a 2.6-sigma bar.
The measurement instrument works and its failure modes are now known and guarded.

**Does not:** that no intraday edge exists, or that these families are barren.
Nine hypotheses is a small sample of a large space, all were generated in two
sittings by one model, all were tested on one instrument at one timeframe, and
all had to be expressible in a few lines of OHLCV Pine. That last constraint is
severe and excludes most of what professional intraday strategies actually use.

**The holdout is intact.** Mar 2025 – Sep 2026 has never been looked at, so it
remains a real test for whatever comes next.
