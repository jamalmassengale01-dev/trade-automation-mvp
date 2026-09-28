#!/usr/bin/env python3
"""
Order-flow excursion probe.

Reads a Databento `trades` (or MBP-1) CSV export, builds 5-minute bars with
order-flow features, applies one entry condition, and writes a trade list in the
SAME format `research/entry-screen/edge.py` already reads.

Order `trades`, not `mbp-1`: this file reads five columns — ts_event, action,
side, price, size — and never looks at a bid or an ask. MBP-1's book snapshots
are the bulk of the bytes and every one of them is discarded here.

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
import random
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

# Databento's native CSV writes prices as fixed-point integers scaled by 1e9.
# The portal can emit decimals instead, and which one arrives depends on a
# checkbox. Getting it wrong does not crash: a price of 2.0e13 gives an ATR of
# 2.0e13, a stop of 2.0e13, and a probe that silently reports nothing rather
# than something wrong. Detect it instead of trusting the export.
DBN_PRICE_SCALE = 1e-9
PLAUSIBLE_DECIMAL = (1.0, 1e6)
PLAUSIBLE_FIXED = (1e9, 1e15)


def detect_price_scale(path, sample=500):
    """
    Settle decimal-versus-fixed-point from the first few trades, not from faith
    in a download setting. Returns the multiplier to apply to `price`.

    Refuses rather than guesses when the magnitude fits neither convention —
    an unrecognised scale is the failure that produces a plausible-looking zero.
    """
    prices = []
    with open(path, newline='') as fh:
        rdr = csv.DictReader(fh)
        if 'price' not in (rdr.fieldnames or []):
            return 1.0                       # the column check below will fire
        for row in rdr:
            if row.get('action') not in (None, '', 'T'):
                continue
            try:
                p = abs(float(row['price']))
            except (TypeError, ValueError):
                continue
            if p > 0:
                prices.append(p)
            if len(prices) >= sample:
                break
    if not prices:
        return 1.0
    prices.sort()
    med = prices[len(prices) // 2]
    if PLAUSIBLE_DECIMAL[0] <= med <= PLAUSIBLE_DECIMAL[1]:
        return 1.0
    if PLAUSIBLE_FIXED[0] <= med <= PLAUSIBLE_FIXED[1]:
        return DBN_PRICE_SCALE
    raise SystemExit(
        f'Median price in the first {len(prices)} trades is {med:g}, which is '
        'neither a decimal price nor a 1e-9 fixed-point one.\n'
        'Refusing to guess: a wrong price scale makes the ATR, the stop and '
        'every excursion wrong without failing.'
    )


def read_trades(path, price_scale=1.0, want_symbol=None):
    """
    Yield (timestamp, price, size, signed_size) for trade events only.

    Databento marks the AGGRESSOR in `side`: 'B' when a buy order initiated the
    trade, 'A' when a sell did. That attribution is the single thing tick data
    provides which OHLCV cannot, and every feature here rests on it — so a file
    without it is rejected rather than silently treated as unsigned volume.

    A file holding more than one contract is also rejected. Databento's parent
    symbology (`MNQ.FUT`) returns every listed expiration, and interleaving two
    expirations into one bar series produces hundred-point gaps at every
    handover that read as real range — the ATR, the stop and the excursions all
    inherit them.
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
        id_col = 'symbol' if 'symbol' in rdr.fieldnames else (
            'instrument_id' if 'instrument_id' in rdr.fieldnames else None)
        seen_side = False
        seen_ids = set()
        for row in rdr:
            if row.get('action') != 'T':
                continue
            if id_col:
                ident = (row.get(id_col) or '').strip()
                if want_symbol and ident != want_symbol:
                    continue
                if ident:
                    seen_ids.add(ident)
                    if len(seen_ids) > 1:
                        raise SystemExit(
                            f'Input holds more than one contract: '
                            f'{", ".join(sorted(seen_ids))}.\n'
                            'Two expirations interleaved into one bar series is '
                            'not a price history. Re-export a single contract, '
                            'or pick one with --symbol.'
                        )
            side = (row.get('side') or '').strip().upper()
            if side in ('A', 'B'):
                seen_side = True
            sign = 1 if side == 'B' else (-1 if side == 'A' else 0)
            ts = _parse_ts(row['ts_event'])
            size = int(float(row['size']))
            yield ts, float(row['price']) * price_scale, size, sign * size
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
        #
        # Seeded off the bar index so the gate is reproducible. Unseeded, a run
        # that drifts to 2.4 sigma and a run that drifts to 2.6 are the same
        # code, and the gate stops meaning anything.
        return 1 if random.Random(i * 2654435761).random() < 0.5 else -1

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


def _nth_sunday(year, month, n):
    from datetime import date
    d = date(year, month, 1)
    return d.replace(day=1 + (6 - d.weekday()) % 7 + 7 * (n - 1))


_DST_CACHE = {}


def _et_offset(ts):
    """
    Hours to subtract from UTC for US Eastern: 4 under DST, 5 otherwise.

    Hardcoded rather than read from a tz database so the ingest does not depend
    on the container having zoneinfo. DST runs from the second Sunday in March
    at 07:00 UTC to the first Sunday in November at 06:00 UTC.

    This started life as a flat -5, which is right for a January slice and an
    hour wrong for a June one — it would have shifted the session window to
    08:30-15:00 ET, pulling in the pre-open and cutting the last half hour.
    """
    from datetime import datetime, timezone, timedelta
    utc = datetime.fromtimestamp(ts, timezone.utc)
    y = utc.year
    if y not in _DST_CACHE:
        start = datetime.combine(_nth_sunday(y, 3, 2), datetime.min.time(),
                                 timezone.utc) + timedelta(hours=7)
        end = datetime.combine(_nth_sunday(y, 11, 1), datetime.min.time(),
                               timezone.utc) + timedelta(hours=6)
        _DST_CACHE[y] = (start, end)
    start, end = _DST_CACHE[y]
    return 4 if start <= utc < end else 5


def _in_rth(ts):
    """09:30-16:00 ET. The pilot is RTH-only; MBP-1 covers the full session."""
    from datetime import datetime, timezone, timedelta
    et = datetime.fromtimestamp(ts, timezone.utc) - timedelta(hours=_et_offset(ts))
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
    ap.add_argument('input', help='Databento trades or MBP-1 CSV export')
    ap.add_argument('--idea', required=True, choices=IDEAS)
    ap.add_argument('--out', required=True)
    ap.add_argument('--all-session', action='store_true',
                    help='Include overnight. Default is RTH only.')
    ap.add_argument('--symbol', default=None,
                    help='Keep only this contract, for an export holding several.')
    a = ap.parse_args()

    scale = detect_price_scale(a.input)
    if scale != 1.0:
        print(f'prices are 1e-9 fixed point; scaling by {scale:g}')

    bars, thr = build_bars(read_trades(a.input, scale, a.symbol))
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
