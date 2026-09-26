/**
 * Fleet simulation runner — is the revolving door worth anything?
 *
 *   npm run fleet:sim
 *   npm run fleet:sim -- --win-rate 0.60 --tp2-share 0.70 --eval-price 44
 *
 * Compares copy-trading (every account takes every signal, which is what
 * `gbLiveExecutor` does today) against rotation (only some accounts online at a
 * time), holding everything else identical. The accounts share one signal
 * stream, so the only thing that differs between the two columns is which
 * segment of the return path each account is exposed to.
 *
 * Read the NET column. Everything else is diagnosis.
 */
import { simulateFleet, FleetParams } from '../strategy/fleetMonteCarlo';

interface Cli {
  winRate: number; fullWinShare: number; evalPrice: number;
  slots: number; horizonDays: number;
}

const DEFAULTS: Cli = {
  // The measured GB LIVE edge: 65.3% at 0.5R against a 66.7% coin flip, i.e.
  // none. Override when there is something better to model.
  winRate: 0.55, fullWinShare: 0.45,
  evalPrice: 109, slots: 10, horizonDays: 250,
};

function parse(argv: string[]): { cli: Cli; measured: string[] } {
  const cli = { ...DEFAULTS };
  const measured: string[] = [];
  const num = (flag: string, raw: string | undefined, lo: number, hi: number) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${flag} needs a number, got "${raw}"`);
    if (v < lo || v > hi) throw new Error(`${flag} must be between ${lo} and ${hi}, got ${v}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const raw = inline ?? argv[i + 1];
    const eat = () => { if (inline === undefined) i++; };
    switch (flag) {
      case '--win-rate': cli.winRate = num(flag, raw, 0, 1); measured.push('win rate'); eat(); break;
      case '--tp2-share': cli.fullWinShare = num(flag, raw, 0, 1); measured.push('TP2 share'); eat(); break;
      case '--eval-price': cli.evalPrice = num(flag, raw, 0, 1000); eat(); break;
      case '--slots': cli.slots = num(flag, raw, 1, 50); eat(); break;
      case '--days': cli.horizonDays = num(flag, raw, 20, 2000); eat(); break;
      case '--help':
        console.log(
          'Usage: npm run fleet:sim -- [--win-rate 0.55] [--tp2-share 0.45]\n' +
          '                           [--eval-price 109] [--slots 10] [--days 250]\n\n' +
          'Rates are fractions between 0 and 1. Defaults model the MEASURED\n' +
          'GB LIVE edge, which is none.',
        );
        process.exit(0);
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}. Try --help`);
    }
  }
  return { cli, measured };
}

let cli: Cli; let measured: string[];
try { ({ cli, measured } = parse(process.argv.slice(2))); }
catch (e) { console.error(`\n${e instanceof Error ? e.message : e}\n`); process.exit(1); }

const APEX: Omit<FleetParams, 'activeSlots' | 'binAtPct'> = {
  startBalance: 50000, targetProfit: 3000, maxDrawdown: 2000,
  ddMode: 'eod_trailing', lockBuffer: 100, dailyLossCap: 1000,
  baseRisk: 334, capStep: 3, expiryDays: 30, minTradingDays: 1,
  evalPrice: cli.evalPrice, safetyNet: 2100, minPayout: 500,
  slots: cli.slots, staggerDays: 7,
  winRate: cli.winRate, fullWinShare: cli.fullWinShare, breakevenRate: 0.05,
  tradesPerDay: 1.4, maxTradesPerDay: 3,
};

console.log(
  `\nApex 50K, ${cli.slots} slots, 7-day stagger, ${cli.horizonDays} trading days, ` +
  `$${cli.evalPrice}/evaluation`,
);
console.log(`Win rate ${(cli.winRate * 100).toFixed(0)}%, ${(cli.fullWinShare * 100).toFixed(0)}% of wins reaching TP2`);
console.log(
  measured.length === 0
    ? 'ALL EDGE INPUTS ASSUMED — the defaults model a strategy measured to have none.'
    : `Measured: ${measured.join(', ')}. Everything else assumed.`,
);
console.log(
  '\nQualifying days and the consistency rule are NOT modelled. Both delay\n' +
  'payouts, so every net figure below is optimistic.\n',
);

const row = (label: string, active: number, bin: number | null) => {
  const r = simulateFleet({ ...APEX, activeSlots: active, binAtPct: bin }, cli.horizonDays, 2000, 42);
  console.log(
    `${label.padEnd(30)} spent $${String(r.spent).padStart(6)}  ` +
    `out $${String(r.extracted).padStart(7)}  ` +
    `NET ${(r.net >= 0 ? '+' : '') + String(r.net).padStart(7)}  ` +
    `win ${(r.profitableRuns * 100).toFixed(0).padStart(3)}%  ` +
    `evals ${String(r.evalsBought).padStart(5)} (${r.evalsPassed} passed)  ` +
    `p10/p50/p90 ${r.netPercentiles.p10}/${r.netPercentiles.p50}/${r.netPercentiles.p90}`,
  );
};

row('copy-trade, all on', cli.slots, null);
row('copy-trade + bin at -6%', cli.slots, -0.06);
row('rotate, half online', Math.max(1, Math.round(cli.slots / 2)), null);
row('rotate, half + bin at -6%', Math.max(1, Math.round(cli.slots / 2)), -0.06);
row('rotate, 3 online', Math.min(3, cli.slots), null);
row('rotate, 3 + bin at -6%', Math.min(3, cli.slots), -0.06);
console.log();
