import { v4 as uuidv4 } from 'uuid';
import { BaseBrokerAdapter } from './interface';
import { IBracketBroker, BrokerFill, OrderState, OrderSide } from './bracketInterface';
import {
  BrokerAccount,
  AccountInfo,
  Position,
  Order,
  PlaceOrderRequest,
} from '../types';
import logger from '../utils/logger';
import { resolveSymbol } from '../services/symbolResolver';
import { TradovateWsClient, TvFillEntity } from './tradovate/ws';
import {
  requestAccessToken,
  credentialsToAuthRequest,
  TradovateAuthResponse,
} from './tradovate/auth';

const BASE_URLS = {
  demo: 'https://demo.tradovateapi.com/v1',
  live: 'https://live.tradovateapi.com/v1',
} as const;

const WS_URLS = {
  demo: 'wss://demo.tradovateapi.com/v1/websocket',
  live: 'wss://live.tradovateapi.com/v1/websocket',
} as const;

// Credentials stored in broker_accounts.credentials JSONB
interface TradovateCredentials {
  username: string;
  password: string;       // use API-dedicated password from Tradovate dashboard
  appId: string;
  appVersion: string;
  cid: string;            // client ID (number stored as string)
  sec: string;            // client secret
  deviceId: string;       // stable UUID you generate once
  environment?: 'demo' | 'live';
  tradovateAccountId?: string;   // numeric Tradovate account ID (auto-discovered on first auth)
  tradovateAccountSpec?: string; // account name e.g. "DEMO123456" (auto-discovered)
}

interface TokenCache {
  accessToken: string;
  expiresAt: Date;
  userId: number;
  accountId: number;
  accountSpec: string;
}

interface TvOrderReply { orderId: number; ocoId?: number; failureReason?: string; failureText?: string }
interface TvCommandReply { commandId?: number; failureReason?: string; failureText?: string }

/**
 * Tradovate REST + WebSocket adapter.
 * Implements the generic IBrokerAdapter and the bracket capability used by GB LIVE.
 */
export class TradovateBrokerAdapter extends BaseBrokerAdapter implements IBracketBroker {
  readonly name = 'TradovateBroker';
  readonly brokerType = 'tradovate';

  // Keyed by our BrokerAccount.id (UUID)
  private tokenCache = new Map<string, TokenCache>();
  // Contract ID → symbol name cache to avoid repeat lookups
  private contractCache = new Map<number, string>();
  // One WS per Tradovate login (many prop-firm accounts share a login)
  private wsClients = new Map<string, TradovateWsClient>();

  private brokerLogger = logger.child({ context: 'TradovateBroker' });

  async connect(): Promise<void> {
    this.isConnected = true;
    this.brokerLogger.info('Tradovate adapter initialised — tokens fetched per account on first use');
  }

  async disconnect(): Promise<void> {
    for (const [, ws] of this.wsClients) ws.close();
    this.wsClients.clear();
    this.tokenCache.clear();
    this.contractCache.clear();
    this.isConnected = false;
    this.brokerLogger.info('Tradovate adapter disconnected');
  }

  async healthCheck(): Promise<boolean> {
    return this.isConnected;
  }

  // ------------------------------------------------------------------
  // IBrokerAdapter
  // ------------------------------------------------------------------

