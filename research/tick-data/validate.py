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

    print()
    if all(gates):
        print('All four gates pass. The harness detects a real effect, reports '
              'nothing when there is none,\nand distinguishes the two. Results '
              'from it can be read.')
        return 0
    print('A gate failed. Do not read any result from this harness until it is fixed.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
