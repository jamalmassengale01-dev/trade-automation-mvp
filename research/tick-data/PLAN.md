# Order-flow research: plan, and the reason it might not be worth doing

**Status: not started. This is a proposal, not a commitment.**

## Why this is on the table

Two screens, fourteen entry conditions, nothing above +2.36 sigma — and that one
failed both robustness checks. The harness has since been validated with a
deliberate-lookahead positive control that returned +18.78 sigma, so those
fourteen nulls are real nulls, not a measurement artifact.

What both screens had in common was not their ideas. It was their **data**.
Every condition had to be expressible in a few lines of Pine over OHLCV plus
`request.security`. Screen 2 pushed that as far as it goes — breadth, credit,
volatility surface, index composition, futures-versus-cash — and still found
nothing.

The one category with a documented short-horizon mechanism that Pine cannot see
at any price is **order flow**: who initiated each trade, what sits on each side
of the book, where size is accumulating. That is what this plan is about.

---

## Read this before anything else: the reason it may fail

**Order-flow edges decay in seconds. This strategy holds for minutes to hours.**

The published microstructure results — trade imbalance, book pressure, queue
dynamics — predict the next few seconds. GB LIVE's shape is a 15-point stop on
MNQ, three trades a day, measured out to 0.5R and beyond. Those are different
sports.

So there are three ways this ends badly, and they should be priced in now:

**1. The edge is real and unharvestable.** A signal that predicts 20 seconds
ahead cannot pay for a 15-point stop. Commission alone is ~4% of R at that stop
distance, and a fast edge needs many trades, which multiplies the cost.

**2. Harvesting it requires a shape the firms prohibit.** Trading order flow
properly means shorter holds, tighter stops, more trades. DayTraders' rules
prohibit "excessive trade volume over short periods"; Apex names "hands-off,
set-and-forget" systems. An order-flow strategy that works may be exactly the
thing that gets an account closed.

**3. It needs a different execution path.** Sub-minute entries do not route
through a TradingView webhook and a bridge.

**The mitigation, and it must be designed in from the start:** target only the
**slow** end of order flow — cumulative delta over 5–30 minute windows,
large-trade accumulation, absorption at levels, session-scale imbalance. These
are the microstructure features that persist on the horizon the strategy
actually trades, and they are also the ones no prop firm would call HFT.

If the pilot shows the slow features are flat and only the fast ones predict,
**that is the answer, and the project stops there.** Say so now, before $500 and
a week are spent discovering it.

---

## De-risk first: a pilot that costs roughly nothing

Databento gives **$125 in free credits on signup** and bills usage-based. That is
very likely enough for:

- **One month** of MNQ data, MBP-1 (top of book + trades) rather than full MBO
- **One hypothesis**: cumulative trade imbalance over a 15-minute window
- One run through the existing scoring protocol

The pilot answers the only question that matters before committing: **does a slow
order-flow feature show anything above the coin-flip line on this instrument?**

One month gives roughly 20 trading days. At a few trades per day that is 60–100
trades — nowhere near enough to clear a significance bar, and it is not meant to.
The pilot is a **go/no-go on effect size**, not a test. If the point estimate sits
on the line with no hint of separation, stop. If it separates, buy the history.

Do not skip this step. Two screens have now produced fourteen nulls; the base
rate justifies spending $0 before spending $500.

---

## What gets reused, what gets built

**Reused unchanged:**

| Piece | Why it survives the tool change |
|---|---|
| `edge.py` | Reads a trade-list CSV. Instrument- and tool-agnostic. |
| The coin-flip baseline | 1/(1+T) is arithmetic, not a TradingView feature. |
| Cluster-robust SE, split-half, EV-above-cost | Same three gates, same reasons. |
| The sealed holdout | Mar 2025 – Sep 2026 is a date range, not a dataset. Still unopened, still worth exactly one test. |
| Preregistration discipline | Declare the batch, fix the bar, never re-specify after seeing a result. |

**The key design constraint: the new harness emits the same CSV shape
`edge.py` already reads.** Columns `Trade number`, `Type`, `Date and time`,
`Signal` (carrying `<label> sd=<n>`), `Favorable excursion USD`, `Net PnL USD`.
Match that and the entire accumulated protocol — including the five bug fixes it
has absorbed — transfers for free.

**Built new:**

