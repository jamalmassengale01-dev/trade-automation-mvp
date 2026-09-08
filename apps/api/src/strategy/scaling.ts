/**
 * Performance Account scaling tiers.
 *
 * A funded Apex PA does not get its headline contract limit on day one. Both
 * the maximum position size AND the daily loss limit scale with account profit:
 *
 *   50K PA   profit $0–1,499     2 mini / 20 micro    DLL $1,000   Level 1
 *            profit $1,500–2,999 3 mini / 30 micro    DLL $1,000   Level 2
 *            profit $3,000–5,999 4 mini / 40 micro    DLL $2,000   Level 3
 *            profit $6,000+      4 mini / 40 micro    DLL $3,000   Level 4
 *
 * Treating the ceiling (40 micro) as the limit means a fresh PA is sized at
 * double what Apex allows. Apex rejects the order rather than penalising the
 * account, so the cost is not a breach — it is a signal that silently does not
 * trade, on an account whose inactivity policy is itself a risk.
 *
 * TIMING MATTERS. Apex sets the tier once per day, before the session, from the
 * previous full session's closing balance, and it "never changes during the
 * trading session". Resolving from live P&L would let size change mid-session
 * as an open trade moves — which is not how the account behaves. Callers pass a
 * basis snapshot taken at the broker-day roll, not a running total.
 *
 * Pure: no db, no io, no clock.
 */

export interface ScalingTier {
  level: number;
  /** Inclusive lower bound of account profit for this tier. */
  minProfit: number;
  /** Inclusive upper bound, or null for the top tier. */
  maxProfit: number | null;
  /** Position limit in micro contracts (1 mini = 10 micros). */
  maxContracts: number;
  dailyLossCap: number;
}

export interface ResolvedTier {
  level: number;
  maxContracts: number;
  dailyLossCap: number;
  /** True when the account sits in the highest configured tier. */
  isTopTier: boolean;
  /** Profit needed to reach the next tier, or null at the top. */
  profitToNextTier: number | null;
}

/**
 * Which tier a given profit basis falls into.
 *
 * Below the lowest tier the account stays at Level 1 — Apex's "Level 1 Floor":
 * limits never drop below it even when the balance does.
 */
export function resolveScalingTier(
  tiers: ScalingTier[],
  profitBasis: number
): ResolvedTier | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const sorted = [...tiers].sort((a, b) => a.minProfit - b.minProfit);
  const profit = Number.isFinite(profitBasis) ? profitBasis : 0;

  // Level 1 floor: a drawdown below the lowest band does not shrink limits
  // further, and never promotes a loss into a higher tier.
  let match = sorted[0];
  for (const t of sorted) {
    if (profit >= t.minProfit) match = t;
    else break;
  }

  const idx = sorted.indexOf(match);
  const next = sorted[idx + 1] ?? null;

  return {
    level: match.level,
    maxContracts: match.maxContracts,
    dailyLossCap: match.dailyLossCap,
    isTopTier: next === null,
    profitToNextTier: next ? Number((next.minProfit - profit).toFixed(2)) : null,
  };
}

/**
 * Validate a tier table.
 *
 * Apex's own published tables contain an overlap: the scaling page lists the
 * 50K top tier as "$5,999 & Up" while the daily-loss-limit page lists the same
 * tier as "$6,000 & Up", which would put $5,999 in two bands at once. This
 * checks for exactly that class of mistake rather than letting an ambiguous
 * table decide position size silently.
 */
