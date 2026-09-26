# Compliance questions to the prop firms

| firm | drafted | sent | reply |
|---|---|---|---|
| Apex Trader Funding | 17 Sep 2026 | 26 Sep 2026 | awaiting |
| Phidias | 17 Sep 2026 | 26 Sep 2026 | awaiting |
| DayTraders.com | 26 Sep 2026 | — | — |

When a reply arrives, paste it below the relevant letter with the date received.
The point of asking in writing was to have something dated to keep — that only
works if the answer is filed rather than read and closed.

These exist because several things this project depends on are recorded in
`CLAUDE.md` as *not first-hand verified* — the network blocked every Apex,
Tradovate and DayTraders support page during research, so those findings rest on
search summaries. A dated written answer from the firm is worth more than any
page that can be screenshotted, and the firms' published pages have already
contradicted each other across sources.

**Superseded 26 Sep 2026: a Phidias 50K Premium evaluation has been purchased**
($144.60 one-time). The letters went out before the purchase, which was the right
order, but the "asking costs nothing" advantage no longer applies at Phidias. It
still applies at Apex and DayTraders, where no accounts are held.

The Phidias reply now matters more than it did when the letter was written. If
art. 6.2 "sudden enrichment" is read to cover the risk ladder, that is an account
already paid for which would have to be traded differently.

File the replies against these questions when they arrive.

---

## 1. Apex Trader Funding

**To:** Apex support (their ticket form, or the support address on the site)
**Subject:** Rules question on automated execution — before purchasing an evaluation

> Hello,
>
> I'm planning to purchase an evaluation account and want to confirm that my
> intended setup complies with your rules before I buy rather than after.
>
> My setup would be:
>
> - A TradingView indicator I wrote myself generates entry signals on MNQ during
>   three fixed 30-minute windows, a maximum of three trades per day.
> - Those signals route by webhook to a third-party execution bridge
>   (PickMyTrade), which places the orders on my Tradovate account.
> - Every order carries a stop loss and take profit set at the time of entry.
> - I monitor the sessions while they are active and can intervene or flatten
>   manually at any time.
> - The accounts would be my own, traded only by me. Nothing is sold or shared
>   with anyone else.
>
> Four questions:
>
> **1.** Is automated order execution permitted on an **evaluation** account, and
> is it permitted on a **Performance Account**? I have seen it stated that bots
> and auto-strategies are allowed during evaluations but prohibited on PA and
> Live accounts, and I would like to confirm that directly from you.
>
> **2.** Does the setup above count as permitted, or as a prohibited automated
> system? If the distinction turns on supervision, I would like to understand
> what level of supervision satisfies the rule — for example, whether manually
> approving each order before it is submitted would make an otherwise-identical
> setup permitted.
>
> **3.** Connecting a third-party execution bridge requires providing that service
> with my Tradovate login. Does that conflict with the requirement to keep account
> credentials confidential, and are there specific bridges you consider approved?
>
> **4.** Does varying position size between trades — for example, increasing size
> after a losing trade within a fixed daily loss limit — fall under any prohibited
> category?
>
> I would rather adjust my approach now than discover a problem after funding. A
> written answer I can keep on file would be appreciated.
>
> Thank you,
> Jamal Massengale

**Why question 2 is phrased that way.** "Is my bot allowed?" invites a reflexive
no. "What level of supervision satisfies the rule?" invites a boundary you can
build against — and if manual approval of each order is the line, that is a
workable system, just a different one from the plan in
`/root/.claude/plans/`.

---

## 2. Phidias

**To:** Phidias support (their contact form — no verified address on file)
**Subject:** Rules clarification before purchasing — automation, position sizing, and API access

