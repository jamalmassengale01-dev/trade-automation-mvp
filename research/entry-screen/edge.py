#!/usr/bin/env python3
"""
Read an Entry Edge Tester trade-list export and report whether the entry
predicts direction.

    python3 edge.py <export.csv> [label]

The yardstick is arithmetic. With a stop at 1R, a driftless random walk touches
a target of T*R before stopping with probability 1/(1+T). Hit rates above that
line are predictive power; everything at or below it is a coin flip wearing a
win rate.

Three things are reported beyond the headline, because each has already caught
a result that looked real:

  clustering   Trades in one session overlap and share regime, so treating them
               as independent inflates the z. Weighting days equally tests the
               same claim without that assumption.
  stability    An effect present in only half of its own discovery window is not
               something you can size a position against.
  EV           Significance is not money. A 2-sigma edge smaller than commission
               is a true fact you cannot trade.
"""
import csv, sys, math, statistics, collections

PV = 2.0        # MNQ: $2 per point. MES 5.0, MYM 0.5 — change per instrument.
COMMISSION = 1.24
HORIZONS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
BAR = 2.6       # nine ideas screened; set before any result was seen

# Discovery window. Mar 2025 - Sep 2026 stays sealed for whatever survives.
WINDOW_START, WINDOW_END = '2023-09-01', '2025-03-01'
WINDOW_STARTS_BY = '2023-09-30'   # a month's grace for warm-up and rare signals
WINDOW_ENDS_BY   = '2025-02-01'


def load(path):
    rows = list(csv.DictReader(open(path, encoding='utf-8-sig')))
    tr = {}
    for r in rows:
        t = tr.setdefault(int(r['Trade number']), {})
        if 'Entry' in r['Type']:
            sig = r['Signal']
            if 'sd=' not in sig:
                raise SystemExit(
                    f"Entry signal is {sig!r}, with no sd= in it.\n"
                    "This export came from a tester without the stop distance in the "
                    "entry comment. Re-paste the current tester and re-run — run-up is "
                    "in dollars and cannot be turned into R without it."
                )
            t['label'] = sig.split('sd=')[0].strip()
            t['sd'] = float(sig.split('sd=')[1])
            t['long'] = 'long' in r['Type']
            t['dt'] = r['Date and time']
        else:
            t['mfe'] = float(r['Favorable excursion USD'])
            t['pnl'] = float(r['Net PnL USD'])
            t['exit'] = r['Signal']
    T = [t for t in tr.values() if 'sd' in t and 'mfe' in t]
    for t in T:
        t['R'] = (t['mfe'] / PV) / t['sd']
    T.sort(key=lambda t: t['dt'])
    return T


def z_for(T, target):
    rw = 1 / (1 + target)
    got = sum(t['R'] >= target for t in T) / len(T)
    return got, (got - rw) / math.sqrt(rw * (1 - rw) / len(T)), rw