export function validateScalingTiers(tiers: ScalingTier[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(tiers) || tiers.length === 0) return ['No tiers defined'];

  const sorted = [...tiers].sort((a, b) => a.minProfit - b.minProfit);

  if (sorted[0].minProfit !== 0) {
    problems.push(`Lowest tier starts at $${sorted[0].minProfit}, not $0 — profits below it are unmapped`);
  }

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const next = sorted[i + 1];

    if (t.maxProfit !== null && t.maxProfit < t.minProfit) {
      problems.push(`Level ${t.level}: max $${t.maxProfit} is below min $${t.minProfit}`);
    }
    if (t.maxContracts <= 0) problems.push(`Level ${t.level}: maxContracts must be positive`);
    if (t.dailyLossCap <= 0) problems.push(`Level ${t.level}: dailyLossCap must be positive`);

    if (next) {
      if (t.maxProfit === null) {
        problems.push(`Level ${t.level} is open-ended but is not the highest tier`);
      } else if (next.minProfit <= t.maxProfit) {
        problems.push(
          `Levels ${t.level} and ${next.level} overlap: $${next.minProfit} falls in both ` +
          `(level ${t.level} ends at $${t.maxProfit})`
        );
      } else if (next.minProfit > t.maxProfit + 1) {
        problems.push(
          `Gap between level ${t.level} (ends $${t.maxProfit}) and level ${next.level} ` +
          `(starts $${next.minProfit}) — profits in between are unmapped`
        );
      }
    } else if (t.maxProfit !== null) {
      problems.push(`Highest tier (level ${t.level}) should be open-ended, but caps at $${t.maxProfit}`);
    }
  }

  return problems;
}

/**
 * Apex EOD Performance Account tiers, in MICRO contracts.
 *
 * Apex publishes these in minis; 1 mini = 10 micros, and the account pages
 * confirm the pairing (50K PA "4 mini / 40 micro"). Stored in micros because
 * that is the unit the sizing path works in.
 *
 * The 50K top tier starts at $6,000 rather than the scaling page's "$5,999 &
 * Up", which overlaps the tier below it. The daily-loss-limit page states
 * "$6,000 & Up" for the same tier, so that is the coherent reading — and the
 * conservative one, since it keeps the lower DLL for one more dollar.
 */
export const APEX_EOD_PA_TIERS: Record<number, ScalingTier[]> = {
  25000: [
    { level: 1, minProfit: 0, maxProfit: 999, maxContracts: 10, dailyLossCap: 500 },
    { level: 2, minProfit: 1000, maxProfit: 1999, maxContracts: 20, dailyLossCap: 500 },
    { level: 3, minProfit: 2000, maxProfit: null, maxContracts: 20, dailyLossCap: 1250 },
  ],
  50000: [
    { level: 1, minProfit: 0, maxProfit: 1499, maxContracts: 20, dailyLossCap: 1000 },
    { level: 2, minProfit: 1500, maxProfit: 2999, maxContracts: 30, dailyLossCap: 1000 },
    { level: 3, minProfit: 3000, maxProfit: 5999, maxContracts: 40, dailyLossCap: 2000 },
    { level: 4, minProfit: 6000, maxProfit: null, maxContracts: 40, dailyLossCap: 3000 },
  ],
  100000: [
    { level: 1, minProfit: 0, maxProfit: 1999, maxContracts: 30, dailyLossCap: 1750 },
    { level: 2, minProfit: 2000, maxProfit: 2999, maxContracts: 40, dailyLossCap: 1750 },
    { level: 3, minProfit: 3000, maxProfit: 4999, maxContracts: 50, dailyLossCap: 1750 },
    { level: 4, minProfit: 5000, maxProfit: 9999, maxContracts: 60, dailyLossCap: 2500 },
    { level: 5, minProfit: 10000, maxProfit: null, maxContracts: 60, dailyLossCap: 3500 },
  ],
  150000: [
    { level: 1, minProfit: 0, maxProfit: 1999, maxContracts: 40, dailyLossCap: 2500 },
    { level: 2, minProfit: 2000, maxProfit: 2999, maxContracts: 50, dailyLossCap: 2500 },
    { level: 3, minProfit: 3000, maxProfit: 4999, maxContracts: 70, dailyLossCap: 2500 },
    { level: 4, minProfit: 5000, maxProfit: 9999, maxContracts: 100, dailyLossCap: 3000 },
    { level: 5, minProfit: 10000, maxProfit: null, maxContracts: 100, dailyLossCap: 4000 },
  ],
};