> Hello,
>
> I am considering purchasing a CASH evaluation and want to confirm several points
> against your General Terms (version 18 May 2026) before I buy. I have read the
> Terms and my questions are about how specific provisions apply to a concrete
> setup.
>
> My intended setup:
>
> - A TradingView indicator I wrote myself generates entry signals on MNQ during
>   three fixed 30-minute windows, maximum three trades per day.
> - Signals route by webhook to an execution bridge that places the orders on my
>   Tradovate account.
> - Every order carries a stop loss and take profit set at entry, and I monitor
>   the sessions while they are active.
> - The accounts would be my own and traded only by me.
>
> **1. Automated execution.** Article 6.2 prohibits any strategy or system
> designed to obtain an unfair advantage, but I could not find a provision that
> addresses automated order execution either way. Is automated execution of a
> trader's own strategy permitted on CASH accounts? If it is permitted subject to
> conditions, I would like to know what they are.
>
> **2. Position sizing after a loss — article 6.2.** Article 6.2 prohibits "sudden
> enrichment" strategies, defined as concentrating a limited number of very
> high-risk transactions aimed at generating a disproportionate gain at the cost
> of risking full depletion of the account. My approach varies position size
> between trades: after a losing trade the next position may be larger, up to a
> cap of three steps, and always bounded by the account's daily loss limit so that
> the maximum single-day loss is unchanged. Does a bounded, capped progression of
> that kind fall within the prohibition, or does the provision target something
> different?
>
> **3. Third-party execution bridges — article 6.2.** Article 6.2 also prohibits
> sharing account credentials with any third party. Connecting a commercial
> execution bridge requires providing that service with my Tradovate login. Does
> using such a service conflict with that provision? If some bridges are approved
> and others are not, I would like to know which.
>
> **4. API access to CASH accounts.** Is a Phidias CASH account reachable through
> the Tradovate API, and if so how is the API credential obtained? My
> understanding is that individual Tradovate API keys do not extend to prop firm
> accounts, so I would like to know whether any documented path exists on your
> side.
>
> **5. Professional data classification — article 4.6.** Article 4.6 states that
> LIVE account holders may be classified as professional, that market data fees
> are deducted monthly from the trading account, and that an account which cannot
> cover them is closed for insufficient assets with loss of unwithdrawn profits.
> Does this apply to CASH accounts, and if so what is the monthly amount I should
> expect?
>
> I would rather adjust my approach before funding than discover a conflict
> afterwards. A written answer I can keep on file would be appreciated.
>
> Thank you,
> Jamal Massengale

**Why five and in this order.** Questions 1 and 3 together decide whether the
architecture is legal at Phidias at all. Question 2 is the one their Terms make
genuinely ambiguous — a ladder capped at three steps inside a fixed daily loss
limit is not obviously "risking full depletion", but it is close enough to the
described shape to want their reading rather than ours. Question 5 is the one
people skip: article 4.6 lets them close an account and keep unwithdrawn profits
over unpaid data fees, which is a severe outcome attached to a number that is
currently unknown.

---

## 3. DayTraders.com

**To:** DayTraders help desk (`help.daytraders.com`)
**Subject:** Automation and API questions before purchasing a 50K EOD evaluation

Context: unlike the other two, this firm's published pricing page was read
first-hand — $105 + $5 activation, $2,000 EOD trailing drawdown, $1,250 daily
loss limit, $3,000 target, 10 contracts / 100 micros, 2 qualifying days minimum,
$200 qualifying day, 50% eval / 30% Pro consistency, max 5 EOD accounts, $2,000
max per payout request, Rithmic platform with ArcTrader coming.

The questions below are the things that page does **not** answer.

