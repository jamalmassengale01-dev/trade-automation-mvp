# Compliance questions to the prop firms

Two letters, drafted 17 September 2026. **Both sent 26 September 2026. Awaiting
replies.**

When a reply arrives, paste it below the relevant letter with the date received.
The point of asking in writing was to have something dated to keep — that only
works if the answer is filed rather than read and closed.

They exist because two things this project depends on are recorded in `CLAUDE.md`
as *not first-hand verified* — the network blocked every Apex and Tradovate
support page during research, so both findings rest on search summaries. A dated
written answer from the firm is worth more than any page that can be screenshotted,
and both firms' published pages have already contradicted each other across
sources.

**No accounts are held at either firm.** Asking before buying costs nothing;
asking while holding a funded account is a different calculation. That advantage
disappears the day an evaluation is purchased.

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

## What the answers decide

| Answer | Consequence |
|---|---|
| Apex prohibits automation on PAs | The fleet model's economics break — automation is permitted on the $109 stage and forbidden on the $13,000 stage. Relay plan needs rewriting around Topstep's Express Funded Account. |
| Apex permits it under supervision | Need the definition of supervision. Manual per-order approval is buildable but is a different system. |
| Phidias prohibits bridges (art. 6.2 credentials) | PickMyTrade is out at Phidias regardless of the automation answer. |
| Phidias permits API access to CASH | Removes the fills-feedback problem there entirely — see open question 8. |
| Either firm confirms a data fee on CASH | Direct cost against the account, with closure as the failure mode. |
