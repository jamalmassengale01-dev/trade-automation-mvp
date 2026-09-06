/**
 * Bracket Manager — runs the GB LIVE trade lifecycle against a bracket-capable broker.
 *
 *   entry_pending ─(entries filled)─▶ open ─(TP1 fills, G2 stop → BE)─▶ tp1_hit ─▶ closed
 *                 └(no fill in GTD)─▶ failed                          closing ─▶ closed
 *
 * State lives in gb_trades, so a restart re-hydrates watchers from the DB.
 * Fills arrive via the broker's push stream; a REST poll runs alongside as a fallback.
 */
import { query } from '../db';
import { getBrokerAdapter } from '../brokers';
import { isBracketBroker, IBracketBroker, BrokerFill, OrderSide } from '../brokers/bracketInterface';
import { BrokerAccount } from '../types';
import { computeLevels, realizedPnl, avgPrice, Direction } from './sizing';
import { classifyOutcome, nextStep, TradeOutcome } from './ladder';
import { requireInstrument } from './instruments';
import { brokerDayKey, toDayKey, sessionFlagColumn, Session } from './sessions';
import { broadcaster } from '../services/wsbroadcaster';
import logger from '../utils/logger';

const log = logger.child({ context: 'BracketManager' });

export type FillRole = 'entry_g1' | 'entry_g2' | 'g1_tp' | 'g1_sl' | 'g2_tp' | 'g2_sl' | 'exit';

export interface FillRecord {
  orderId: string;
  fillId?: string;
  role: FillRole;
  qty: number;
  price: number;
  at: string;
}

export interface BrokerOrders {
  entry?: { g1?: string; g2?: string };
  g1?: { tp: string; sl: string };
  g2?: { tp: string; sl: string };
  exit?: string[];
}

export interface GbTradeRow {
  id: string;
  broker_account_id: string;
  trade_request_id: string | null;
  alert_id: string | null;
  day_key: string | Date;
  session: Session | null;
  direction: Direction;
  symbol: string;
  root_symbol: string;
  ref_price: string | number | null;
  entry_price: string | number | null;
  stop_pts: string | number;
  sl_price: string | number | null;
  tp1_price: string | number | null;
  tp2_price: string | number | null;
  be_price: string | number | null;
  contracts: number;
  g1_qty: number;
  g2_qty: number;
  step_at_entry: number;
  step_risk: string | number;
  gtd_seconds: number;
  state: 'entry_pending' | 'open' | 'tp1_hit' | 'closing' | 'closed' | 'failed';
  outcome: TradeOutcome | null;
  pnl: string | number | null;
  broker_orders: BrokerOrders;
  fills: FillRecord[];
  error_message: string | null;
  entry_time: Date | null;
  exit_time: Date | null;
}

type AccountRow = BrokerAccount & Record<string, any>;

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const EXIT_ROLES: FillRole[] = ['g1_tp', 'g1_sl', 'g2_tp', 'g2_sl', 'exit'];
const POLL_ENTRY_MS = 1000;
const POLL_EXIT_MS = 5000;

class BracketManager {
  private watchers = new Map<string, { unsub: () => void; poll: NodeJS.Timeout }>();
  private chains = new Map<string, Promise<void>>();

  // ------------------------------------------------------------------
  // Entry
  // ------------------------------------------------------------------

