/**
 * Futures instrument specs.
 *
 * pointValue = dollars per 1.00 move in price per contract.
 * tickSize   = minimum price increment.
 * MNQ: tick 0.25 = $0.50, so 1 point = $2.00.
 */
export interface InstrumentSpec {
  root: string;
  name: string;
  tickSize: number;
  pointValue: number;
}

const SPECS: Record<string, InstrumentSpec> = {
  MNQ: { root: 'MNQ', name: 'Micro E-mini Nasdaq-100', tickSize: 0.25, pointValue: 2 },
  NQ:  { root: 'NQ',  name: 'E-mini Nasdaq-100',       tickSize: 0.25, pointValue: 20 },
  MES: { root: 'MES', name: 'Micro E-mini S&P 500',    tickSize: 0.25, pointValue: 5 },
  ES:  { root: 'ES',  name: 'E-mini S&P 500',          tickSize: 0.25, pointValue: 50 },
  MYM: { root: 'MYM', name: 'Micro E-mini Dow',        tickSize: 1,    pointValue: 0.5 },
  YM:  { root: 'YM',  name: 'E-mini Dow',              tickSize: 1,    pointValue: 5 },
  M2K: { root: 'M2K', name: 'Micro E-mini Russell',    tickSize: 0.1,  pointValue: 0.5 },
  RTY: { root: 'RTY', name: 'E-mini Russell 2000',     tickSize: 0.1,  pointValue: 5 },
  MCL: { root: 'MCL', name: 'Micro Crude Oil',         tickSize: 0.01, pointValue: 10 },
  CL:  { root: 'CL',  name: 'Crude Oil',               tickSize: 0.01, pointValue: 1000 },
  MGC: { root: 'MGC', name: 'Micro Gold',              tickSize: 0.1,  pointValue: 1 },
  GC:  { root: 'GC',  name: 'Gold',                    tickSize: 0.1,  pointValue: 10 },
};

const MONTH_CODE_RE = /^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/;

/**
 * Extract the product root from any symbol form:
 *   MNQ1! → MNQ   (TradingView continuous)
 *   MNQM6 → MNQ   (Tradovate contract)
 *   MNQ   → MNQ
 */
export function rootSymbol(symbol: string): string {
  let s = symbol.trim().toUpperCase();
  if (s.endsWith('1!')) return s.slice(0, -2);
  if (s.endsWith('!')) s = s.replace(/\d*!$/, '');
  const m = MONTH_CODE_RE.exec(s);
  if (m && SPECS[m[1]]) return m[1];
  return s;
}

export function getInstrument(symbol: string): InstrumentSpec | null {
  return SPECS[rootSymbol(symbol)] ?? null;
}

export function requireInstrument(symbol: string): InstrumentSpec {
  const spec = getInstrument(symbol);
  if (!spec) throw new Error(`Unknown instrument for symbol ${symbol}`);
  return spec;
}

/** Round a price to the nearest tick, avoiding float drift (e.g. 29526.499999 → 29526.5). */
export function roundToTick(price: number, tickSize: number): number {
  const decimals = Math.max(0, (tickSize.toString().split('.')[1] ?? '').length);
  return Number((Math.round(price / tickSize) * tickSize).toFixed(decimals));
}

/** Convert a dollar amount to price points for a given qty of an instrument. */
export function dollarsToPoints(dollars: number, qty: number, spec: InstrumentSpec): number {
  if (qty <= 0) return 0;
  return dollars / (qty * spec.pointValue);
}
