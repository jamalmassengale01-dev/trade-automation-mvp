/**
 * Evaluation Monte Carlo runner.
 *
 *   npm run eval:sim
 *
 * Edit the assumptions at the top. The win rate and fullWinShare are the two
 * that matter and neither is validated from live trading — vary them and read
 * the spread, rather than quoting any single row.
 */
import { simulateEval, EvalSimParams } from '../strategy/evalMonteCarlo';
const edge = { fullWinShare: 0.70, breakevenRate: 0.05, tradesPerDay: 1.4, maxTradesPerDay: 3, winRate: 0.60 };
const APEX = { startBalance:50000, targetProfit:3000, maxDrawdown:2000, ddMode:'eod_trailing' as const,
  lockBuffer:100, dailyLossCap:1000, baseRisk:334, capStep:3, minTradingDays:1, ...edge };
const PHID = { startBalance:50000, targetProfit:4000, maxDrawdown:2500, ddMode:'eod_trailing' as const,
  lockBuffer:null, dailyLossCap:1250, baseRisk:417, capStep:3, expiryDays:null, minTradingDays:3, ...edge };

const show = (l: string, p: any, cost: number) => {
  const r = simulateEval(p, 20000, 42);
  console.log(`${l.padEnd(24)} pass ${(r.passRate*100).toFixed(1)}%  fail ${(r.failRate*100).toFixed(1)}%  ` +
    `(breach ${(r.blowRate*100).toFixed(1)} / seized ${(r.seizedRate*100).toFixed(1)})  still-open ${(r.expiredRate*100).toFixed(1)}%  ` +
    `days ${r.daysToPass.p10}/${r.daysToPass.p50}/${r.daysToPass.p90}  $/funded ${r.costPerFunded(cost)}`);
};
console.log('At 60% win rate, 70% of wins reaching TP2:\n');
show('Apex, 30-day clock',    { ...APEX, expiryDays: 30 },   109);
show('Apex, clock removed',   { ...APEX, expiryDays: null }, 109);
show('Phidias, no clock',     PHID,                          116);
