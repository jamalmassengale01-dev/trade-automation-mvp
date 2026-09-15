/**
 * Evaluation Monte Carlo runner.
 *
 *   npm run eval:sim
 *   npm run eval:sim -- --win-rate 0.58 --tp2-share 0.62 --trades-per-day 1.1
 *
 * The two numbers that decide everything are the win rate and the share of
 * winners that reach TP2 rather than stopping the runner at breakeven. Neither
 * has ever been measured on this strategy. The defaults below are ASSUMPTIONS,
 * kept only so the command runs; when you have figures from a Strategy Tester
 * run or a live account, pass them and the output describes your strategy
 * instead of a guess.
 *
 * Vary them and read the spread. A single row quoted out of this is how the
 * unreproducible 85.5% got into circulation in the first place.
 */
import { simulateEval } from '../strategy/evalMonteCarlo';

interface Edge {
  winRate: number;
  fullWinShare: number;
  breakevenRate: number;
  tradesPerDay: number;
  maxTradesPerDay: number;
}

/** Assumed, not measured. Override from the command line. */
const DEFAULTS: Edge = {
  winRate: 0.60,
  fullWinShare: 0.70,
  breakevenRate: 0.05,
  tradesPerDay: 1.4,
  maxTradesPerDay: 3,
};

function parseArgs(argv: string[]): { edge: Edge; measured: string[] } {
  const edge = { ...DEFAULTS };
  const measured: string[] = [];

  const num = (flag: string, raw: string | undefined, lo: number, hi: number): number => {
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${flag} needs a number, got "${raw}"`);
    if (v < lo || v > hi) throw new Error(`${flag} must be between ${lo} and ${hi}, got ${v}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const raw = inline ?? argv[i + 1];
    const consume = () => { if (inline === undefined) i++; };
    switch (flag) {
      // Rates are fractions, not percentages: 0.58, not 58. Accepting both
      // would silently treat a typo'd 58 as an impossible win rate.
      case '--win-rate':
        edge.winRate = num(flag, raw, 0, 1); measured.push('win rate'); consume(); break;
      case '--tp2-share':
        edge.fullWinShare = num(flag, raw, 0, 1); measured.push('TP2 share'); consume(); break;
      case '--breakeven-rate':
        edge.breakevenRate = num(flag, raw, 0, 1); measured.push('breakeven rate'); consume(); break;
      case '--trades-per-day':
        edge.tradesPerDay = num(flag, raw, 0, 10); measured.push('trades per day'); consume(); break;
      case '--help':
        console.log(
          'Usage: npm run eval:sim -- [--win-rate 0.58] [--tp2-share 0.62]\n' +
          '                          [--breakeven-rate 0.05] [--trades-per-day 1.4]\n\n' +
          'Rates are fractions between 0 and 1. Anything you do not pass falls back\n' +
          'to an assumed default, and the output says which.',
        );
        process.exit(0);
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}. Try --help`);
    }
  }
  return { edge, measured };
}

let edge: Edge;
let measured: string[];
try {
  ({ edge, measured } = parseArgs(process.argv.slice(2)));
} catch (error) {
  // A stack trace for "you typed 58 instead of 0.58" teaches nothing.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${message}\n`);
  // Only offer the fractions hint when the mistake plausibly IS that. Attaching
  // it to an unknown-flag error sends you looking at a number that is fine.
  if (/between 0 and 1/.test(message)) {
    console.error('Rates are fractions: --win-rate 0.58, not 58.\n');
  }
  console.error('See --help for the full list.\n');
  process.exit(1);
}

const APEX = {
  startBalance: 50000, targetProfit: 3000, maxDrawdown: 2000, ddMode: 'eod_trailing' as const,
  lockBuffer: 100, dailyLossCap: 1000, baseRisk: 334, capStep: 3, minTradingDays: 1, ...edge,
};
const PHID = {
  startBalance: 50000, targetProfit: 4000, maxDrawdown: 2500, ddMode: 'eod_trailing' as const,
  lockBuffer: null, dailyLossCap: 1250, baseRisk: 417, capStep: 3, expiryDays: null,
  minTradingDays: 3, ...edge,
};

const show = (l: string, p: Parameters<typeof simulateEval>[0], cost: number) => {
  const r = simulateEval(p, 20000, 42);
  console.log(`${l.padEnd(24)} pass ${(r.passRate*100).toFixed(1)}%  fail ${(r.failRate*100).toFixed(1)}%  ` +
    `(breach ${(r.blowRate*100).toFixed(1)} / seized ${(r.seizedRate*100).toFixed(1)})  still-open ${(r.expiredRate*100).toFixed(1)}%  ` +
    `days ${r.daysToPass.p10}/${r.daysToPass.p50}/${r.daysToPass.p90}  $/funded ${r.costPerFunded(cost)}`);
};

console.log(
  `Win rate ${(edge.winRate*100).toFixed(0)}%, ${(edge.fullWinShare*100).toFixed(0)}% of wins reaching TP2, ` +
  `${edge.tradesPerDay} trades/day`,
);
// Which inputs are real and which are invented has to travel WITH the numbers.
// Detached from that caveat, a pass rate reads as a measurement.
console.log(
  measured.length === 0
    ? 'ALL INPUTS ASSUMED — nothing below is a measurement of this strategy.'
    : `Measured: ${measured.join(', ')}. Everything else assumed.`,
);
console.log();

show('Apex, 30-day clock',    { ...APEX, expiryDays: 30 },   109);
show('Apex, clock removed',   { ...APEX, expiryDays: null }, 109);
show('Phidias, no clock',     PHID,                          116);
