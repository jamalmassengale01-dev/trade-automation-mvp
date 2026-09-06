import { roundToTick } from './instruments';

export type Direction = 'long' | 'short';

/**
 * contracts = floor(stepRisk / (stopPts × pointValue)), capped at maxContracts.
 */
export function contractsFor(
  stepRisk: number,
  stopPts: number,
  pointValue: number,
  maxContracts: number
): number {
  if (stepRisk <= 0 || stopPts <= 0 || pointValue <= 0) return 0;
  const raw = Math.floor(stepRisk / (stopPts * pointValue));
  return Math.max(0, Math.min(raw, Math.max(0, Math.floor(maxContracts))));
}

/**
 * Group 1 = floor(half) closes at TP1; Group 2 = remainder runs to TP2.
 * Single contract → all of it runs as Group 2.
 */
export function splitGroups(contracts: number): { g1: number; g2: number } {
  const c = Math.max(0, Math.floor(contracts));
  if (c === 0) return { g1: 0, g2: 0 };
  if (c === 1) return { g1: 0, g2: 1 };
  const g1 = Math.floor(c / 2);
  return { g1, g2: c - g1 };
}

export interface BracketLevels {
  sl: number;
  tp1: number;
  tp2: number;
  be: number; // Group 2 stop after TP1 fills: 1 tick against entry
}

export function computeLevels(input: {
  entry: number;
  direction: Direction;
  stopPts: number;
  tickSize: number;
  tp1R?: number;
  tp2R?: number;
}): BracketLevels {
  const { entry, direction, stopPts, tickSize } = input;
  const tp1R = input.tp1R ?? 0.5;
  const tp2R = input.tp2R ?? 2.0;
  const sign = direction === 'long' ? 1 : -1;

  return {
    sl:  roundToTick(entry - sign * stopPts, tickSize),
    tp1: roundToTick(entry + sign * stopPts * tp1R, tickSize),
    tp2: roundToTick(entry + sign * stopPts * tp2R, tickSize),
    be:  roundToTick(entry - sign * tickSize, tickSize),
  };
}

/** Realized P&L in dollars for a set of exit fills against an entry price. */
export function realizedPnl(input: {
  direction: Direction;
  entry: number;
  exits: Array<{ qty: number; price: number }>;
  pointValue: number;
}): number {
  const sign = input.direction === 'long' ? 1 : -1;
  const total = input.exits.reduce(
    (sum, f) => sum + sign * (f.price - input.entry) * f.qty * input.pointValue,
    0
  );
  return Number(total.toFixed(2));
}

/** Quantity-weighted average price. */
export function avgPrice(fills: Array<{ qty: number; price: number }>): number {
  const qty = fills.reduce((s, f) => s + f.qty, 0);
  if (qty === 0) return 0;
  return fills.reduce((s, f) => s + f.qty * f.price, 0) / qty;
}
