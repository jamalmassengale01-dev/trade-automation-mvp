#!/usr/bin/env python3
"""
Four gates the order-flow harness must pass before any real result is read.

    python3 validate.py

The Pine harness shipped five bugs. Three were invisible until something else
contradicted them, and one of those — a verdict that silently resolved to DEAD
when it could not compute — would have discarded a genuine edge. This runs
before every pilot so the same cannot happen here.

The third and fourth gates are the pair that matters: the SAME condition on
synthetic data with and without a planted relationship. A harness that passes a
lookahead control only proves it can see something enormous. Discriminating a
real effect from its absence is the actual job.
"""
import subprocess
import sys
import tempfile
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = os.path.join(HERE, '..', 'entry-screen', 'edge.py')


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and 'edge.py' not in ' '.join(cmd):
        print(r.stdout, r.stderr)
        raise SystemExit(f'command failed: {" ".join(cmd)}')
    return r.stdout


def score(csv_path, label):
    out = sh([sys.executable, EDGE, csv_path, label])
    m = re.search(r'largest deviation\s+([+-][\d.]+)s', out)
    n = re.search(r'(\d+) trades', out)
    if not m:
        print(out)
        raise SystemExit('could not parse a sigma from edge.py')
    return float(m.group(1)), int(n.group(1)) if n else 0


def _rewrite(src, dst, fn):
    """Copy a synthetic export, transforming each data row."""
    with open(src) as fi, open(dst, 'w') as fo:
        header = fi.readline()
        cols = header.strip().split(',')
        fo.write(header)
        for line in fi:
            parts = line.rstrip('\n').split(',')
            fn(dict(zip(cols, parts)), parts, cols)
            fo.write(','.join(parts) + '\n')


def _ingest_gates(tmp, probe, flat, gates):
    """
    The synthetic generator writes decimal prices and one contract, which is the
    happy path. A real Databento export can write 1e-9 fixed-point integers
    depending on a download checkbox, and parent symbology returns every
    expiration at once. Neither failure crashes — the first makes the stop
    2e13 points wide, the second invents hundred-point gaps at each handover.
    Both would read as "no trades" or as range that is not there.
    """
    def report(name, ok, detail):
        gates.append(ok)
        print(f'  {"PASS" if ok else "FAIL"}  {name:34s} {detail}')

    base = os.path.join(tmp, 'ing_base.csv')
    sh([sys.executable, probe, flat, '--idea', 'delta-momentum', '--out', base])
    with open(base) as fh:
        base_rows = fh.read()

    # 1. Fixed-point prices must be detected and produce an identical trade list.
    fixed = os.path.join(tmp, 'fixed.csv')
    ipx = None

    def to_fixed(row, parts, cols):
        nonlocal ipx
        if ipx is None:
            ipx = cols.index('price')
        parts[ipx] = str(int(round(float(parts[ipx]) * 1e9)))

    _rewrite(flat, fixed, to_fixed)
    out = os.path.join(tmp, 'ing_fixed.csv')
    sh([sys.executable, probe, fixed, '--idea', 'delta-momentum', '--out', out])
    with open(out) as fh:
        same = fh.read() == base_rows
    report('1e-9 fixed-point prices', same,
           'identical trade list to decimal prices' if same
           else 'DIFFERENT trade list — the scale is being mishandled')

    # 2. The `trades` schema has no book columns at all. Ordering it instead of
    #    MBP-1 is the difference between a pilot inside the signup credit and an
    #    $845 quote, so prove it is sufficient rather than asserting it.
    bare = os.path.join(tmp, 'trades_schema.csv')
    drop = ('bid_px_00', 'ask_px_00', 'bid_sz_00', 'ask_sz_00')
    with open(flat) as fi, open(bare, 'w') as fo:
        cols = fi.readline().strip().split(',')
        keep = [i for i, c in enumerate(cols) if c not in drop]
        fo.write(','.join(cols[i] for i in keep) + '\n')
        for line in fi:
            p = line.rstrip('\n').split(',')
            fo.write(','.join(p[i] for i in keep) + '\n')
    out = os.path.join(tmp, 'ing_bare.csv')
    sh([sys.executable, probe, bare, '--idea', 'delta-momentum', '--out', out])
    with open(out) as fh:
        same = fh.read() == base_rows
    report('trades schema (no book columns)', same,
           'identical trade list to MBP-1 — order the cheaper schema' if same
           else 'DIFFERENT — something reads the book after all')

    # 3. Databento's batch download splits by duration, so a month arrives as
    #    ~20 daily files. Reading them must equal reading one concatenated file,
    #    and out-of-order input must fail rather than build shuffled bars.
    daydir = os.path.join(tmp, 'daysplit')
    os.makedirs(daydir, exist_ok=True)
    with open(flat) as fi:
        header = fi.readline()
        handles = {}
        for line in fi:
            day = line.split(',', 1)[0][:10]
            if day not in handles:
                handles[day] = open(os.path.join(daydir, f'mnq-{day}.csv'), 'w')
                handles[day].write(header)
            handles[day].write(line)
        for h in handles.values():
            h.close()
    out = os.path.join(tmp, 'ing_split.csv')
    sh([sys.executable, probe, daydir, '--idea', 'delta-momentum', '--out', out])
    with open(out) as fh:
        same = fh.read() == base_rows
    report(f'day-split batch ({len(handles)} files)', same,
           'identical trade list to one file' if same
           else 'DIFFERENT — the files are not being stitched correctly')

    names = sorted(os.listdir(daydir))
    r = subprocess.run([sys.executable, probe,
                        os.path.join(daydir, names[-1]),
                        os.path.join(daydir, names[0]),
                        '--idea', 'delta-momentum',
                        '--out', os.path.join(tmp, 'ing_rev.csv')],
                       capture_output=True, text=True)
    # expand_inputs sorts, so this must succeed rather than fail — the guard is
    # there for filenames that do not sort chronologically.
    report('day-split given out of order', r.returncode == 0,
           'sorted before reading' if r.returncode == 0 else 'not sorted')

    # 4. Two contracts in one file must be refused, not silently interleaved.
    mixed = os.path.join(tmp, 'mixed.csv')
    isym = [None]
    n = [0]

    def to_mixed(row, parts, cols):
        if isym[0] is None:
            isym[0] = cols.index('symbol')
        n[0] += 1
        if n[0] % 1000 == 0:
            parts[isym[0]] = 'MNQH5'
    _rewrite(flat, mixed, to_mixed)
    r = subprocess.run([sys.executable, probe, mixed, '--idea', 'delta-momentum',
                        '--out', os.path.join(tmp, 'ing_mixed.csv')],
                       capture_output=True, text=True)
    refused = r.returncode != 0 and 'more than one contract' in (r.stdout + r.stderr)
    report('two contracts in one export', refused,
           'refused' if refused else 'ACCEPTED — expirations would interleave')

    # 5. Daylight saving. A flat UTC-5 offset is right in January and an hour
    #    wrong in June, which shifts the session window rather than failing.
    from datetime import datetime, timezone
    sys.path.insert(0, HERE)
    import flow_probe
    jan_open = int(datetime(2024, 1, 3, 14, 30, tzinfo=timezone.utc).timestamp())
    jun_open = int(datetime(2024, 6, 3, 13, 30, tzinfo=timezone.utc).timestamp())
    jun_early = int(datetime(2024, 6, 3, 13, 0, tzinfo=timezone.utc).timestamp())
    dst_ok = (flow_probe._in_rth(jan_open) and flow_probe._in_rth(jun_open)
              and not flow_probe._in_rth(jun_early))
    report('session window across DST', dst_ok,
           '09:30 ET is in session in both January and June' if dst_ok
           else 'the window is shifted in one of the two')