  /** Job entry point: place entries, wait for fills, place brackets, start watching. */
  async execute(tradeId: string): Promise<void> {
    const trade = await this.load(tradeId);
    if (!trade) throw new Error(`gb_trade ${tradeId} not found`);

    if (trade.state === 'open' || trade.state === 'tp1_hit') {
      await this.ensureWatching(trade);
      return;
    }
    if (trade.state !== 'entry_pending') return;

    const { account, broker } = await this.brokerFor(trade.broker_account_id);
    if (!broker) {
      await this.fail(trade, 'Broker does not support bracket execution');
      return;
    }

    // Resume path (restart mid-entry): entries already placed → don't place again
    if (trade.broker_orders.entry?.g1 || trade.broker_orders.entry?.g2) {
      await this.completeEntry(trade, account, broker);
      return;
    }

    const side: OrderSide = trade.direction === 'long' ? 'buy' : 'sell';
    const orders: BrokerOrders = { entry: {} };
    const refPrice = trade.ref_price !== null ? num(trade.ref_price) : undefined;

    try {
      if (trade.g1_qty > 0) {
        const { orderId } = await broker.placeMarketOrder(account, { symbol: trade.symbol, side, qty: trade.g1_qty, refPrice, clientId: `${trade.id}-g1` });
        orders.entry!.g1 = orderId;
        await this.saveOrders(trade.id, orders); // persist immediately to narrow the orphan window
      }
      if (trade.g2_qty > 0) {
        const { orderId } = await broker.placeMarketOrder(account, { symbol: trade.symbol, side, qty: trade.g2_qty, refPrice, clientId: `${trade.id}-g2` });
        orders.entry!.g2 = orderId;
        await this.saveOrders(trade.id, orders);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Entry placement failed', { tradeId, error: msg });
      // If one leg went in, we must still manage it
      if (orders.entry?.g1 || orders.entry?.g2) {
        trade.broker_orders = orders;
        await this.completeEntry(trade, account, broker, msg);
        return;
      }
      await this.fail(trade, `Entry placement failed: ${msg}`, true);
      return;
    }

    trade.broker_orders = orders;
    await this.completeEntry(trade, account, broker);
  }

  /** Wait for entry fills (GTD), compute levels from the real fill, place OCO brackets. */
  private async completeEntry(trade: GbTradeRow, account: AccountRow, broker: IBracketBroker, placementError?: string): Promise<void> {
    const gtdMs = Math.max(5, trade.gtd_seconds || 120) * 1000;
    const entry = trade.broker_orders.entry ?? {};
    const fills: FillRecord[] = [...(trade.fills ?? [])];

    const waits: Array<Promise<void>> = [];
    if (entry.g1) waits.push(this.awaitFill(broker, account, entry.g1, trade.g1_qty, gtdMs)
      .then((fs) => { for (const f of fs) fills.push({ ...f, role: 'entry_g1', at: f.at.toISOString() }); }));
    if (entry.g2) waits.push(this.awaitFill(broker, account, entry.g2, trade.g2_qty, gtdMs)
      .then((fs) => { for (const f of fs) fills.push({ ...f, role: 'entry_g2', at: f.at.toISOString() }); }));
    await Promise.all(waits);

    const g1Fills = fills.filter((f) => f.role === 'entry_g1');
    const g2Fills = fills.filter((f) => f.role === 'entry_g2');
    const g1 = g1Fills.reduce((s, f) => s + f.qty, 0);
    const g2 = g2Fills.reduce((s, f) => s + f.qty, 0);

    if (g1 + g2 === 0) {
      await this.fail(trade, placementError ? `Entry failed: ${placementError}` : 'Entry not filled within GTD window', true);
      return;
    }

    const inst = requireInstrument(trade.root_symbol);
    const preset = await this.presetFor(account);
    const entryPrice = avgPrice([...g1Fills, ...g2Fills]);
    const levels = computeLevels({
      entry: entryPrice,
      direction: trade.direction,
      stopPts: num(trade.stop_pts),
      tickSize: inst.tickSize,
      tp1R: preset?.tp1_r ?? 0.5,
      tp2R: preset?.tp2_r ?? 2.0,
    });
    const entryTime = new Date(Math.max(...fills.map((f) => Date.parse(f.at))));

    await query(
      `UPDATE gb_trades SET entry_price=$2, entry_time=$3, sl_price=$4, tp1_price=$5, tp2_price=$6, be_price=$7,
              contracts=$8, g1_qty=$9, g2_qty=$10, fills=$11 WHERE id=$1`,
      [trade.id, entryPrice, entryTime, levels.sl, levels.tp1, levels.tp2, levels.be, g1 + g2, g1, g2, JSON.stringify(fills)]
    );

    const exitSide: OrderSide = trade.direction === 'long' ? 'sell' : 'buy';
    const orders: BrokerOrders = { ...trade.broker_orders };
    try {
      if (g1 > 0) {
        const oco = await broker.placeOcoExit(account, { symbol: trade.symbol, side: exitSide, qty: g1, tpPrice: levels.tp1, slPrice: levels.sl });
        orders.g1 = { tp: oco.tpOrderId, sl: oco.slOrderId };
        await this.saveOrders(trade.id, orders);
      }
      if (g2 > 0) {
        const oco = await broker.placeOcoExit(account, { symbol: trade.symbol, side: exitSide, qty: g2, tpPrice: levels.tp2, slPrice: levels.sl });
        orders.g2 = { tp: oco.tpOrderId, sl: oco.slOrderId };
        await this.saveOrders(trade.id, orders);
      }
    } catch (err) {
      // Position is live without full protection → flatten immediately.
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Bracket placement failed — flattening', { tradeId: trade.id, error: msg });
      await query(`UPDATE gb_trades SET error_message=$2, broker_orders=$3 WHERE id=$1`, [trade.id, `Bracket placement failed: ${msg}`, JSON.stringify(orders)]);
      const fresh = await this.load(trade.id);
      if (fresh) await this.closeTrade(fresh, 'bracket_failure');
      return;
    }

    await query(`UPDATE gb_trades SET state='open', broker_orders=$2 WHERE id=$1`, [trade.id, JSON.stringify(orders)]);
    log.info('Trade open', { tradeId: trade.id, accountId: account.id, symbol: trade.symbol, direction: trade.direction, entry: entryPrice, contracts: g1 + g2, levels });

    broadcaster.broadcast('execution_filled', {
      tradeId: trade.id, accountId: account.id, accountName: account.name, symbol: trade.symbol,
      direction: trade.direction, entry: entryPrice, contracts: g1 + g2, ...levels, step: trade.step_at_entry,
    });

    const fresh = await this.load(trade.id);
    if (fresh) await this.ensureWatching(fresh);
  }

  /** Resolve with the order's fills once fully filled; partial fills on timeout/cancel are returned as-is. */
  private awaitFill(broker: IBracketBroker, account: AccountRow, orderId: string, expectedQty: number, timeoutMs: number): Promise<BrokerFill[]> {
    return new Promise<BrokerFill[]>((resolve) => {
      const collected = new Map<string, BrokerFill>();
      let done = false;
      let unsub: (() => void) | undefined;
      let poll: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;

      const total = () => [...collected.values()].reduce((s, f) => s + f.qty, 0);
      const finish = (fills: BrokerFill[]) => {
        if (done) return;
        done = true;
        unsub?.();
        if (poll) clearInterval(poll);
        if (timer) clearTimeout(timer);
        resolve(fills);
      };
      const add = (f: BrokerFill) => {
        if (f.orderId !== orderId) return;
        collected.set(f.fillId ?? `${f.orderId}:${f.at.getTime()}:${f.price}:${f.qty}`, f);
        if (total() >= expectedQty) finish([...collected.values()]);
      };

      broker.subscribeFills(account, add).then((u) => { unsub = u; if (done) u(); }).catch(() => { /* poll covers */ });

      poll = setInterval(async () => {
        if (done) return;
        try {
          const state = await broker.getOrderState(account, orderId);
          if (state === 'filled' || state === 'partially_filled' || state === 'unknown') {
            const fills = await broker.getFillsForOrder(account, orderId).catch(() => [] as BrokerFill[]);
            for (const f of fills) add(f);
            if (state === 'filled' && fills.length > 0) finish([...collected.values()]);
          } else if (state === 'canceled' || state === 'rejected' || state === 'expired') {
            const fills = await broker.getFillsForOrder(account, orderId).catch(() => [] as BrokerFill[]);
            for (const f of fills) add(f);
            log.warn('Entry order ended without full fill', { orderId, state, filled: total() });
            finish([...collected.values()]);
          }
        } catch (err) {
          log.debug('awaitFill poll error', { orderId, error: String(err) });
        }
      }, POLL_ENTRY_MS);

      timer = setTimeout(async () => {
        if (done) return;
        log.warn('GTD expired — cancelling entry', { orderId, filled: total(), expectedQty });
        await broker.cancelOrder(account, orderId).catch(() => false);
        // A fill may have raced the cancel
        const fills = await broker.getFillsForOrder(account, orderId).catch(() => [] as BrokerFill[]);
        for (const f of fills) add(f);
        finish([...collected.values()]);
      }, timeoutMs);
    });
  }

  // ------------------------------------------------------------------
  // Exit watching
  // ------------------------------------------------------------------

  async ensureWatching(trade: GbTradeRow): Promise<void> {
    if (this.watchers.has(trade.id)) return;
    const { account, broker } = await this.brokerFor(trade.broker_account_id);
    if (!broker) return;

    const roleOf = (orderId: string): FillRole | null => {
      const o = trade.broker_orders;
      if (o.g1?.tp === orderId) return 'g1_tp';
      if (o.g1?.sl === orderId) return 'g1_sl';
      if (o.g2?.tp === orderId) return 'g2_tp';
      if (o.g2?.sl === orderId) return 'g2_sl';
      if (o.exit?.includes(orderId)) return 'exit';
      return null;
    };

    let unsub: () => void = () => {};
    try {
      unsub = await broker.subscribeFills(account, (f) => {
        const role = roleOf(f.orderId);
        if (role) void this.onExitFill(trade.id, role, f);
      });
    } catch (err) {
      log.warn('Fill subscription unavailable; relying on polling', { tradeId: trade.id, error: String(err) });
    }

    const poll = setInterval(() => { void this.reconcileExits(trade.id); }, POLL_EXIT_MS);
    this.watchers.set(trade.id, { unsub, poll });
    log.info('Watching trade exits', { tradeId: trade.id });
    void this.reconcileExits(trade.id);
  }

  private stopWatching(tradeId: string): void {
    const w = this.watchers.get(tradeId);
    if (!w) return;
    w.unsub();
    clearInterval(w.poll);
    this.watchers.delete(tradeId);
  }

  /** REST fallback: check exit orders for fills the stream may have missed. */
  private async reconcileExits(tradeId: string): Promise<void> {
    const trade = await this.load(tradeId);
    if (!trade || (trade.state !== 'open' && trade.state !== 'tp1_hit')) { this.stopWatching(tradeId); return; }
    const { account, broker } = await this.brokerFor(trade.broker_account_id);
    if (!broker) return;

    const candidates: Array<{ id: string; role: FillRole }> = [];
    if (trade.broker_orders.g1) candidates.push({ id: trade.broker_orders.g1.tp, role: 'g1_tp' }, { id: trade.broker_orders.g1.sl, role: 'g1_sl' });
    if (trade.broker_orders.g2) candidates.push({ id: trade.broker_orders.g2.tp, role: 'g2_tp' }, { id: trade.broker_orders.g2.sl, role: 'g2_sl' });
    for (const id of trade.broker_orders.exit ?? []) candidates.push({ id, role: 'exit' });

    const seen = new Set(trade.fills.map((f) => f.fillId ?? `${f.orderId}:${f.at}:${f.price}:${f.qty}`));
    for (const c of candidates) {
      const recorded = trade.fills.filter((f) => f.orderId === c.id).reduce((s, f) => s + f.qty, 0);
      const expected = c.role.startsWith('g1') ? trade.g1_qty : c.role.startsWith('g2') ? trade.g2_qty : Infinity;
      if (recorded >= expected) continue;
      try {
        const state = await broker.getOrderState(account, c.id);
        if (state === 'filled' || state === 'partially_filled') {
          const fills = await broker.getFillsForOrder(account, c.id);
          for (const f of fills) {
            const key = f.fillId ?? `${f.orderId}:${f.at.toISOString()}:${f.price}:${f.qty}`;
            if (!seen.has(key)) await this.onExitFill(trade.id, c.role, f);
          }
        }
      } catch (err) {
        log.debug('reconcileExits error', { tradeId, orderId: c.id, error: String(err) });
      }
    }
  }

  /** Serialized per trade so stream + poll can't double-apply a fill. */
  private onExitFill(tradeId: string, role: FillRole, fill: BrokerFill): Promise<void> {
    return this.serialized(tradeId, async () => {
      const trade = await this.load(tradeId);
      if (!trade || trade.state === 'closed' || trade.state === 'failed') return;

      const key = fill.fillId ?? `${fill.orderId}:${fill.at.toISOString()}:${fill.price}:${fill.qty}`;
      if (trade.fills.some((f) => (f.fillId ?? `${f.orderId}:${f.at}:${f.price}:${f.qty}`) === key)) return;

      const fills: FillRecord[] = [...trade.fills, { orderId: fill.orderId, fillId: fill.fillId, role, qty: fill.qty, price: fill.price, at: fill.at.toISOString() }];
      let state = trade.state;

      // TP1 filled → move Group 2 stop to breakeven
      if (role === 'g1_tp' && trade.state === 'open' && trade.broker_orders.g2 && trade.be_price !== null) {
        const { account, broker } = await this.brokerFor(trade.broker_account_id);
        if (broker) {
          try {
            await broker.modifyStopPrice(account, trade.broker_orders.g2.sl, { stopPrice: num(trade.be_price), qty: trade.g2_qty });
            state = 'tp1_hit';
            log.info('TP1 filled — Group 2 stop moved to breakeven', { tradeId, be: num(trade.be_price) });
            broadcaster.broadcast('order_submitted', { tradeId, accountId: trade.broker_account_id, event: 'tp1_hit', be: num(trade.be_price) });
          } catch (err) {
            log.error('Failed to move Group 2 stop to BE', { tradeId, error: String(err) });
          }
        }
      }

      await query(`UPDATE gb_trades SET fills=$2, state=$3 WHERE id=$1`, [tradeId, JSON.stringify(fills), state]);

      const exited = fills.filter((f) => EXIT_ROLES.includes(f.role)).reduce((s, f) => s + f.qty, 0);
      if (exited >= trade.contracts) {
        const fresh = await this.load(tradeId);
        if (fresh) await this.finalize(fresh);
      }
    });
  }

  // ------------------------------------------------------------------
  // Close / finalize
  // ------------------------------------------------------------------

  /** Signal-driven or manual close: cancel working exits, market out the remainder, finalize. */
  async closeAll(accountId: string, reason: string): Promise<number> {
    const open = await query<GbTradeRow>(
      `SELECT * FROM gb_trades WHERE broker_account_id=$1 AND state IN ('entry_pending','open','tp1_hit') ORDER BY created_at`,
      [accountId]
    );
    let n = 0;
    for (const t of open.rows) {
      try { await this.closeTrade(t, reason); n++; }
      catch (err) { log.error('closeTrade failed', { tradeId: t.id, error: String(err) }); }
    }
    return n;
  }

  async closeTrade(trade: GbTradeRow, reason: string): Promise<void> {
    await this.serialized(trade.id, async () => {
      const fresh = await this.load(trade.id);
      if (!fresh || fresh.state === 'closed' || fresh.state === 'failed') return;
      const { account, broker } = await this.brokerFor(fresh.broker_account_id);
      if (!broker) return;

      await query(`UPDATE gb_trades SET state='closing' WHERE id=$1`, [fresh.id]);

      // Cancel anything still working
      const ids = [fresh.broker_orders.g1?.tp, fresh.broker_orders.g1?.sl, fresh.broker_orders.g2?.tp, fresh.broker_orders.g2?.sl, fresh.broker_orders.entry?.g1, fresh.broker_orders.entry?.g2].filter(Boolean) as string[];
      for (const id of ids) {
        const st = await broker.getOrderState(account, id).catch(() => 'unknown' as const);
        if (st === 'working' || st === 'unknown') await broker.cancelOrder(account, id).catch(() => false);
      }

      // Bring in any fills we haven't recorded yet (e.g. TP hit during cancellation)
      await this.reconcileExitsInto(fresh, account, broker);
      const current = (await this.load(fresh.id)) ?? fresh;
      const entered = current.fills.filter((f) => f.role === 'entry_g1' || f.role === 'entry_g2').reduce((s, f) => s + f.qty, 0);
      const exited = current.fills.filter((f) => EXIT_ROLES.includes(f.role)).reduce((s, f) => s + f.qty, 0);
      const remaining = entered - exited;

      const fills = [...current.fills];
      const orders: BrokerOrders = { ...current.broker_orders, exit: [...(current.broker_orders.exit ?? [])] };
      if (remaining > 0) {
        const exitSide: OrderSide = current.direction === 'long' ? 'sell' : 'buy';
        const { orderId } = await broker.placeMarketOrder(account, { symbol: current.symbol, side: exitSide, qty: remaining, clientId: `${current.id}-exit-${Date.now()}` });
        orders.exit!.push(orderId);
        await this.saveOrders(current.id, orders);
        const got = await this.awaitFill(broker, account, orderId, remaining, 60_000);
        for (const f of got) fills.push({ ...f, role: 'exit', at: f.at.toISOString() });
      }
      await query(`UPDATE gb_trades SET fills=$2, broker_orders=$3, error_message=COALESCE(error_message,$4) WHERE id=$1`,
        [current.id, JSON.stringify(fills), JSON.stringify(orders), `closed: ${reason}`]);
      const final = await this.load(current.id);
      if (final) await this.finalize(final);
    });
  }

  private async reconcileExitsInto(trade: GbTradeRow, account: AccountRow, broker: IBracketBroker): Promise<void> {
    const candidates: Array<{ id: string; role: FillRole }> = [];
    if (trade.broker_orders.g1) candidates.push({ id: trade.broker_orders.g1.tp, role: 'g1_tp' }, { id: trade.broker_orders.g1.sl, role: 'g1_sl' });
    if (trade.broker_orders.g2) candidates.push({ id: trade.broker_orders.g2.tp, role: 'g2_tp' }, { id: trade.broker_orders.g2.sl, role: 'g2_sl' });
    const seen = new Set(trade.fills.map((f) => f.fillId ?? `${f.orderId}:${f.at}:${f.price}:${f.qty}`));
    const fills = [...trade.fills];
    for (const c of candidates) {
      const got = await broker.getFillsForOrder(account, c.id).catch(() => [] as BrokerFill[]);
      for (const f of got) {
        const key = f.fillId ?? `${f.orderId}:${f.at.toISOString()}:${f.price}:${f.qty}`;
        if (!seen.has(key)) { seen.add(key); fills.push({ orderId: f.orderId, fillId: f.fillId, role: c.role, qty: f.qty, price: f.price, at: f.at.toISOString() }); }
      }
    }
    if (fills.length !== trade.fills.length) await query(`UPDATE gb_trades SET fills=$2 WHERE id=$1`, [trade.id, JSON.stringify(fills)]);
  }

  /** Compute P&L and outcome, advance the ladder, roll day P&L. */
  private async finalize(trade: GbTradeRow): Promise<void> {
    if (trade.state === 'closed' || trade.state === 'failed') return;
    this.stopWatching(trade.id);

    const inst = requireInstrument(trade.root_symbol);
    const entry = num(trade.entry_price);
    const exits = trade.fills.filter((f) => EXIT_ROLES.includes(f.role));
    const pnl = realizedPnl({ direction: trade.direction, entry, exits, pointValue: inst.pointValue });
    const tp1Hit = trade.fills.some((f) => f.role === 'g1_tp');
    const tp2Hit = trade.fills.some((f) => f.role === 'g2_tp');

    const acct = await query<AccountRow>(
      `SELECT ba.*, p.daily_loss_cap AS preset_daily_loss_cap, p.cap_step AS preset_cap_step
       FROM broker_accounts ba LEFT JOIN presets p ON p.id = ba.preset_id WHERE ba.id=$1`,
      [trade.broker_account_id]
    );
    const account = acct.rows[0];
    const dailyLossCap = num(account?.preset_daily_loss_cap);
    const capStep = Number(account?.preset_cap_step ?? 3);
    const sameDay = toDayKey(account?.last_day_key) === toDayKey(trade.day_key);
    const dayPnlAfter = (sameDay ? num(account?.day_realized_pnl) : 0) + pnl;
    const breached = dailyLossCap > 0 && dayPnlAfter <= -dailyLossCap;

    const outcome = classifyOutcome({ pnl, tp1Hit, tp2Hit, breachedDll: breached });
    const step = nextStep(Number(account?.ladder_step ?? trade.step_at_entry), outcome, capStep);
    const exitTime = exits.length ? new Date(Math.max(...exits.map((f) => Date.parse(f.at)))) : new Date();

    await query(`UPDATE gb_trades SET state='closed', outcome=$2, pnl=$3, exit_time=$4 WHERE id=$1`, [trade.id, outcome, pnl, exitTime]);

    if (account) {
      await query(
        `UPDATE broker_accounts SET ladder_step=$2,
           day_realized_pnl = CASE WHEN last_day_key = $3::date THEN day_realized_pnl + $4 ELSE day_realized_pnl END,
           updated_at=NOW() WHERE id=$1`,
        [account.id, step, toDayKey(trade.day_key), pnl]
      );
      await query(
        `INSERT INTO account_daily_pnl (account_id, day_key, realized_pnl, trades, updated_at) VALUES ($1,$2,$3,1,NOW())
         ON CONFLICT (account_id, day_key) DO UPDATE SET realized_pnl = account_daily_pnl.realized_pnl + EXCLUDED.realized_pnl,
           trades = account_daily_pnl.trades + 1, updated_at = NOW()`,
        [account.id, toDayKey(trade.day_key), pnl]
      );
    }

    log.info('Trade closed', { tradeId: trade.id, accountId: trade.broker_account_id, outcome, pnl, nextStep: step, breachedDll: breached });
    broadcaster.broadcast('trade_created', {
      event: 'trade_closed', tradeId: trade.id, accountId: trade.broker_account_id, accountName: account?.name,
      symbol: trade.symbol, direction: trade.direction, outcome, pnl, nextStep: step, dayPnl: dayPnlAfter,
    });
    if (breached) {
      await query(
        `INSERT INTO risk_events (type, rule_type, account_id, message, details, created_at) VALUES ('warning','gb_dll_breached',$1,$2,$3,NOW())`,
        [trade.broker_account_id, `Daily loss cap reached (day P&L ${dayPnlAfter.toFixed(2)})`, JSON.stringify({ tradeId: trade.id, dayPnl: dayPnlAfter, dailyLossCap })]
      );
    }
  }

  /** Mark failed and release the session / trade-count the executor reserved. */
  private async fail(trade: GbTradeRow, message: string, releaseGate = false): Promise<void> {
    this.stopWatching(trade.id);
    await query(`UPDATE gb_trades SET state='failed', error_message=$2 WHERE id=$1`, [trade.id, message]);
    if (releaseGate && trade.session) {
      const col = sessionFlagColumn(trade.session);
      await query(
        `UPDATE broker_accounts SET trades_today = GREATEST(trades_today - 1, 0), ${col} = false, updated_at=NOW()
         WHERE id=$1 AND last_day_key = $2::date`,
        [trade.broker_account_id, toDayKey(trade.day_key)]
      );
    }
    log.warn('Trade failed', { tradeId: trade.id, message });
    broadcaster.broadcast('risk_event', { event: 'trade_failed', tradeId: trade.id, accountId: trade.broker_account_id, message });
  }

  // ------------------------------------------------------------------
  // Dev / simulation (mock brokers only)
  // ------------------------------------------------------------------

  /** Drive a trade to a chosen outcome without a market. Only for mock/simulated brokers. */
  async simulateExit(tradeId: string, outcome: 'W' | 'W~' | 'L' | 'BE'): Promise<GbTradeRow> {
    const trade = await this.load(tradeId);
    if (!trade) throw new Error('trade not found');
    if (trade.state !== 'open' && trade.state !== 'tp1_hit') throw new Error(`trade is ${trade.state}, not open`);
    const acct = await query<AccountRow>('SELECT broker_type FROM broker_accounts WHERE id=$1', [trade.broker_account_id]);
    if (!['mock', 'simulated'].includes(String(acct.rows[0]?.broker_type))) throw new Error('simulateExit is only allowed on mock/simulated accounts');

    const at = new Date().toISOString();
    const g1 = trade.g1_qty, g2 = trade.g2_qty;
    const px = { sl: num(trade.sl_price), tp1: num(trade.tp1_price), tp2: num(trade.tp2_price), be: num(trade.be_price), entry: num(trade.entry_price) };
    const fills: FillRecord[] = [...trade.fills];
    const push = (role: FillRole, qty: number, price: number, orderId: string) => { if (qty > 0) fills.push({ orderId, role, qty, price, at, fillId: `sim-${role}-${Date.now()}` }); };
    const o = trade.broker_orders;
    switch (outcome) {
      case 'W':  push('g1_tp', g1, px.tp1, o.g1?.tp ?? 'sim'); push('g2_tp', g2, px.tp2, o.g2?.tp ?? 'sim'); break;
      case 'W~': push('g1_tp', g1, px.tp1, o.g1?.tp ?? 'sim'); push('g2_sl', g2, px.be,  o.g2?.sl ?? 'sim'); break;
      case 'L':  push('g1_sl', g1, px.sl,  o.g1?.sl ?? 'sim'); push('g2_sl', g2, px.sl,  o.g2?.sl ?? 'sim'); break;
      case 'BE': push('exit',  g1 + g2, px.entry, 'sim-exit'); break;
    }
    await query(`UPDATE gb_trades SET fills=$2 WHERE id=$1`, [trade.id, JSON.stringify(fills)]);
    const fresh = (await this.load(trade.id))!;
    await this.finalize(fresh);
    return (await this.load(trade.id))!;
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  /** Resume open trades after a restart. */
  async rehydrate(): Promise<void> {
    const rows = await query<GbTradeRow>(`SELECT * FROM gb_trades WHERE state IN ('entry_pending','open','tp1_hit','closing') ORDER BY created_at`);
    if (rows.rowCount === 0) return;
    log.info('Rehydrating GB trades', { count: rows.rowCount });
    for (const t of rows.rows) {
      try {
        if (t.state === 'entry_pending') {
          if (t.broker_orders.entry?.g1 || t.broker_orders.entry?.g2) await this.execute(t.id);
          else await this.fail(t, 'Server restarted before entry was placed', true);
        } else if (t.state === 'closing') {
          await this.closeTrade(t, 'resume_after_restart');
        } else {
          await this.ensureWatching(t);
        }
      } catch (err) {
        log.error('Rehydrate failed for trade', { tradeId: t.id, error: String(err) });
      }
    }
  }

  shutdown(): void {
    for (const id of [...this.watchers.keys()]) this.stopWatching(id);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private serialized(tradeId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(tradeId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.catch(() => undefined).finally(() => { if (this.chains.get(tradeId) === tracked) this.chains.delete(tradeId); });
    this.chains.set(tradeId, tracked);
    return next;
  }

  private async load(tradeId: string): Promise<GbTradeRow | null> {
    const r = await query<GbTradeRow>('SELECT * FROM gb_trades WHERE id=$1', [tradeId]);
    const row = r.rows[0];
    if (!row) return null;
    row.broker_orders = row.broker_orders ?? {};
    row.fills = row.fills ?? [];
    return row;
  }

  private async saveOrders(tradeId: string, orders: BrokerOrders): Promise<void> {
    await query(`UPDATE gb_trades SET broker_orders=$2 WHERE id=$1`, [tradeId, JSON.stringify(orders)]);
  }

  private async brokerFor(accountId: string): Promise<{ account: AccountRow; broker: IBracketBroker | null }> {
    const r = await query<AccountRow>('SELECT * FROM broker_accounts WHERE id=$1', [accountId]);
    const account = r.rows[0];
    if (!account) throw new Error(`account ${accountId} not found`);
    const adapter = getBrokerAdapter(account.broker_type);
    if (!(await adapter.healthCheck())) await adapter.connect();
    return { account, broker: isBracketBroker(adapter) ? adapter : null };
  }

  private async presetFor(account: AccountRow): Promise<{ tp1_r: number; tp2_r: number } | null> {
    if (!account.preset_id) return null;
    const r = await query<{ tp1_r: string; tp2_r: string }>('SELECT tp1_r, tp2_r FROM presets WHERE id=$1', [account.preset_id]);
    const p = r.rows[0];
    return p ? { tp1_r: Number(p.tp1_r), tp2_r: Number(p.tp2_r) } : null;
  }
}

export const bracketManager = new BracketManager();
export { brokerDayKey };
