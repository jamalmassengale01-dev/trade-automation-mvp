#!/usr/bin/env python3
"""
Order-flow excursion probe.

Reads a Databento MBP-1 CSV export, builds 5-minute bars with order-flow
features, applies one entry condition, and writes a trade list in the SAME
format `research/entry-screen/edge.py` already reads.

That last part is the whole design. The scoring — coin-flip baseline,
cluster-robust standard errors, split-half stability, EV above commission, the
non-finite-stop guard — is protocol that has absorbed five bugs. It transfers
only if the output shape matches, so it does.

    python3 synth.py --days 20 --edge 0.35 > edged.csv
    python3 flow_probe.py edged.csv --idea delta-momentum --out trades.csv
    python3 ../entry-screen/edge.py trades.csv delta-momentum

MEASUREMENT PROTOCOL, matching entry-edge-tester.pine so results are comparable
with the fourteen already screened:

  - entry on bar close, one position at a time
  - stop at 1 x ATR(14), floored at 15 points
  - a distant 5R probe target, so the excursion is not truncated before 4R
  - 240-bar time stop
  - maximum favourable excursion recorded per trade, converted to R

WHAT IS DELIBERATELY NOT HERE: no take-profit search, no ladder, no breakeven,
no split exits. Those redistribute an edge and cannot create one, and including
them lets a losing entry be tuned into something that looks profitable.
"""
import argparse
import csv
import math
import sys
from collections import deque
from datetime import datetime

POINT_VALUE = 2.0        # MNQ: $2 per point
TICK = 0.25
COMMISSION = 1.24        # round turn, one micro
MIN_STOP_PTS = 15.0
ATR_LEN = 14
PROBE_R = 5.0
MAX_BARS = 240
BAR_SECONDS = 300


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------

REQUIRED = ('ts_event', 'action', 'side', 'price', 'size')


def read_trades(path):
    """
    Yield (timestamp, price, size, signed_size) for trade events only.

    Databento marks the AGGRESSOR in `side`: 'B' when a buy order initiated the
    trade, 'A' when a sell did. That attribution is the single thing tick data
    provides which OHLCV cannot, and every feature here rests on it — so a file
    without it is rejected rather than silently treated as unsigned volume.
    """
    with open(path, newline='') as fh:
        rdr = csv.DictReader(fh)
        missing = [c for c in REQUIRED if c not in (rdr.fieldnames or [])]
        if missing:
            raise SystemExit(
                f'Input is missing required column(s): {", ".join(missing)}\n'
                f'Found: {", ".join(rdr.fieldnames or [])}\n\n'
                'This probe needs an MBP-1 or trades export with an aggressor side. '
                'An OHLCV export cannot be used — the whole point is the signed flow.'
            )
        seen_side = False
        for row in rdr:
            if row.get('action') != 'T':
                continue
            side = (row.get('side') or '').strip().upper()
            if side in ('A', 'B'):
                seen_side = True
            sign = 1 if side == 'B' else (-1 if side == 'A' else 0)
            ts = _parse_ts(row['ts_event'])
            size = int(float(row['size']))
            yield ts, float(row['price']), size, sign * size
        if not seen_side:
            raise SystemExit(
                'No trade carried an aggressor side (B or A). Without it every '
                'feature here is zero. Check the schema — MBP-1 or trades, not OHLCV.'
            )


def _parse_ts(raw):
    raw = raw.strip()
    if raw.isdigit():                      # nanoseconds since epoch
        return int(raw) // 1_000_000_000
    return int(datetime.fromisoformat(raw.replace('Z', '+00:00')).timestamp())


# ---------------------------------------------------------------------------
# Bars + order-flow features
# ---------------------------------------------------------------------------

class Bar:
    __slots__ = ('ts', 'o', 'h', 'l', 'c', 'vol', 'delta', 'big_delta', 'atr',
                 'cum_delta', 'delta_z')

    def __init__(self, ts, px):
        self.ts = ts
        self.o = self.h = self.l = self.c = px
        self.vol = 0
        self.delta = 0          # signed volume in this bar
        self.big_delta = 0      # signed volume from prints in the top size decile
        self.atr = None
        self.cum_delta = 0      # session-cumulative signed volume
        self.delta_z = 0.0      # delta relative to its own recent distribution