def main(path, label):
    T = load(path)
    N = len(T)
    cost = sum(COMMISSION / (t['sd'] * PV) for t in T) / N
    ts = sum(t['exit'] == 'time stop' for t in T)

    print(f'\n{label}   {N} trades  '
          f'({sum(t["long"] for t in T)}L/{sum(not t["long"] for t in T)}S)  '
          f'{T[0]["dt"][:10]}..{T[-1]["dt"][:10]}  PnL ${sum(t["pnl"] for t in T):,.0f}')
    if ts:
        print(f'  {ts} time stops ({ts/N*100:.1f}%)')

    # What the script said it was running, from the export itself. Three runs
    # came back as an earlier idea re-exported because a stale copy of the
    # script was left on the chart; nothing visible distinguished them.
    labels = {t.get('label', '') for t in T}
    tag = ', '.join(sorted(l for l in labels if l)) or '(none)'
    print(f'  label in export: {tag}')
    if tag in ('(none)', 'unlabelled'):
        print('  -> set "Idea label" in the Inputs tab so runs can be told apart')

    # A backtest can stop early without saying so. It happened once here: a run
    # with the date range set correctly and no script error ended nine months
    # short, and the only trace was the last date in this file. Cause never
    # established — so check the span every time rather than trusting the run.
    if T[-1]['dt'][:10] < WINDOW_ENDS_BY:
        print(f'\n  *** TRUNCATED: last trade {T[-1]["dt"][:10]}, window runs to '
              f'{WINDOW_END}.\n  *** Sample is short. Re-run before trusting a '
              f'borderline result.')
    if T[0]['dt'][:10] > WINDOW_STARTS_BY:
        print(f'\n  *** LATE START: first trade {T[0]["dt"][:10]}, window opens '
              f'{WINDOW_START}.')

    # A near-total one-sided split means one leg of the condition essentially
    # never fires. That is a broken test, not a directional edge: the VIX idea
    # produced 7 longs against 1400 shorts because CBOE:VIX is not calculated
    # overnight, so the long leg needed a downtick in a frozen series.
    nl = sum(t['long'] for t in T)
    share = max(nl, N - nl) / N
    if share > 0.90:
        side = 'long' if nl > N - nl else 'short'
        print(f'\n  *** ONE-SIDED: {share*100:.1f}% {side}. One leg of the '
              f'condition almost never fires.\n  *** Usually a data-availability '
              f'problem, not an edge. Check the reference series trades when '
              f'the chart does.')
    if N < 100:
        print('\n  UNDER 100 TRADES — the interval is wider than any edge you would act on.')
        return

    print(f'\n{"target":>7} {"coin flip":>10} {"measured":>10} {"edge":>8} {"EV/trade":>10}')
    best = (None, -99)
    for g in HORIZONS:
        got, z, rw = z_for(T, g)
        ev = got * g - (1 - got) - cost
        mark = '  <<<' if z >= BAR else ('  <' if z >= 2.0 else '')
        print(f'{g:6.2f}R {rw*100:9.1f}% {got*100:9.1f}% {z:+7.2f}s {ev:+9.3f}R{mark}')
        if z > best[1]:
            best = (g, z)

    g, z = best
    print(f'\nlargest deviation {z:+.2f}s at {g}R    bar {BAR:+.1f}')

    # Clustering: same pooled rate, standard error that allows trades in one
    # session to be correlated.
    #
    # NOT the mean of daily hit rates. That weights a day with one trade the
    # same as a day with twelve, low-count days skew high, and the estimator
    # sits above the pooled rate whatever the data says — it returned +4.7 on
    # an idea whose trade-level z was +2.3 and +4.6 on one at +1.4. A check
    # that fires on everything is not a check.
    #
    # Cluster-robust: Var(p) = sum_d (k_d - n_d*p)^2 / N^2, the standard
    # sandwich form with the day as the cluster.
    byday = collections.defaultdict(list)
    for t in T:
        byday[t['dt'][:10]].append(t['R'] >= g)
    D = len(byday)
    rw = 1 / (1 + g)
    p = sum(t['R'] >= g for t in T) / N
    se_c = math.sqrt(sum((sum(d) - len(d) * p) ** 2 for d in byday.values())) / N
    zc = (p - rw) / se_c
    infl = se_c / math.sqrt(rw * (1 - rw) / N)
    print(f'  cluster-robust ({D} days, {N/D:.1f}/day): z={zc:+.2f} '
          f'(SE x{infl:.2f} vs independent)')

    # Stability: an edge in one half only is not an edge.
    h = N // 2
    _, z1, _ = z_for(T[:h], g)
    _, z2, _ = z_for(T[h:], g)
    # Only meaningful when the headline is near the bar. Splitting a null in
    # half reliably produces one positive and one negative pile, and flagging
    # that as instability dresses noise up as a diagnosis.
    unstable = min(z1, z2) < 0.5 <= max(z1, z2) and z >= 2.0
    print(f'  first half z={z1:+.2f}   second half z={z2:+.2f}'
          f'{"   SPLIT-HALF FAILURE" if unstable else ""}')

    got, _, _ = z_for(T, g)
    ev = got * g - (1 - got) - cost
    print(f'  EV at {g}R: {ev:+.3f}R/trade (cost {cost:.3f}R)'
          f'{"  — below cost" if ev <= 0 else ""}')

    ok = z >= BAR and min(z1, z2) >= 0.5 and ev > 0
    print(f'\nVERDICT: {"CARRY FORWARD — retest on MES, then the holdout" if ok else "DEAD"}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'entry')
