/**
 * Tradovate WebSocket client.
 *
 * Protocol (text frames):
 *   server → 'o'                      socket open
 *   server → 'h'                      heartbeat
 *   server → 'a[{...},{...}]'         array of messages: replies {s,i,d} or events {e,d}
 *   server → 'c[code,"reason"]'       close
 *   client → '<endpoint>\n<id>\n<query>\n<body>'   request
 *   client → '[]'                     heartbeat (must be sent ~every 2.5 s)
 *
 * After 'o': authorize with the access token, then user/syncrequest to subscribe to
 * account/order/fill/position events for the user.
 *
 * Gotchas handled: silent disconnects (watchdog on last frame), exponential reconnect,
 * token refresh on reconnect.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import logger from '../../utils/logger';

export interface TvFillEntity {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  action: 'Buy' | 'Sell';
  qty: number;
  price: number;
  active?: boolean;
}

export interface TvOrderEntity {
  id: number;
  accountId: number;
  contractId: number;
  ordStatus: string;
  action: string;
  timestamp: string;
}

export interface TradovateWsOptions {
  wsUrl: string;
  getAccessToken: () => Promise<string>;
  getUserId: () => Promise<number>;
  /** Client heartbeat interval; Tradovate expects roughly 2.5 s. */
  heartbeatMs?: number;
  /** If no frame of any kind arrives within this window the socket is considered dead. */
  watchdogMs?: number;
  label?: string;
}

interface Pending {
  resolve: (msg: { s: number; d?: unknown }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TradovateWsClient extends EventEmitter {
  private ws?: WebSocket;
  private reqId = 0;
  private pending = new Map<number, Pending>();
  private hbTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private backoffMs = 1000;
  private closedByUser = false;
  private lastFrameAt = 0;
  private connecting?: Promise<void>;
  private log = logger.child({ context: 'TradovateWS' });

  public authorized = false;

  constructor(private readonly opts: TradovateWsOptions) {
    super();
    this.setMaxListeners(200);
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.authorized;
  }

  /** Connect + authorize + sync. Resolves once authorized; rejects on failure (reconnect continues in background). */
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.closedByUser = false;
    this.connecting = this.openSocket().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    this.authorized = false;
  }

  // ------------------------------------------------------------------

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.clearTimers();
      this.authorized = false;

      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };

      const label = this.opts.label ?? this.opts.wsUrl;
      this.log.info('Connecting', { label });

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.opts.wsUrl);
      } catch (err) {
        this.scheduleReconnect();
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      ws.on('message', (data) => {
        const raw = data.toString();
        this.lastFrameAt = Date.now();
        void this.handleFrame(raw, settle);
      });

      ws.on('error', (err) => {
        this.log.warn('Socket error', { label, error: err.message });
        settle(err);
      });

      ws.on('close', (code, reason) => {
        this.log.warn('Socket closed', { label, code, reason: reason?.toString() });
        this.authorized = false;
        this.clearTimers();
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
        this.pending.clear();
        this.emit('disconnected');
        settle(new Error(`socket closed (${code})`));
        this.scheduleReconnect();
      });
    });
  }

  private async handleFrame(raw: string, settle: (err?: Error) => void): Promise<void> {
    if (raw === 'o') {
      try {
        await this.authorizeAndSync();
        this.backoffMs = 1000;
        this.startHeartbeat();
        this.startWatchdog();
        this.emit('connected');
        settle();
      } catch (err) {
        this.log.error('Authorize/sync failed', { error: err instanceof Error ? err.message : String(err) });
        settle(err instanceof Error ? err : new Error(String(err)));
        try { this.ws?.close(); } catch { /* ignore */ }
      }
      return;
    }
    if (raw === 'h') return;
    if (raw.startsWith('a')) {
      let msgs: Array<Record<string, unknown>>;
      try { msgs = JSON.parse(raw.slice(1)); } catch { return; }
      for (const msg of msgs) this.handleMessage(msg);
      return;
    }
    if (raw.startsWith('c')) {
      this.log.warn('Server close frame', { raw });
      return;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg.i === 'number') {
      const p = this.pending.get(msg.i);
      if (p) {
        this.pending.delete(msg.i);
        clearTimeout(p.timer);
        p.resolve({ s: Number(msg.s), d: msg.d });
      }
      return;
    }
    if (msg.e === 'props') {
      const d = msg.d as { entityType?: string; eventType?: string; entity?: unknown } | undefined;
      if (!d?.entityType) return;
      if (d.entityType === 'fill' && d.eventType === 'Created') {
        this.emit('fill', d.entity as TvFillEntity);
      } else if (d.entityType === 'order') {
        this.emit('order', d.entity as TvOrderEntity);
      } else if (d.entityType === 'executionReport') {
        this.emit('executionReport', d.entity);
      } else if (d.entityType === 'position') {
        this.emit('position', d.entity);
      }
      return;
    }
    if (msg.e === 'shutdown') {
      this.log.warn('Server requested shutdown', { d: msg.d });
      try { this.ws?.close(); } catch { /* ignore */ }
    }
  }

  private async authorizeAndSync(): Promise<void> {
    const token = await this.opts.getAccessToken();
    const auth = await this.request('authorize', undefined, token, 10_000);
    if (auth.s !== 200) throw new Error(`authorize → ${auth.s} ${JSON.stringify(auth.d ?? '')}`);
    this.authorized = true;

    const userId = await this.opts.getUserId();
    const sync = await this.request('user/syncrequest', undefined, JSON.stringify({ users: [userId] }), 15_000);
    if (sync.s !== 200) throw new Error(`user/syncrequest → ${sync.s}`);
    this.emit('synced', sync.d);
  }

  /** Send a request frame and await its reply. `body` is sent verbatim (already-serialized). */
  request(endpoint: string, query?: string, body?: string, timeoutMs = 10_000): Promise<{ s: number; d?: unknown }> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('socket not open')); return; }
      const id = ++this.reqId;
      const frame = `${endpoint}\n${id}\n${query ?? ''}\n${body ?? ''}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${endpoint} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(frame, (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  private startHeartbeat(): void {
    const every = this.opts.heartbeatMs ?? 2500;
    this.hbTimer = setInterval(() => {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('[]', () => { /* errors surface via 'error'/'close' */ });
      }
    }, every);
  }

  private startWatchdog(): void {
    const limit = this.opts.watchdogMs ?? 15_000;
    this.lastFrameAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > limit) {
        this.log.warn('No frames within watchdog window — terminating socket', { limit });
        try { this.ws?.terminate(); } catch { /* ignore */ }
      }
    }, Math.min(5000, limit));
  }

  private clearTimers(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.hbTimer = this.watchdogTimer = this.reconnectTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.log.info('Reconnecting', { inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => { /* logged inside; reconnect rescheduled on close */ });
    }, delay);
  }
}