  async getAccountInfo(account: BrokerAccount): Promise<AccountInfo> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);
    const accountId = token.accountId;

    const [balanceRes, posRes] = await Promise.all([
      this.tvGet<{ amount: number; realizedPnL: number }[] | { amount: number; realizedPnL: number }>(
        baseUrl,
        `/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`,
        token.accessToken
      ),
      this.tvGet<TradovatePosition[]>(baseUrl, '/position/list', token.accessToken),
    ]);

    const balance = Array.isArray(balanceRes) ? balanceRes[0] : balanceRes;
    const cashBalance = balance?.amount ?? 0;
    const realizedPnL = balance?.realizedPnL ?? 0;

    const accountPositions = (posRes ?? []).filter((p) => p.accountId === accountId);
    const openPnL = accountPositions.reduce((sum, p) => sum + (p.openPnl ?? 0), 0);

    return {
      account_id: account.id,
      cashBalance,
      buyingPower: cashBalance,
      realizedPnL,
      equity: cashBalance + realizedPnL + openPnL,
    };
  }

  async getPositions(account: BrokerAccount): Promise<Position[]> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);

    const tvPositions = await this.tvGet<TradovatePosition[]>(baseUrl, '/position/list', token.accessToken);
    const accountPositions = (tvPositions ?? []).filter((p) => p.accountId === token.accountId && p.netPos !== 0);

    const positions: Position[] = [];
    for (const p of accountPositions) {
      const symbol = await this.resolveContractSymbol(baseUrl, token.accessToken, p.contractId);
      positions.push({
        symbol,
        quantity: Math.abs(p.netPos),
        side: p.netPos > 0 ? 'long' : 'short',
        avgEntryPrice: p.netPrice ?? 0,
        unrealizedPnl: p.openPnl ?? 0,
      });
    }
    return positions;
  }

  async placeOrder(account: BrokerAccount, request: PlaceOrderRequest): Promise<Order> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);

    const action = request.side === 'buy' ? 'Buy' : 'Sell';
    const orderType = this.mapOrderType(request.orderType);
    const clOrdId = uuidv4();
    const symbol = await resolveSymbol(request.symbol, baseUrl, token.accessToken);

    const body: Record<string, unknown> = {
      accountSpec: token.accountSpec,
      accountId: token.accountId,
      clOrdId,
      action,
      symbol,
      orderQty: request.quantity,
      orderType,
      timeInForce: this.mapTif(request.timeInForce),
      isAutomated: true,
    };
    if (request.limitPrice !== undefined) body['price'] = request.limitPrice;
    if (request.stopPrice !== undefined) body['stopPrice'] = request.stopPrice;

    const result = await this.tvPost<TvOrderReply>(baseUrl, '/order/placeorder', token.accessToken, body);
    this.assertOk(result, 'placeorder');

    const now = new Date();
    return {
      id: String(result.orderId),
      symbol,
      side: request.side,
      quantity: request.quantity,
      orderType: request.orderType,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
      timeInForce: request.timeInForce ?? 'day',
      status: 'submitted',
      filledQuantity: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);
    try {
      const r = await this.tvPost<TvCommandReply>(baseUrl, '/order/cancelorder', token.accessToken, {
        orderId: Number(orderId),
        isAutomated: true,
      });
      if (r.failureReason && r.failureReason !== 'None') {
        this.brokerLogger.warn('Cancel rejected', { orderId, reason: r.failureReason, text: r.failureText });
        return false;
      }
      return true;
    } catch (err) {
      this.brokerLogger.warn('Cancel order failed', { orderId, error: String(err) });
      return false;
    }
  }

  async flattenAll(account: BrokerAccount): Promise<void> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);

    const tvPositions = await this.tvGet<TradovatePosition[]>(baseUrl, '/position/list', token.accessToken);
    const toClose = (tvPositions ?? []).filter((p) => p.accountId === token.accountId && p.netPos !== 0);

    await Promise.all(
      toClose.map((p) =>
        this.tvPost(baseUrl, '/order/liquidateposition', token.accessToken, {
          accountId: token.accountId,
          contractId: p.contractId,
          admin: false,
          isAutomated: true,
        }).catch((err) =>
          this.brokerLogger.error('Liquidate position failed', { contractId: p.contractId, error: String(err) })
        )
      )
    );

    this.brokerLogger.info('Flatten all complete', { accountId: account.id, count: toClose.length });
  }

  // ------------------------------------------------------------------
  // IBracketBroker
  // ------------------------------------------------------------------

  async resolveTradableSymbol(account: BrokerAccount, symbol: string): Promise<string> {
    const { token, baseUrl } = await this.getToken(account);
    return resolveSymbol(symbol, baseUrl, token.accessToken);
  }

  async placeMarketOrder(
    account: BrokerAccount,
    req: { symbol: string; side: OrderSide; qty: number; refPrice?: number; clientId?: string }
  ): Promise<{ orderId: string }> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);
    const result = await this.tvPost<TvOrderReply>(baseUrl, '/order/placeorder', token.accessToken, {
      accountSpec: token.accountSpec,
      accountId: token.accountId,
      clOrdId: req.clientId ?? uuidv4(),
      action: req.side === 'buy' ? 'Buy' : 'Sell',
      symbol: req.symbol,
      orderQty: req.qty,
      orderType: 'Market',
      timeInForce: 'Day',
      isAutomated: true,
    });
    this.assertOk(result, 'placeorder');
    return { orderId: String(result.orderId) };
  }

  async placeOcoExit(
    account: BrokerAccount,
    req: { symbol: string; side: OrderSide; qty: number; tpPrice: number; slPrice: number }
  ): Promise<{ tpOrderId: string; slOrderId: string }> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);
    const action = req.side === 'buy' ? 'Buy' : 'Sell';
    const result = await this.tvPost<TvOrderReply>(baseUrl, '/order/placeoco', token.accessToken, {
      accountSpec: token.accountSpec,
      accountId: token.accountId,
      clOrdId: uuidv4(),
      action,
      symbol: req.symbol,
      orderQty: req.qty,
      orderType: 'Limit',
      price: req.tpPrice,
      timeInForce: 'GTC',
      isAutomated: true,
      other: {
        action,
        orderType: 'Stop',
        stopPrice: req.slPrice,
        timeInForce: 'GTC',
      },
    });
    this.assertOk(result, 'placeoco');
    if (result.ocoId === undefined) throw new Error('Tradovate placeoco returned no ocoId');
    return { tpOrderId: String(result.orderId), slOrderId: String(result.ocoId) };
  }

  async modifyStopPrice(account: BrokerAccount, orderId: string, req: { stopPrice: number; qty: number }): Promise<void> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);
    const result = await this.tvPost<TvCommandReply>(baseUrl, '/order/modifyorder', token.accessToken, {
      orderId: Number(orderId),
      orderQty: req.qty,
      orderType: 'Stop',
      stopPrice: req.stopPrice,
      isAutomated: true,
    });
    if (result.failureReason && result.failureReason !== 'None') {
      throw new Error(`Tradovate modifyorder rejected: ${result.failureReason} — ${result.failureText ?? ''}`);
    }
  }

  async getOrderState(account: BrokerAccount, orderId: string): Promise<OrderState> {
    const { token, baseUrl } = await this.getToken(account);
    try {
      const o = await this.tvGet<{ ordStatus?: string }>(baseUrl, `/order/item?id=${Number(orderId)}`, token.accessToken);
      return this.mapOrdStatus(o?.ordStatus);
    } catch (err) {
      this.brokerLogger.warn('getOrderState failed', { orderId, error: String(err) });
      return 'unknown';
    }
  }

  async getFillsForOrder(account: BrokerAccount, orderId: string): Promise<BrokerFill[]> {
    const { token, baseUrl } = await this.getToken(account);
    const fills = await this.tvGet<TvFillEntity[]>(baseUrl, `/fill/deps?masterid=${Number(orderId)}`, token.accessToken);
    return (fills ?? [])
      .filter((f) => f.active !== false)
      .map((f) => ({ orderId: String(f.orderId), fillId: String(f.id), qty: f.qty, price: f.price, at: new Date(f.timestamp) }));
  }

  async subscribeFills(account: BrokerAccount, handler: (fill: BrokerFill) => void): Promise<() => void> {
    const client = await this.getWs(account);
    const listener = (f: TvFillEntity) => {
      if (f.active === false) return;
      handler({ orderId: String(f.orderId), fillId: String(f.id), qty: f.qty, price: f.price, at: new Date(f.timestamp) });
    };
    client.on('fill', listener);
    return () => { client.off('fill', listener); };
  }

  // ------------------------------------------------------------------
  // WebSocket management
  // ------------------------------------------------------------------

  private async getWs(account: BrokerAccount): Promise<TradovateWsClient> {
    const creds = this.parseCredentials(account);
    const env = creds.environment ?? 'demo';
    const key = `${env}:${creds.username}`;
    let client = this.wsClients.get(key);
    if (client) return client;

    client = new TradovateWsClient({
      wsUrl: WS_URLS[env],
      label: key,
      getAccessToken: async () => (await this.getToken(account)).token.accessToken,
      getUserId: async () => (await this.getToken(account)).token.userId,
    });
    this.wsClients.set(key, client);
    try {
      await client.connect();
    } catch (err) {
      // Reconnect continues in the background; REST polling covers the gap.
      this.brokerLogger.warn('Initial WS connect failed; will retry in background', { key, error: String(err) });
    }
    return client;
  }

  // ------------------------------------------------------------------
  // Token management
  // ------------------------------------------------------------------

  private async getToken(account: BrokerAccount): Promise<{ token: TokenCache; baseUrl: string }> {
    const creds = this.parseCredentials(account);
    const baseUrl = BASE_URLS[creds.environment ?? 'demo'];
    const cached = this.tokenCache.get(account.id);

    if (cached && cached.expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
      return { token: cached, baseUrl };
    }

    const token = await this.authenticate(account, creds, baseUrl);
    return { token, baseUrl };
  }

  private async authenticate(account: BrokerAccount, creds: TradovateCredentials, baseUrl: string): Promise<TokenCache> {
    this.brokerLogger.info('Authenticating with Tradovate', { accountId: account.id, environment: creds.environment ?? 'demo' });

    const authRes = await requestAccessToken(
      (path, body) => this.tvPost<TradovateAuthResponse>(baseUrl, path, null, body),
      credentialsToAuthRequest(creds),
      { onPenalty: (waitSeconds, attempt) =>
          this.brokerLogger.warn('Tradovate auth time penalty — retrying', {
            accountId: account.id, waitSeconds, attempt,
          }),
      }
    );

    let tradovateAccountId: number;
    let tradovateAccountSpec: string;

    if (creds.tradovateAccountId) {
      tradovateAccountId = Number(creds.tradovateAccountId);
      tradovateAccountSpec = creds.tradovateAccountSpec ?? String(tradovateAccountId);
    } else {
      const accounts = await this.tvGet<TradovateAccount[]>(baseUrl, '/account/list', authRes.accessToken);
      if (!accounts || accounts.length === 0) throw new Error('No Tradovate accounts found for these credentials');
      const primary = accounts.find((a) => a.active) ?? accounts[0];
      tradovateAccountId = primary.id;
      tradovateAccountSpec = primary.name;
      this.brokerLogger.info(
        `Auto-discovered Tradovate account: ${primary.name} (id=${primary.id}). ` +
        `Add tradovateAccountId="${primary.id}" and tradovateAccountSpec="${primary.name}" to credentials to pin it.`
      );
    }

    const token: TokenCache = {
      accessToken: authRes.accessToken,
      expiresAt: new Date(authRes.expirationTime),
      userId: authRes.userId,
      accountId: tradovateAccountId,
      accountSpec: tradovateAccountSpec,
    };
    this.tokenCache.set(account.id, token);
    return token;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private parseCredentials(account: BrokerAccount): TradovateCredentials {
    const c = account.credentials as Record<string, string>;
    const required = ['username', 'password', 'appId', 'appVersion', 'cid', 'sec', 'deviceId'];
    for (const field of required) {
      if (!c[field]) throw new Error(`Tradovate credential missing: ${field}`);
    }
    return c as unknown as TradovateCredentials;
  }

  private async resolveContractSymbol(baseUrl: string, accessToken: string, contractId: number): Promise<string> {
    const cached = this.contractCache.get(contractId);
    if (cached) return cached;
    try {
      const contract = await this.tvGet<{ name: string }>(baseUrl, `/contract/item?id=${contractId}`, accessToken);
      const name = contract?.name ?? String(contractId);
      this.contractCache.set(contractId, name);
      return name;
    } catch {
      return String(contractId);
    }
  }

  private assertOk(result: TvOrderReply, op: string): void {
    if (result.failureReason && result.failureReason !== 'None') {
      throw new Error(`Tradovate ${op} rejected: ${result.failureReason} — ${result.failureText ?? ''}`);
    }
    if (result.orderId === undefined || result.orderId === null) {
      throw new Error(`Tradovate ${op} returned no orderId`);
    }
  }

  private mapOrdStatus(s?: string): OrderState {
    switch (s) {
      case 'Filled': return 'filled';
      case 'Working':
      case 'PendingNew':
      case 'PendingReplace':
      case 'Suspended': return 'working';
      case 'Canceled':
      case 'PendingCancel': return 'canceled';
      case 'Rejected': return 'rejected';
      case 'Expired': return 'expired';
      default: return 'unknown';
    }
  }

  private mapOrderType(type: PlaceOrderRequest['orderType']): string {
    const map: Record<string, string> = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'StopLimit' };
    return map[type] ?? 'Market';
  }

  private mapTif(tif?: PlaceOrderRequest['timeInForce']): string {
    const map: Record<string, string> = { day: 'Day', gtc: 'GTC', ioc: 'IOC' };
    return map[tif ?? 'day'] ?? 'Day';
  }

  private async tvGet<T>(baseUrl: string, path: string, accessToken: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tradovate GET ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async tvPost<T>(baseUrl: string, path: string, accessToken: string | null, body: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tradovate POST ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

// ------------------------------------------------------------------
// Tradovate API response shapes (internal)
// ------------------------------------------------------------------

interface TradovateAccount {
  id: number;
  name: string;
  userId: number;
  active: boolean;
}

interface TradovatePosition {
  id: number;
  accountId: number;
  contractId: number;
  netPos: number;       // positive = long, negative = short
  openPnl: number;
  netPrice: number;
}