def main():
    tmp = tempfile.mkdtemp()
    synth = os.path.join(HERE, 'synth.py')
    probe = os.path.join(HERE, 'flow_probe.py')
    flat = os.path.join(tmp, 'flat.csv')
    edged = os.path.join(tmp, 'edged.csv')

    print('generating synthetic sessions (60 days, with and without a planted edge)...')
    with open(flat, 'w') as fh:
        fh.write(sh([sys.executable, synth, '--days', '60', '--edge', '0.0', '--seed', '1']))
    with open(edged, 'w') as fh:
        fh.write(sh([sys.executable, synth, '--days', '60', '--edge', '0.45', '--seed', '1']))

    gates = []

    def gate(name, src, idea, label, check, expectation):
        out_csv = os.path.join(tmp, f'{label}.csv')
        sh([sys.executable, probe, src, '--idea', idea, '--out', out_csv])
        z, n = score(out_csv, label)
        ok = check(z)
        gates.append(ok)
        print(f'  {"PASS" if ok else "FAIL"}  {name:34s} z={z:+6.2f}  n={n:4d}   {expectation}')

    print('\nGates:')
    # 1. Can it see an edge at all?
    gate('lookahead control', flat, 'positive-control', 'pc',
         lambda z: z >= 5.0, 'needs z >= +5')
    # 2. Does it invent one? The opposite failure, and the one a lookahead
    #    control cannot catch.
    gate('coin-flip control', flat, 'negative-control', 'nc',
         lambda z: abs(z) < 2.5, 'needs |z| < 2.5')
    # 3 and 4. The real job: same condition, edge absent then present.
    gate('real condition, no edge planted', flat, 'delta-momentum', 'dmflat',
         lambda z: abs(z) < 2.5, 'needs |z| < 2.5')
    gate('real condition, edge planted', edged, 'delta-momentum', 'dmedge',
         lambda z: z >= 5.0, 'needs z >= +5')

    print('\nIngest gates (the export format, not the statistics):')
    _ingest_gates(tmp, probe, flat, gates)

    print()
    if all(gates):
        print(f'All {len(gates)} gates pass. The harness detects a real effect, '
              'reports nothing when there is none,\ndistinguishes the two, and '
              'reads the export format correctly. Results from it can be read.')
        return 0
    print('A gate failed. Do not read any result from this harness until it is fixed.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