def build_bars(trades, big_print_threshold=None):
    """
    Aggregate ticks into 5-minute bars carrying signed volume.

    `big_delta` needs a size threshold, and choosing it from the data being
    tested is a small specification search. It is taken from the FIRST session
    only and then frozen, so later sessions cannot inform it.
    """
    bars = []
    cur = None
    cum = 0
    first_day = None
    first_day_sizes = []

    for ts, px, size, signed in trades:
        day = ts // 86400
        if first_day is None:
            first_day = day
        if day == first_day and big_print_threshold is None:
            first_day_sizes.append(size)

        slot = ts - (ts % BAR_SECONDS)
        if cur is None or slot != cur.ts:
            if cur is not None:
                bars.append(cur)
            if cur is None or day != (cur.ts // 86400):
                cum = 0                      # cumulative delta resets each session
            cur = Bar(slot, px)
            cur.cum_delta = cum
        cur.h = max(cur.h, px)
        cur.l = min(cur.l, px)
        cur.c = px
        cur.vol += size
        cur.delta += signed
        cum += signed
        cur.cum_delta = cum
    if cur is not None:
        bars.append(cur)

    if big_print_threshold is None:
        first_day_sizes.sort()
        big_print_threshold = (first_day_sizes[int(0.95 * len(first_day_sizes))]
                               if first_day_sizes else 10)

    _add_atr(bars)
    _add_delta_z(bars)
    return bars, big_print_threshold


def _add_atr(bars):
    trs = deque(maxlen=ATR_LEN)
    prev_close = None
    for b in bars:
        tr = (b.h - b.l) if prev_close is None else max(
            b.h - b.l, abs(b.h - prev_close), abs(b.l - prev_close))
        trs.append(tr)
        b.atr = sum(trs) / len(trs) if len(trs) == ATR_LEN else None
        prev_close = b.c


def _add_delta_z(bars, window=20):
    hist = deque(maxlen=window)
    for b in bars:
        if len(hist) == window:
            m = sum(hist) / window
            var = sum((x - m) ** 2 for x in hist) / window
            sd = math.sqrt(var)
            b.delta_z = (b.delta - m) / sd if sd > 0 else 0.0
        hist.append(b.delta)


# ---------------------------------------------------------------------------
# Entry conditions — the only part to edit, mirroring SECTION 1 of the Pine
# ---------------------------------------------------------------------------

def condition(name, bars, i):
    """Return +1 long, -1 short, 0 nothing, for bar i."""
    b = bars[i]

    if name == 'delta-momentum':
        # Signed volume unusually one-sided over the last three bars (15 min).
        # The pilot hypothesis: flow leads price at this horizon.
        if i < 3:
            return 0
        z = sum(bars[k].delta_z for k in range(i - 2, i + 1)) / 3
        return 1 if z > 1.0 else (-1 if z < -1.0 else 0)

    if name == 'delta-divergence':
        # Price makes a 30-minute high while cumulative delta does not:
        # absorption, passive size meeting the initiating flow.
        if i < 6:
            return 0
        hi = max(bars[k].h for k in range(i - 6, i))
        lo = min(bars[k].l for k in range(i - 6, i))
        cd = [bars[k].cum_delta for k in range(i - 6, i)]
        if b.h > hi and b.cum_delta < max(cd):
            return -1
        if b.l < lo and b.cum_delta > min(cd):
            return 1
        return 0

    if name == 'positive-control':
        # Reads the NEXT bar's close. Must produce double-digit sigma. If it
        # does not, the harness cannot detect an edge and nothing else it says
        # means anything.
        if i + 1 >= len(bars):
            return 0
        return 1 if bars[i + 1].c > b.c else -1

    if name == 'negative-control':
        # A coin flip. Must land within noise of the 1/(1+T) line at every
        # horizon. Catches the opposite failure: a harness that MANUFACTURES
        # signal. The Pine harness never had this check.
        import random
        return random.choice([1, -1])

    raise SystemExit(f'Unknown idea: {name}')


IDEAS = ('delta-momentum', 'delta-divergence', 'positive-control', 'negative-control')


# ---------------------------------------------------------------------------
# The probe
# ---------------------------------------------------------------------------

def run(bars, idea, rth_only=True):
    trades = []
    pos = None

    for i, b in enumerate(bars):
        if pos is not None:
            hi, lo = b.h, b.l
            if pos['dir'] > 0:
                pos['mfe'] = max(pos['mfe'], hi - pos['entry'])
                hit_stop = lo <= pos['stop']
                hit_tgt = hi >= pos['target']
            else:
                pos['mfe'] = max(pos['mfe'], pos['entry'] - lo)
                hit_stop = hi >= pos['stop']
                hit_tgt = lo <= pos['target']
            pos['bars'] += 1

            done = hit_stop or hit_tgt or pos['bars'] >= MAX_BARS
            if done:
                # A bar that spans both is scored as the stop. Assuming the
                # target filled first is the optimistic read and it is how
                # backtests flatter themselves.
                exit_px = pos['stop'] if hit_stop else (
                    pos['target'] if hit_tgt else b.c)
                pnl = (exit_px - pos['entry']) * pos['dir'] * POINT_VALUE - COMMISSION
                trades.append({**pos, 'exit_ts': b.ts, 'pnl': pnl,
                               'reason': 'stop' if hit_stop else ('target' if hit_tgt else 'time stop')})
                pos = None
            continue

        if b.atr is None:
            continue                      # ATR not warm — refuse rather than export sd=NaN
        if rth_only and not _in_rth(b.ts):
            continue

        d = condition(idea, bars, i)
        if d == 0:
            continue
        stop_dist = max(b.atr, MIN_STOP_PTS)
        if not math.isfinite(stop_dist) or stop_dist <= 0:
            continue
        pos = {
            'dir': d, 'entry': b.c, 'sd': stop_dist, 'bars': 0, 'mfe': 0.0,
            'entry_ts': b.ts,
            'stop': b.c - d * stop_dist,
            'target': b.c + d * stop_dist * PROBE_R,
        }
    return trades


def _in_rth(ts):
    """09:30-16:00 ET. The pilot is RTH-only; MBP-1 covers the full session."""
    from datetime import datetime, timezone, timedelta
    et = datetime.fromtimestamp(ts, timezone.utc) - timedelta(hours=5)
    mins = et.hour * 60 + et.minute
    return 570 <= mins < 960 and et.weekday() < 5


def write_trades(trades, path, label):
    """Exactly the shape edge.py reads."""
    from datetime import datetime, timezone
    fmt = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%d %H:%M')
    with open(path, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['Trade number', 'Type', 'Date and time', 'Signal', 'Price USD',
                    'Size (qty)', 'Net PnL USD', 'Favorable excursion USD',
                    'Adverse excursion USD', 'Duration (bars)'])
        for n, t in enumerate(trades, 1):
            side = 'long' if t['dir'] > 0 else 'short'
            mfe_usd = t['mfe'] * POINT_VALUE
            w.writerow([n, f'Exit {side}', fmt(t['exit_ts']), t['reason'], '', 1,
                        f"{t['pnl']:.2f}", f'{mfe_usd:.2f}', '', t['bars']])
            w.writerow([n, f'Entry {side}', fmt(t['entry_ts']),
                        f"{label} sd={t['sd']:.2f}", f"{t['entry']:.2f}", 1,
                        f"{t['pnl']:.2f}", f'{mfe_usd:.2f}', '', t['bars']])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='Databento MBP-1 CSV export')
    ap.add_argument('--idea', required=True, choices=IDEAS)
    ap.add_argument('--out', required=True)
    ap.add_argument('--all-session', action='store_true',
                    help='Include overnight. Default is RTH only.')
    a = ap.parse_args()

    bars, thr = build_bars(read_trades(a.input))
    trades = run(bars, a.idea, rth_only=not a.all_session)

    span = ''
    if bars:
        from datetime import datetime, timezone
        f = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%d')
        span = f'  {f(bars[0].ts)}..{f(bars[-1].ts)}'
    longs = sum(1 for t in trades if t['dir'] > 0)
    print(f'{len(bars)} bars{span}   big-print threshold {thr} (from session 1 only)')
    print(f'{len(trades)} trades ({longs}L/{len(trades)-longs}S)  -> {a.out}')
    if not trades:
        print('\nNo trades. Either the condition never fires or the input is wrong.')
        return 1
    write_trades(trades, a.out, a.idea)
    print(f'\nScore it:\n  python3 ../entry-screen/edge.py {a.out} {a.idea}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Piping into head closes stdout early. Not a failure.
        os = __import__('os')
        os._exit(0)