> Hello,
>
> I am considering a 50K EOD evaluation and have read your pricing page and help
> centre. Four questions the published rules do not settle, and two product
> questions.
>
> My intended approach: an indicator I wrote myself generates signals on MNQ
> during three fixed 30-minute windows, a maximum of three trades per day on
> 5-minute bars. Orders are placed automatically, each with a stop loss and take
> profit set at entry, and I monitor the sessions while they are active.
>
> **1. Automation and the HFT rule.** Your help centre prohibits automated
> high-frequency trading — systems exploiting price discrepancies in milliseconds
> or microseconds, and excessive trade volume over short periods. Three trades a
> day on 5-minute bars is a long way from that description, but I would rather
> confirm than assume. Is ordinary automated execution of a trader's own strategy
> permitted, and does the answer differ between **evaluation** accounts and
> **Pro / funded** accounts?
>
> **2. Rithmic API access.** Can an account holder obtain Rithmic `R|API+`
> credentials for a DayTraders account? If so, how are they requested, what does
> it cost, and does the access include **execution and order reports** — that is,
> can I read my own fills and realised P&L programmatically, not only place
> orders?
>
> **3. Third-party execution bridges.** Is connecting a commercial bridge such as
> PickMyTrade permitted? Doing so requires giving that service my platform login,
> so I would also like to know whether that conflicts with any rule about keeping
> credentials confidential, and whether specific bridges are approved.
>
> **4. Position sizing between trades.** My approach varies size after a losing
> trade — the next position may be larger, capped at three steps, and always
> bounded by the daily loss limit so the maximum single-day loss is unchanged.
> Does a bounded progression of that kind fall foul of any rule?
>
> **5. Account limits.** The 50K EOD page shows a maximum of 5 EOD accounts. Is
> that five in total, or five per drawdown type — could I hold 5 EOD plus 5 Trail
> plus 5 Static concurrently?
>
> **6. Two details the page does not state.** Is there a time limit on an
> evaluation, and how is the consistency rule computed — as a share of profit
> since the last payout, or across the life of the account?
>
> Thank you,
> Jamal Massengale

**Why this firm is worth asking.** It is the only one surveyed where the
published automation rule targets **HFT specifically** rather than automation
generally, and where the platform (Rithmic) has an API that reports executions.
If questions 1 and 2 both come back favourably, DayTraders solves the two
problems that stopped the Apex/Phidias path at once — legality at the funded
stage, and a fills feedback channel — with no bridge, no statement import and no
NinjaTrader listener.

**What to watch in the reply.** The "no restrictions on bots" claim circulating
about this firm comes from affiliate review sites, not from DayTraders. Their own
help centre says HFT is prohibited, which is not the same statement. Treat
question 1's answer as the only authority.

**One number that is not the advantage it looks like.** The $1,250 daily loss
limit is larger than Apex's $1,000, but total drawdown is the same $2,000. Apex
gives two maximum-loss days before the account is dead; this gives **1.6**. A
bigger DLL against an unchanged drawdown protects you less, and it pushes base
risk from $334 to $417 if sized at DLL/3.

**And the 30% Pro consistency rule is the tightest of any firm surveyed** — no
single day above 30% of profit since the last payout. On three trades a day that
is genuinely binding.

---

## What the answers decide

| Answer | Consequence |
|---|---|
| Apex prohibits automation on PAs | The fleet model's economics break — automation is permitted on the $109 stage and forbidden on the $13,000 stage. Relay plan needs rewriting around Topstep's Express Funded Account. |
| Apex permits it under supervision | Need the definition of supervision. Manual per-order approval is buildable but is a different system. |
| Phidias prohibits bridges (art. 6.2 credentials) | PickMyTrade is out at Phidias regardless of the automation answer. |
| Phidias permits API access to CASH | Removes the fills-feedback problem there entirely — see open question 8. |
| Either firm confirms a data fee on CASH | Direct cost against the account, with closure as the failure mode. |
| DayTraders permits automation on Pro accounts | The Apex eval/PA split stops being the binding constraint — a venue exists where the funded stage can be automated. |
| DayTraders offers Rithmic API with execution reports | Open question 8 closes. No bridge, no statement import, no NinjaTrader listener — the relay plan collapses to a much simpler direct integration. |
| Both of the above | DayTraders becomes the default venue and the architecture plan needs rewriting around Rithmic rather than PickMyTrade. |
