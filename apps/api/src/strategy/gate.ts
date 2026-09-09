import type { Session } from './sessions';
import { drawdownHeadroom, type DrawdownState } from './drawdown';

export interface AccountDayState {
  ladderStep: number;
  dayRealizedPnl: number;
  lastDayKey: string | null;
  tradesToday: number;
  londonUsed: boolean;
  nyamUsed: boolean;
  nypmUsed: boolean;
  /** Set by a Step-N loss at the preset's cap step; blocks entries for the rest of the broker day. */
  dayLockedOut: boolean;
}

export interface GatePreset {
  dailyLossCap: number;
  maxTradesPerDay?: number;
  /** Percent of the daily loss cap held back for commissions and slippage. */
  dllBufferPct?: number;
}

export type GateReason =
  | 'outside_session'
  | 'session_used'
  | 'max_trades_day'
  | 'dll_headroom'
  | 'drawdown_headroom'
  | 'stale_signal'
  | 'day_locked_out'
  | 'trade_already_open'
  | 'sniper_session'
  | 'sniper_max_trades_day';

export interface GateResult {
  allowed: boolean;
  reason?: GateReason;
  message?: string;
  details?: Record<string, unknown>;
}

/** Reset per-day counters when the broker day has rolled. Returns a new state and whether it reset. */
export function resetIfNewDay(state: AccountDayState, todayKey: string): { state: AccountDayState; reset: boolean } {
  if (state.lastDayKey === todayKey) return { state, reset: false };
  return {
    reset: true,
    state: {
      ...state,
      lastDayKey: todayKey,
      dayRealizedPnl: 0,
      tradesToday: 0,
      londonUsed: false,
      nyamUsed: false,
      nypmUsed: false,
      dayLockedOut: false,
    },
  };
}

export function sessionUsed(state: AccountDayState, session: Session): boolean {
  return session === 'london' ? state.londonUsed : session === 'nyam' ? state.nyamUsed : state.nypmUsed;
}

/**
 * Remaining room before the daily loss cap is hit.
 *
 * `bufferPct` shaves a margin off the cap before the comparison. The firm
 * measures its daily loss limit on total equity INCLUDING unrealized, while
 * this figure is realized-only — which is almost equivalent here, because the
 * account holds one trade at a time and that trade's worst case is bounded by
 * the step risk the gate just approved. What the model does not count is
 * commissions and slippage: a stop is a price, not a promise, so actual loss
 * runs slightly above planned loss.
 *
 * Without a buffer the margin for that is exactly zero, and the cost of
 * overshooting is that the FIRM flattens the account at market instead of the
 * stop filling where it was placed.
 *
 * Sizing note for the Apex 50K ladder: buffers up to ~$336 decline no trade
 * that currently happens, because step 3 ($668) is already unreachable once
 * two losses have consumed the day. 10% ($100) is comfortably inside that.
 */
export function dllHeadroom(
  dailyLossCap: number,
  dayRealizedPnl: number,
  bufferPct = 0
): number {
  const pct = Math.min(Math.max(bufferPct, 0), 100);
  const effectiveCap = dailyLossCap * (1 - pct / 100);
  return Number((effectiveCap + dayRealizedPnl).toFixed(2));
}

/**
 * Pre-trade gate for a normal (ladder) trade. Order matters: cheapest / most
 * common rejections first. Callers should check "already has an open trade"
 * separately (that check needs a DB query, so it isn't a pure function here).
 */
