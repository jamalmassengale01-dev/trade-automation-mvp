/**
 * GB LIVE risk ladder.
 *
 *   Step 1: 1x base   Step 2: step2Mult x base   Step 3: step3Mult x base   Step 4: step4Mult x base
 *   Any win (full or partial) -> reset to Step 1
 *   Loss -> advance one step, capped at capStep
 *   Breakeven scratch -> hold step
 *
 * Multipliers are per-preset, not a global constant: they depend on the preset's
 * TP R-multiple and daily loss cap (each step must fully recover prior losses in
 * one win). Apex EOD 2R presets use 1/1/2/4; some intraday presets use 1/2/3/3.
 * Always pass the preset's own multipliers — the defaults below are a fallback
 * only, matching the original Apex 50K EOD Eval preset.
 */
export const MAX_STEP = 4;

export interface StepMultipliers {
  step2: number;
  step3: number;
  step4: number;
}

export const DEFAULT_STEP_MULTIPLIERS: StepMultipliers = { step2: 1, step3: 2, step4: 4 };

export type TradeOutcome = 'W' | 'W~' | 'L' | 'BE' | 'L!';

export function clampStep(step: number, capStep = 3): number {
  const cap = Math.min(Math.max(1, capStep), MAX_STEP);
  return Math.min(Math.max(1, Math.floor(step)), cap);
}

function multiplierFor(step: number, multipliers: StepMultipliers): number {
  switch (step) {
    case 1: return 1;
    case 2: return multipliers.step2;
    case 3: return multipliers.step3;
    default: return multipliers.step4;
  }
}

export function stepRisk(
  baseRisk: number,
  step: number,
  opts?: { capStep?: number; multipliers?: StepMultipliers; dailyLossCap?: number }
): number {
  const capStep = opts?.capStep ?? 3;
  const multipliers = opts?.multipliers ?? DEFAULT_STEP_MULTIPLIERS;
  const s = clampStep(step, capStep);
  const raw = baseRisk * multiplierFor(s, multipliers);
  const capped = opts?.dailyLossCap !== undefined ? Math.min(raw, opts.dailyLossCap) : raw;
  return Number(capped.toFixed(2));
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
