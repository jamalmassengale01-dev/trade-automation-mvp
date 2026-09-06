/**
 * GB LIVE / PickMyTrade-style payload → internal TradingView alert.
 *
 * Incoming (from the GB LIVE Pine Script):
 * {
 *   "strategy_name": "GB LIVE", "symbol": "MNQ1!", "date": "2026-09-15T10:14:00Z",
 *   "data": "buy", "quantity": 4, "price": "29526.50", "gtd_in_second": 120, "order_type": "MKT",
 *   "advance_tp_sl": [ { "quantity": 2, "dollar_tp": 417.5, "dollar_sl": 334, "breakeven": 208.75 }, ... ],
 *   "multiple_accounts": [...]            // ignored: routing is by copier mappings
 * }
 *
 * Output: the shape validated by ./schema.ts, with the bracket details in metadata.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { getInstrument, dollarsToPoints, roundToTick } from '../strategy/instruments';

const numberish = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be numeric' });
    return z.NEVER;
  }
  return n;
});

const legSchema = z.object({
  quantity: numberish.pipe(z.number().int().nonnegative()),
  dollar_tp: numberish.pipe(z.number().nonnegative()).optional(),
  dollar_sl: numberish.pipe(z.number().positive()),
  breakeven: numberish.pipe(z.number().nonnegative()).optional(),
});

export const gbLivePayloadSchema = z
  .object({
    strategy_name: z.string().min(1).max(255),
    symbol: z.string().min(1).max(50),
    date: z.string().optional(),
    data: z.enum(['buy', 'sell', 'close']),
    quantity: numberish.pipe(z.number().int().nonnegative()).optional(),
    price: numberish.optional(),
    gtd_in_second: numberish.pipe(z.number().int().positive()).optional(),
    order_type: z.string().optional(),
    advance_tp_sl: z.array(legSchema).optional(),
    reverse_order_close: z.boolean().optional(),
    multiple_accounts: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type GbLivePayload = z.infer<typeof gbLivePayloadSchema>;

export interface BracketLeg {
  quantity: number;
  dollarTp?: number;
  dollarSl: number;
  breakeven?: number;
}

export interface BracketMeta {
  legs: BracketLeg[];
  /** Stop distance in price points, derived from the first leg's dollar_sl and the instrument. */
  stopPts?: number;
  /** TP1 / TP2 distances in points if derivable (informational; presets drive execution). */
  tp1Pts?: number;
  tp2Pts?: number;
}

export interface GbLiveMeta {
  source: 'gb_live';
  orderType: string;
  gtdSeconds: number;
  reverseOrderClose: boolean;
  bracket?: BracketMeta;
}

/** True when the body looks like a GB LIVE / PMT payload rather than the internal schema. */
export function isGbLivePayload(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b.data === 'string' && !('action' in b);
}

/** Deterministic alert id so TradingView retries / duplicate fires dedupe at the DB. */
export function gbAlertId(p: Pick<GbLivePayload, 'strategy_name' | 'symbol' | 'date' | 'data'>, fallbackTs: number): string {
  const when = p.date ?? new Date(Math.floor(fallbackTs / 60_000) * 60_000).toISOString();
  return crypto.createHash('sha256').update(`${p.strategy_name}|${p.symbol}|${when}|${p.data}`).digest('hex').slice(0, 32);
}

export interface NormalizeResult {
  success: boolean;
  alert?: Record<string, unknown>;
  error?: string;
}

export function normalizeGbLive(body: unknown, now: number = Date.now()): NormalizeResult {
  const parsed = gbLivePayloadSchema.safeParse(body);
  if (!parsed.success) {
    const errors = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return { success: false, error: errors };
  }
  const p = parsed.data;

  const parsedTs = p.date ? Date.parse(p.date) : NaN;
  const timestamp = Number.isFinite(parsedTs) ? parsedTs : now;

  const meta: GbLiveMeta = {
    source: 'gb_live',
    orderType: (p.order_type ?? 'MKT').toUpperCase(),
    gtdSeconds: p.gtd_in_second ?? 120,
    reverseOrderClose: p.reverse_order_close ?? false,
  };

  if (p.data !== 'close' && p.advance_tp_sl && p.advance_tp_sl.length > 0) {
    const legs: BracketLeg[] = p.advance_tp_sl.map((l) => ({
      quantity: l.quantity,
      dollarTp: l.dollar_tp,
      dollarSl: l.dollar_sl,
      breakeven: l.breakeven,
    }));
    const bracket: BracketMeta = { legs };

    const spec = getInstrument(p.symbol);
    const ref = legs.find((l) => l.quantity > 0);
    if (spec && ref) {
      bracket.stopPts = roundToTick(dollarsToPoints(ref.dollarSl, ref.quantity, spec), spec.tickSize);
      const withTp = legs.filter((l) => l.quantity > 0 && l.dollarTp !== undefined);
      if (withTp[0]) bracket.tp1Pts = roundToTick(dollarsToPoints(withTp[0].dollarTp!, withTp[0].quantity, spec), spec.tickSize);
      if (withTp[1]) bracket.tp2Pts = roundToTick(dollarsToPoints(withTp[1].dollarTp!, withTp[1].quantity, spec), spec.tickSize);
    }
    meta.bracket = bracket;
  }

  const alert: Record<string, unknown> = {
    id: gbAlertId(p, now),
    timestamp,
    strategy: p.strategy_name,
    symbol: p.symbol,
    action: p.data,
    metadata: meta,
  };
  if (p.quantity && p.quantity > 0) alert.contracts = p.quantity;
  if (p.price !== undefined && p.price > 0) alert.price = p.price;

  return { success: true, alert };
}

/**
 * Entry point for the webhook handlers: returns a body in the internal shape,
 * converting GB LIVE payloads and passing anything else through untouched.
 */
export function normalizeIncomingAlert(body: unknown): NormalizeResult {
  if (isGbLivePayload(body)) return normalizeGbLive(body);
  return { success: true, alert: body as Record<string, unknown> };
}
