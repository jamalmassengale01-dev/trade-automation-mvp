#!/usr/bin/env python3
"""
Synthetic MBP-1 generator, for validating the harness before real data costs
anything.

Emits the column layout Databento's CSV export uses, so the same ingest path is
exercised. Crucially it can plant a KNOWN relationship between order flow and
subsequent returns, at a size you choose — which is the only way to answer "can
this harness detect an edge" without buying data first.

    python3 synth.py --days 20 --edge 0.0    > flat.csv    # no relationship
    python3 synth.py --days 20 --edge 0.35   > edged.csv   # strong, plainly detectable

The Pine harness shipped with five bugs, three of which were invisible until
something else contradicted them. This exists so the same does not happen twice.
"""
import argparse
import random
import sys
from datetime import datetime, timedelta, timezone

# Databento MBP-1 CSV header, trimmed to the fields the probe reads. The ingest
# selects by name, so extra columns in a real export are ignored rather than
# breaking anything.
HEADER = [
    'ts_event', 'action', 'side', 'price', 'size',
    'bid_px_00', 'ask_px_00', 'bid_sz_00', 'ask_sz_00', 'symbol',
]

TICK = 0.25          # MNQ
SPREAD_TICKS = 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=20)
    ap.add_argument('--edge', type=float, default=0.0,
                    help='How strongly flow imbalance predicts the next 15 minutes. '
                         '0 = none. 0.35 = unmistakable.')
    ap.add_argument('--trades-per-min', type=int, default=40)
    ap.add_argument('--tick-vol', type=float, default=0.62,
                    help='Per-trade price noise. 0.62 gives 5-minute bars with a '
                         '15-25 point range, which is what MNQ actually does. Too '
                         'quiet and a 15-point stop never resolves, so one trade '
                         'blocks the next for a hundred bars.')
    ap.add_argument('--start-price', type=float, default=20000.0)
    ap.add_argument('--seed', type=int, default=42)
    a = ap.parse_args()

    rng = random.Random(a.seed)
    out = sys.stdout
    out.write(','.join(HEADER) + '\n')

    px = a.start_price
    # Sessions run 09:30-16:00 ET; the pilot is RTH-only so the synthetic is too.
    day = datetime(2024, 1, 2, 14, 30, tzinfo=timezone.utc)   # 09:30 ET

    for d in range(a.days):
        session_start = day + timedelta(days=d)
        if session_start.weekday() >= 5:
            continue
        minutes = 390

        # Pre-draw a per-15-minute "flow bias". When --edge is non-zero the same
        # bias drives BOTH the order flow in this block and the return in the
        # NEXT one, which is exactly the relationship the probe should find.
        blocks = minutes // 15 + 1
        bias = [rng.gauss(0, 1) for _ in range(blocks)]

        for m in range(minutes):
            blk = m // 15
            ts = session_start + timedelta(minutes=m)

            # Drift for this minute: noise, plus the PREVIOUS block's bias when
            # an edge is planted.
            drift = rng.gauss(0, 2.0)
            if a.edge and blk > 0:
                drift += a.edge * 6.0 * bias[blk - 1]

            for _ in range(a.trades_per_min):
                px += drift / a.trades_per_min + rng.gauss(0, a.tick_vol)
                px = round(px / TICK) * TICK

                # Aggressor side: biased by this block's bias, so flow leads.
                p_buy = 0.5 + 0.18 * max(-1.0, min(1.0, bias[blk]))
                side = 'B' if rng.random() < p_buy else 'A'
                size = rng.choice([1, 1, 1, 2, 2, 3, 5, 10])

                bid = round((px - TICK * SPREAD_TICKS / 2) / TICK) * TICK
                ask = bid + TICK * SPREAD_TICKS
                out.write(
                    f'{ts.isoformat()},T,{side},{px:.2f},{size},'
                    f'{bid:.2f},{ask:.2f},{rng.randint(1, 60)},{rng.randint(1, 60)},MNQZ4\n'
                )
                ts += timedelta(milliseconds=int(60000 / a.trades_per_min))
    return 0


if __name__ == '__main__':
    sys.exit(main())