| Component | Est. | Notes |
|---|---|---|
| Data ingest | 0.5 day | Databento API → local parquet. Their Python client handles most of it. |
| Feature construction | 1 day | Ticks → signed volume, cumulative delta, book imbalance, large-print flags, aggregated to 5m. |
| Entry simulator | 1.5 days | Apply condition on bar close, 1R ATR stop, 5R probe target, 240-bar time stop, record maximum favourable excursion. This is `entry-edge-tester.pine` in Python. |
| Positive control | 0.5 day | Same lookahead cheat. Non-negotiable — the Pine harness had five bugs and three were invisible until something contradicted them. |

**Roughly 3.5 days of build**, after a pilot that costs nothing.

---

## The hypotheses, slow end only

Declared up front. Bar rises with the count: six ideas puts it near **+2.5
sigma**, one-sided, family-wise 5%.

1. **Cumulative delta divergence.** Price makes a new 30-minute high while
   cumulative signed volume does not. Classic absorption; the mechanism is that
   passive size is meeting the initiating flow.
2. **Session-scale imbalance.** Signed volume over the session so far, relative
   to its own recent distribution. The slowest feature here and the most likely
   to survive on a 5-minute horizon.
3. **Large-print accumulation.** Count of trades above the 95th percentile of
   size in a 15-minute window, signed. Institutional participation rather than
   retail churn.
4. **Absorption at a level.** Heavy volume at a price with little net movement —
   size being worked rather than momentum.
5. **Book imbalance, time-averaged.** Bid versus ask size at top of book,
   averaged over 5 minutes rather than sampled. Averaging is what makes it slow
   enough to matter here.
6. **Delta-price disagreement.** Signed volume and price return over 15 minutes
   pointing opposite ways.

Every one requires **1,500+ trades** over the discovery window. The round-3
prompt asked for this and GPT's estimates turned out to be bar counts rather than
trade counts — the power table in `research/entry-screen/RESULTS.md` shows why it
matters: at 700 trades the chance of detecting a genuinely good entry is 20%.

---

## Data specification

- **Instrument:** MNQ, front month, rolled on volume
- **Dataset:** `GLBX.MDP3` (CME Globex MDP 3.0)
- **Schema:** `mbp-1` — top of book plus trades with aggressor side. Full `mbo`
  is an order of magnitude more data and is only needed for queue-position work,
  which is the fast end this plan deliberately avoids.
- **Discovery window:** Sep 2023 – Mar 2025, matching both prior screens
- **Holdout:** Mar 2025 – Sep 2026, **still sealed**
- **Pilot slice:** one month inside the discovery window

Get a quote before committing. Pricing is usage-based and not published; the
figure quoted in conversation ($100–500) was an estimate from memory and has not
been verified.

---

## Verification

The harness must pass the same gate the Pine one did, **before** any hypothesis
is read:

```
1. Positive control — an entry reading the next bar's close must report
   double-digit sigma. If it does not, debug rather than search.
2. Negative control — a coin-flip entry (random long/short) must report
   hit rates within noise of 1/(1+T) at every horizon. This is the check the
   Pine harness never had, and it catches the opposite failure: a harness that
   manufactures signal.
3. Cross-check against Pine — reimplement one of the fourteen dead ideas on
   tick-derived 5m bars. It must reproduce its Pine result within noise. If a
   known-dead idea looks alive in the new harness, the harness is wrong.
```

That third one matters most. Fourteen nulls are the most valuable calibration
data available, and a new tool that disagrees with them is the tool's problem
until proven otherwise.

---

## What would make this not worth doing

Stated now so it is not rationalised away later:

- The pilot's point estimate sits on the coin-flip line with no separation.
- Only sub-minute features separate, and the slow ones are flat — meaning any
  real edge is unharvestable at a 15-point stop and would likely breach the
  firms' frequency rules anyway.
- Databento's quote for the full discovery window exceeds what a negative result
  is worth. A null costs the same as a positive here; price the information, not
  the hope.
- The compliance replies come back saying automation is prohibited at the funded
  stage everywhere. Then there is nothing to run any edge through, and the
  strategy question is moot until a venue exists.

That last one is live and unresolved. Three letters are out
(`docs/compliance-questions.md`), and **the answers arriving may make this whole
plan premature.** Worth waiting for them before spending, given the pilot is
cheap and the full project is not.
