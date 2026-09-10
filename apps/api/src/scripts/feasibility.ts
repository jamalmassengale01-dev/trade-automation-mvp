/**
 * Backtest → prop firm feasibility.
 *
 *   npm run feasibility -- --trades 50 --winrate 68 --avgwin 63.85 \
 *                          --avgloss 101.12 --maxdd 744.90 --days 22
 *
 * Take the six numbers straight off the TradingView Strategy Tester:
 *   trades + win rate   → "Profitable trades" (e.g. 34/50, 68%)
 *   avgwin              → Gross profit ÷ number of wins
 *   avgloss             → Gross loss ÷ number of losses (positive)
 *   maxdd               → "Max drawdown" in dollars
 *   days                → trading days the tested window spans
 *
 * Reports against Apex 50K and Phidias 50K, and the drawdown you would get
 * sizing to each firm's GB LIVE base risk — usually the number that decides it.
 */
import {
  assessFeasibility, formatFeasibility, drawdownAtRisk,
  BacktestStats, FirmConstraints,
} from '../strategy/backtestFeasibility';

const num = (name: string, fallback?: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return Number(process.argv[i + 1]);
};

const stats: BacktestStats = {
  trades: num('trades'),
  winRate: num('winrate') / 100,
  avgWin: num('avgwin'),
  avgLoss: Math.abs(num('avgloss')),
  maxDrawdown: Math.abs(num('maxdd')),
  tradingDays: num('days'),
};

const FIRMS: Array<{ name: string; baseRisk: number; c: FirmConstraints }> = [
  {
    name: 'Apex 50K EOD Eval', baseRisk: 334,
    c: { targetProfit: 3000, maxDrawdown: 2000, evalTradingDays: 21, minTradingDays: 1 },
  },
  {
    name: 'Phidias 50K Eval', baseRisk: 417,
    c: { targetProfit: 4000, maxDrawdown: 2500, evalTradingDays: null, minTradingDays: 3 },
  },
];

const safety = num('safety', 0.5);

console.log('');
for (const f of FIRMS) {
  const r = assessFeasibility(stats, f.c, { drawdownSafetyFraction: safety });
  console.log(formatFeasibility(f.name, stats, f.c, r));
  const dd = drawdownAtRisk(stats, f.baseRisk);
  const over = dd > f.c.maxDrawdown;
  console.log(
    `  at $${f.baseRisk}/trade  drawdown $${dd} vs $${f.c.maxDrawdown} cap` +
    (over ? '  ← BLOWN at this sizing' : '  ← fits')
  );
  console.log('');
}