export function checkGate(input: {
  state: AccountDayState;
  preset: GatePreset;
  session: Session | null;
  stepRisk: number;
  /** Current drawdown floor and room. Omit when unknown — the gate then skips
   *  the drawdown check rather than guessing at a floor. */
  drawdown?: DrawdownState;
}): GateResult {
  const { state, preset, session, stepRisk } = input;
  const maxTrades = preset.maxTradesPerDay ?? 3;

  if (state.dayLockedOut) {
    return { allowed: false, reason: 'day_locked_out', message: 'Day locked out after a max-step loss' };
  }
  if (!session) {
    return { allowed: false, reason: 'outside_session', message: 'Signal outside London / NY AM / NY PM windows' };
  }
  if (sessionUsed(state, session)) {
    return { allowed: false, reason: 'session_used', message: `${session} session already traded today`, details: { session } };
  }
  if (state.tradesToday >= maxTrades) {
    return { allowed: false, reason: 'max_trades_day', message: `Max ${maxTrades} trades/day reached`, details: { tradesToday: state.tradesToday } };
  }
  const room = dllHeadroom(preset.dailyLossCap, state.dayRealizedPnl, preset.dllBufferPct ?? 0);
  if (stepRisk > room) {
    return {
      allowed: false,
      reason: 'dll_headroom',
      message: `Step risk $${stepRisk} exceeds remaining DLL room $${room}`,
      details: {
        stepRisk, room, dayRealizedPnl: state.dayRealizedPnl,
        dailyLossCap: preset.dailyLossCap, bufferPct: preset.dllBufferPct ?? 0,
      },
    };
  }

  // Drawdown last, and separate from the DLL, because the two failures are not
  // equivalent. Breaching the daily cap costs a day. Breaching the drawdown
  // floor ends the account, and on a trailing floor there are states where the
  // drawdown room is SMALLER than the daily room — a profitable account that
  // has given some back is exactly that case. Checked only when the caller
  // supplies drawdown state, so accounts without recorded history behave as
  // before rather than being blocked by an absence of data.
  if (input.drawdown) {
    const dd = drawdownHeadroom(input.drawdown, stepRisk, preset.dllBufferPct ?? 0);
    if (!dd.allowed) {
      return {
        allowed: false,
        reason: 'drawdown_headroom',
        message: dd.reason ?? 'Step risk exceeds remaining drawdown room',
        details: {
          stepRisk, floor: input.drawdown.floor, room: input.drawdown.room,
          roomAfter: dd.roomAfter, bufferPct: preset.dllBufferPct ?? 0,
        },
      };
    }
  }

  return { allowed: true };
}

// ============================================
// SNIPER MODE
// ============================================
// Sniper Mode is a per-ACCOUNT property, not a per-signal one: the same alert
// fans out to many accounts, each with its own progress toward its own target.
// The script never decides Sniper Mode — the server evaluates it independently
// for every mapped account from that account's own cumulative P&L.

export interface SniperPreset {
  targetProfit: number | null;
  passZoneBuffer: number;
  dailyLossCap: number;
  sniperRiskPct: number;
  sniperMaxTradesDay: number;
}

/** Dollars still needed to reach the preset's target. Null target (e.g. some funded modes) => never eligible. */
export function remainingTarget(targetProfit: number | null, cumulativePnl: number): number {
  if (targetProfit === null) return Infinity;
  return Math.max(targetProfit - cumulativePnl, 0);
}

/** True once progress is within the pass-zone buffer of the target (and not already there). */
export function isSniperEligible(remaining: number, passZoneBuffer: number): boolean {
  return passZoneBuffer > 0 && remaining > 0 && remaining <= passZoneBuffer;
}

/** Sniper risk: a fraction of what's left to hit target, capped at the daily loss cap. */
export function sniperRisk(remaining: number, sniperRiskPct: number, dailyLossCap: number): number {
  return Number(Math.min(remaining * (sniperRiskPct / 100), dailyLossCap).toFixed(2));
}

const SNIPER_SESSIONS: ReadonlySet<Session> = new Set(['london', 'nyam']);

/** Sniper trades are restricted to London + NY AM (never NY PM), and a tighter daily count. */
export function checkSniperGate(input: {
  state: AccountDayState;
  preset: SniperPreset;
  session: Session | null;
  risk: number;
}): GateResult {
  const { state, preset, session, risk } = input;

  if (state.dayLockedOut) {
    return { allowed: false, reason: 'day_locked_out', message: 'Day locked out after a max-step loss' };
  }
  if (!session) {
    return { allowed: false, reason: 'outside_session', message: 'Signal outside London / NY AM / NY PM windows' };
  }
  if (!SNIPER_SESSIONS.has(session)) {
    return { allowed: false, reason: 'sniper_session', message: 'Sniper Mode trades only London and NY AM', details: { session } };
  }
  if (sessionUsed(state, session)) {
    return { allowed: false, reason: 'session_used', message: `${session} session already traded today`, details: { session } };
  }
  if (state.tradesToday >= preset.sniperMaxTradesDay) {
    return { allowed: false, reason: 'sniper_max_trades_day', message: `Sniper max ${preset.sniperMaxTradesDay} trades/day reached`, details: { tradesToday: state.tradesToday } };
  }
  const room = dllHeadroom(preset.dailyLossCap, state.dayRealizedPnl);
  if (risk > room) {
    return {
      allowed: false,
      reason: 'dll_headroom',
      message: `Sniper risk $${risk} exceeds remaining DLL room $${room}`,
      details: { risk, room, dayRealizedPnl: state.dayRealizedPnl, dailyLossCap: preset.dailyLossCap },
    };
  }
  return { allowed: true };
}
