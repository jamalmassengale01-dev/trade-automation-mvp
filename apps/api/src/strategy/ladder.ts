/**
 * GB LIVE risk ladder.
 *
 *   Step 1: 1× base   Step 2: 1× base   Step 3: 2× base   Step 4: 3× base
 *   Any win (full or partial) → reset to Step 1
 *   Loss → advance one step, capped at capStep (default 3)
 *   Breakeven scratch → hold step
 */
export const LADDER_MULTIPLIERS = [1, 1, 2, 3] as const;
export const MAX_STEP = LADDER_MULTIPLIERS.length;

export type TradeOutcome = 'W' | 'W~' | 'L' | 'BE' | 'L!';

export function clampStep(step: number, capStep = 3): number {
  const cap = Math.min(Math.max(1, capStep), MAX_STEP);
  return Math.min(Math.max(1, Math.floor(step)), cap);
}

export function stepRisk(baseRisk: number, step: number, capStep = 3): number {
  const s = clampStep(step, capStep);
  return Number((baseRisk * LADDER_MULTIPLIERS[s - 1]).toFixed(2));
}

export function nextStep(current: number, outcome: TradeOutcome, capStep = 3): number {
  switch (outcome) {
    case 'W':
    case 'W~':
      return 1;
    case 'L':
    case 'L!':
      return clampStep(current + 1, capStep);
    case 'BE':
    default:
      return clampStep(current, capStep);
  }
}

/**
 * Classify a closed trade.
 *   W  — both groups reached their targets (or single-group trade hit TP)
 *   W~ — partial: TP1 hit, remainder exited ≥ breakeven, or any other net-positive close
 *   BE — net ≈ 0
 *   L  — net negative
 *   L! — net negative AND the day breached the daily loss cap (caller decides)
 */
export function classifyOutcome(input: {
  pnl: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  breachedDll?: boolean;
  epsilon?: number;
}): TradeOutcome {
  const eps = input.epsilon ?? 1; // $1 tolerance for "flat"
  if (input.pnl < -eps) return input.breachedDll ? 'L!' : 'L';
  if (input.tp2Hit) return 'W';
  if (Math.abs(input.pnl) <= eps) return 'BE';
  return 'W~';
}
