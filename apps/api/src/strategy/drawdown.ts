/**
 * Trailing drawdown floor.
 *
 * The floor is the balance at which the account is dead. On a static account
 * it never moves. On an Apex EOD-trailing account it ratchets UP behind every
 * new end-of-day high and then locks permanently once it reaches
 * `startBalance + lockBuffer` — which is why a 50K account's floor stops at
 * $50,100 and the "safety net" balance is $52,100.
 *
 * Treating that floor as static, as the reconciler previously did, is not a
 * conservative simplification — it is wrong in the dangerous direction. An
 * account that reached $51,000 at an end of day has a real floor of $49,000,
 * not $48,000. A static model believes there is $3,000 of room where there is
 * $2,000, and will happily authorise the trade that ends the account.
 *
 * The floor here is DERIVED from the recorded daily P&L rather than stored and
 * incremented. Stored state drifts: a missed rollover, a crash at 6 PM, a
 * manual balance correction, and the number is silently wrong forever with
 * nothing to compare it against. A derived floor is recomputed from evidence
 * every time and repairs itself. The cost is that it can only see history the
 * system actually recorded, so `historyComplete` says whether it did — an
 * account with missing profitable days computes a floor that is too LOW, which
 * again errs toward believing in room that is not there. That case warns.
 */

export type DdMode = 'eod_trailing' | 'intraday_trailing' | 'static_fixed';

export interface DrawdownInput {
  ddMode: DdMode;
  startBalance: number;
  maxDrawdown: number;
  /**
   * How far above the starting balance the floor may climb before it locks
   * forever. Apex uses $100. `null` means the floor never stops trailing.
   */
  lockBuffer: number | null;
  /**
   * End-of-day account balances, oldest first, one per completed broker day.
   * For `intraday_trailing` these must be intraday PEAK balances instead —
   * that mode trails the running high, not the close.
   */
  eodBalances: number[];
  /** Live equity, used for the room calculation. */
  currentEquity: number;
  /**
   * False when recorded history does not cover the account's whole life. The
   * floor may then be understated.
   */
  historyComplete?: boolean;
}

export interface DrawdownState {
  /** Balance at which the account is dead. */
  floor: number;
  /** True once the floor has stopped trailing for good. */
  locked: boolean;
  /** currentEquity - floor. Negative means the account is already breached. */
  room: number;
  /** The high-water balance that set the current floor. */
  highWater: number;
  /**
   * Balance the account must close a day at for the floor to lock.
   * null when the rules have no lock.
   */
  lockAtBalance: number | null;
  /** True when the floor may be understated because history is incomplete. */
  understated: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Current drawdown floor and remaining room.
 *
 * Pure. Feed it history; it holds nothing.
 */
export function drawdownState(input: DrawdownInput): DrawdownState {
  const { ddMode, startBalance, maxDrawdown, lockBuffer, eodBalances, currentEquity } = input;

  if (!Number.isFinite(startBalance) || !Number.isFinite(maxDrawdown) || maxDrawdown <= 0) {
    throw new Error('drawdownState requires a finite startBalance and a positive maxDrawdown');
  }

  const initialFloor = round2(startBalance - maxDrawdown);
  const lockAtFloor = lockBuffer === null ? null : round2(startBalance + lockBuffer);
  const lockAtBalance = lockAtFloor === null ? null : round2(lockAtFloor + maxDrawdown);

  // A static account's floor is the floor, whatever it earns.
  if (ddMode === 'static_fixed') {
    return {
      floor: initialFloor,
      locked: true,
      room: round2(currentEquity - initialFloor),
      highWater: startBalance,
      lockAtBalance: null,
      understated: false,
    };
  }

  // The floor trails the high-water balance and only ever moves up. The
  // starting balance counts as the first high-water mark: a day-one loss must
  // not drag the floor below where it began.
  const highWater = eodBalances.reduce((hi, b) => (Number.isFinite(b) && b > hi ? b : hi), startBalance);

  let floor = round2(Math.max(initialFloor, highWater - maxDrawdown));
  let locked = false;
  if (lockAtFloor !== null && floor >= lockAtFloor) {
    floor = lockAtFloor;
    locked = true;
  }

  return {
    floor,
    locked,
    room: round2(currentEquity - floor),
    highWater: round2(highWater),
    lockAtBalance,
    // A locked floor cannot be understated — it is already at its maximum, so
    // missing history could not raise it further.
    understated: input.historyComplete === false && !locked,
  };
}

/**
 * Rebuild the end-of-day balance series from per-day realized P&L.
 *
 * `dailyPnl` must be ordered oldest-first and contain one entry per recorded
 * broker day. Days the account did not trade may be omitted: a flat day cannot
 * set a new high-water mark, so skipping it changes nothing.
 */
export function eodBalancesFromDailyPnl(startBalance: number, dailyPnl: number[]): number[] {
  const out: number[] = [];
  let balance = startBalance;
  for (const pnl of dailyPnl) {
    balance = round2(balance + (Number.isFinite(pnl) ? pnl : 0));
    out.push(balance);
  }
  return out;
}

export interface DrawdownGate {
  allowed: boolean;
  /** Room left after the proposed risk, if it were taken and lost in full. */
  roomAfter: number;
  reason?: string;
}

/**
 * Would risking `stepRisk` breach the drawdown floor?
 *
 * This is a HARDER limit than the daily loss cap. Breaching the daily cap
 * costs a trading day; breaching the drawdown floor ends the account
 * permanently, and no ladder step is worth that. It is checked with the same
 * buffer semantics as the DLL gate so the two read alike at the call site.
 */
export function drawdownHeadroom(
  state: DrawdownState,
  stepRisk: number,
  bufferPct = 0
): DrawdownGate {
  const pct = Math.min(Math.max(bufferPct, 0), 100);
  const effectiveRoom = round2(state.room * (1 - pct / 100));
  const roomAfter = round2(effectiveRoom - stepRisk);

  if (state.room <= 0) {
    return {
      allowed: false,
      roomAfter,
      reason: `Account is at or below its drawdown floor ($${state.floor}) — no room at all`,
    };
  }
  if (roomAfter < 0) {
    return {
      allowed: false,
      roomAfter,
      reason:
        `Step risk $${round2(stepRisk)} exceeds the $${effectiveRoom} of drawdown room above the ` +
        `$${state.floor} floor${pct > 0 ? ` (after a ${pct}% buffer)` : ''}. ` +
        'Losing this trade would end the account, not just the day.',
    };
  }
  return { allowed: true, roomAfter };
}
