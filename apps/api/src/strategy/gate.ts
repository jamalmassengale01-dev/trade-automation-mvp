import type { Session } from './sessions';

export interface AccountDayState {
  ladderStep: number;
  dayRealizedPnl: number;
  lastDayKey: string | null;
  tradesToday: number;
  londonUsed: boolean;
  nyamUsed: boolean;
  nypmUsed: boolean;
}

export interface GatePreset {
  dailyLossCap: number;
  maxTradesPerDay?: number;
}

export type GateReason =
  | 'outside_session'
  | 'session_used'
  | 'max_trades_day'
  | 'dll_headroom'
  | 'stale_signal';

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
    },
  };
}

export function sessionUsed(state: AccountDayState, session: Session): boolean {
  return session === 'london' ? state.londonUsed : session === 'nyam' ? state.nyamUsed : state.nypmUsed;
}

/** Remaining room before the daily loss cap is hit. */
export function dllHeadroom(dailyLossCap: number, dayRealizedPnl: number): number {
  return Number((dailyLossCap + dayRealizedPnl).toFixed(2));
}

/**
 * Pre-trade gate. Order matters: cheapest / most common rejections first.
 */
export function checkGate(input: {
  state: AccountDayState;
  preset: GatePreset;
  session: Session | null;
  stepRisk: number;
}): GateResult {
  const { state, preset, session, stepRisk } = input;
  const maxTrades = preset.maxTradesPerDay ?? 3;

  if (!session) {
    return { allowed: false, reason: 'outside_session', message: 'Signal outside London / NY AM / NY PM windows' };
  }
  if (sessionUsed(state, session)) {
    return { allowed: false, reason: 'session_used', message: `${session} session already traded today`, details: { session } };
  }
  if (state.tradesToday >= maxTrades) {
    return { allowed: false, reason: 'max_trades_day', message: `Max ${maxTrades} trades/day reached`, details: { tradesToday: state.tradesToday } };
  }
  const room = dllHeadroom(preset.dailyLossCap, state.dayRealizedPnl);
  if (stepRisk > room) {
    return {
      allowed: false,
      reason: 'dll_headroom',
      message: `Step risk $${stepRisk} exceeds remaining DLL room $${room}`,
      details: { stepRisk, room, dayRealizedPnl: state.dayRealizedPnl, dailyLossCap: preset.dailyLossCap },
    };
  }
  return { allowed: true };
}
