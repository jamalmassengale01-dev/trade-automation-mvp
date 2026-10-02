# Order-flow pilot — January 2024, MNQ

**This is not a screen result and must not be recorded in
`research/entry-screen/RESULTS.md`.** It does not count against the declared
sixteen of screen 2, it does not move the significance bar, and it neither
carries an idea forward nor kills one. It is a purchase decision, logged.

## What was bought

```
dataset      GLBX.MDP3 (CME Globex MDP 3.0)
schema       trades
product      MNQ           (portal selects products, not expirations)
window       2024-01-01 .. 2024-02-01
cost         $16.47, 631.4 MB billed, 28 daily files + metadata
```

## What was run

`delta-momentum` — signed volume one-sided over three 5-minute bars, entered on
bar close, 1x ATR(14) stop floored at 15 points, 5R probe target, 240-bar time
stop, RTH only, one position at a time.

```
front month  MNQH4, 13,118,369 of 13,154,242 trades (99.7%), 7 contracts present
bars         6,312
trades       91 (47L / 44S), 4.0 per session
```

## Result

```
 target  coin flip   measured     edge   EV/trade
  0.25R      80.0%      82.4%   +0.58s    -0.002R
  0.50R      66.7%      68.1%   +0.30s    -0.010R
  0.75R      57.1%      57.1%   +0.00s    -0.032R
  1.00R      50.0%      44.0%   -1.15s    -0.153R
  1.50R      40.0%      36.3%   -0.73s    -0.126R
  2.00R      33.3%      30.8%   -0.52s    -0.109R
  3.00R      25.0%      26.4%   +0.30s    +0.023R
  4.00R      20.0%      16.5%   -0.84s    -0.208R

largest deviation +0.58s    cluster-robust z=+0.64 (23 days, SE x0.89)
split-half +0.00 / +0.81    EV below cost at every horizon but 3R
```

On the line. Signs alternate with no structure. Nothing separates.

## What this does NOT establish, and why the pilot was the wrong size

**At n=91 the standard error at 0.5R is 4.94 points.** The bar worth trading —
roughly +3 points above the coin-flip line — is **0.67 sigma at this sample
size**. The measured +1.4pp is +0.30 sigma. The two are not distinguishable.

The 95% interval on the measured 68.1% runs **58.4% to 77.8%**. It contains the
coin flip AND it contains the target edge. To have cleared 2.6 sigma here,
delta-momentum would have needed 79.5% at 0.5R — a 12.8-point edge, about four
times what would be needed to trade.

So this pilot could only have detected something enormous. `PLAN.md` set the
rule as "stop if the point estimate sits on the line with no separation", and
that rule was weaker than it read: at this sample size almost everything sits on
the line. **The design flaw is in the pilot, not in the finding.** A null here
is close to uninformative about the hypothesis.

What it did establish is that the pipeline works: 13.1M trades ingested from
compressed daily files, front month resolved by volume, eleven harness gates
green, and 4.0 trades per session — comparable to GB LIVE's three, so a slow
order-flow entry would not trip a firm's frequency rule.

## The actual decision

Not "did January show an edge" but "is order flow worth screening properly".

```
17 more months of the discovery window     ~$280
trades over Sep 2023 - Mar 2025            ~1,640
SE at 0.5R                                 1.16pp, from 4.94
a +3.3pp edge would read                   +2.8 sigma
power against a 2.6 bar                    ~60%
```

That buys the data for the **whole six-idea screen** in `PLAN.md`, not one
hypothesis. Bar rises to ~2.5 for six.

Against it: fourteen prior entry conditions, no survivor. The base rate is the
strongest argument in the room and it argues for stopping.

## DECIDED 2 October 2026: STOPPED

**The order-flow line is stopped. Order flow was never tested — this is a
decision about cost and statistical power, not a finding about the hypothesis.**

What settled it was projecting per-idea sample size before buying, anchored on
January's observed 4.1 entries per session:

```
                          8 months (credits)      18 months (~$280)
                            n      power            n      power
delta-momentum             703      30%          1572      65%
delta-divergence           950      41%          2123      80%
session-imbalance          829      35%          1854      73%
large-print                667      28%          1491      62%
absorption                 517      21%          1155      50%
delta-price-divergence     709      30%          1585      65%
```

Power is against the +2.39 bar for six tests, for the +3.3pp edge CLAUDE.md
names as the bar worth trading.

**The free credits cannot buy a screen worth running.** At ~30% power a real
edge is missed seven times in ten, and six nulls at that power say close to
nothing — the same objection `RESULTS.md` records against the ideas abandoned
as untestable. Worse, running on eight months and then buying more after a
borderline result is optional stopping: the second look is not independent and
the bar stops meaning anything. The cheap option destroys the good one.

That left ~$172 out of pocket for a screen at 50-80% power, against a base rate
of fourteen entry conditions and no survivor. **Declined.**

## What is left behind, and what would reopen it

Nothing here is deleted, and the next session should not rebuild it:

- A validated tick pipeline. 12 gates, compressed Databento batches read as
  downloaded, front month resolved per session, rolls handled.
- Six order-flow conditions implemented and declared at a bar of +2.39, none
  of them ever run on real data beyond January's delta-momentum.
- One month of MNQ trades already paid for, and ~$108 of Databento credit.
  The batch download expires 28 Oct 2026; the credit's expiry is unchecked.

Reopen it only if something changes the economics rather than the enthusiasm:
a compliance answer that makes automation viable somewhere, a venue with cheap
or bundled tick data, or a hypothesis from outside this family. Do not reopen it
by rerunning these six on eight months.

**The Mar 2025 - Sep 2026 holdout remains sealed and has never been opened.**

## If more months are bought

Re-running the other five declared ideas on this January file costs nothing and
is tempting. Resist reading anything into it: five underpowered looks at the
same 91-trade sample is noise-shopping, and a "promising" hit would be the
worst possible reason to spend $280. If the ideas are run on January, they are
run on the full window too, and they count against the declared six either way.
