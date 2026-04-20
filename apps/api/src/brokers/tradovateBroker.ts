import { v4 as uuidv4 } from 'uuid';
import { BaseBrokerAdapter } from './interface';
import {
  BrokerAccount,
  AccountInfo,
  Position,
  Order,
  PlaceOrderRequest,
} from '../types';
import logger from '../utils/logger';

const BASE_URLS = {
  demo: 'https://demo.tradovateapi.com/v1',
  live: 'https://live.tradovateapi.com/v1',
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

export class TradovateBrokerAdapter extends BaseBrokerAdapter {
  readonly name = 'TradovateBroker';
  readonly brokerType = 'tradovate';

  // Keyed by our BrokerAccount.id (UUID)
  private tokenCache = new Map<string, TokenCache>();
  // Contract ID → symbol name cache to avoid repeat lookups
  private contractCache = new Map<number, string>();

  private brokerLogger = logger.child({ context: 'TradovateBroker' });

  async connect(): Promise<void> {
    this.isConnected = true;
    this.brokerLogger.info('Tradovate adapter initialised — tokens fetched per account on first use');
  }

  async disconnect(): Promise<void> {
    this.tokenCache.clear();
    this.contractCache.clear();
    this.isConnected = false;
    this.brokerLogger.info('Tradovate adapter disconnected');
  }

  async healthCheck(): Promise<boolean> {
    return this.isConnected;
  }

  // ------------------------------------------------------------------
  // Public interface methods
  // ------------------------------------------------------------------

  async getAccountInfo(account: BrokerAccount): Promise<AccountInfo> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);
    const creds = this.parseCredentials(account);

    const accountId = token.accountId;

    const [balanceRes, posRes] = await Promise.all([
      this.tvGet<{ amount: number; realizedPnL: number }[]>(
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
      equity: cashBalance + realizedPnL + openPnL,
    };
  }

  async getPositions(account: BrokerAccount): Promise<Position[]> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);

    const tvPositions = await this.tvGet<TradovatePosition[]>(
      baseUrl,
      '/position/list',
      token.accessToken
    );

    const accountPositions = (tvPositions ?? []).filter(
      (p) => p.accountId === token.accountId && p.netPos !== 0
    );

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

    const body: Record<string, unknown> = {
      accountSpec: token.accountSpec,
      accountId: token.accountId,
      clOrdId,
      action,
      symbol: request.symbol,
      orderQty: request.quantity,
      orderType,
      isAutomated: true,
    };

    if (request.limitPrice !== undefined) body['price'] = request.limitPrice;
    if (request.stopPrice !== undefined) body['stopPrice'] = request.stopPrice;

    const result = await this.tvPost<{ orderId: number; failureReason: string; failureText: string }>(
      baseUrl,
      '/order/placeorder',
      token.accessToken,
      body
    );

    if (result.failureReason && result.failureReason !== 'None') {
      throw new Error(`Tradovate order rejected: ${result.failureReason} — ${result.failureText}`);
    }

    const now = new Date();
    return {
      id: String(result.orderId),
      symbol: request.symbol,
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
      await this.tvPost(baseUrl, '/order/cancelorder', token.accessToken, {
        orderId: Number(orderId),
      });
      return true;
    } catch (err) {
      this.brokerLogger.warn('Cancel order failed', { orderId, error: String(err) });
      return false;
    }
  }

  async flattenAll(account: BrokerAccount): Promise<void> {
    this.ensureConnected();
    const { token, baseUrl } = await this.getToken(account);

    const tvPositions = await this.tvGet<TradovatePosition[]>(
      baseUrl,
      '/position/list',
      token.accessToken
    );

    const toClose = (tvPositions ?? []).filter(
      (p) => p.accountId === token.accountId && p.netPos !== 0
    );

    await Promise.all(
      toClose.map((p) =>
        this.tvPost(baseUrl, '/order/liquidateposition', token.accessToken, {
          accountId: token.accountId,
          contractId: p.contractId,
          isAutomated: true,
        }).catch((err) =>
          this.brokerLogger.error('Liquidate position failed', { contractId: p.contractId, error: String(err) })
        )
      )
    );

    this.brokerLogger.info('Flatten all complete', { accountId: account.id, count: toClose.length });
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

  private async authenticate(
    account: BrokerAccount,
    creds: TradovateCredentials,
    baseUrl: string
  ): Promise<TokenCache> {
    this.brokerLogger.info('Authenticating with Tradovate', {
      accountId: account.id,
      environment: creds.environment ?? 'demo',
    });

    const authRes = await this.tvPost<{
      accessToken: string;
      expirationTime: string;
      userId: number;
      errorText?: string;
      p_token?: string;
    }>(baseUrl, '/auth/accesstokenrequest', null, {
      name: creds.username,
      password: creds.password,
      appId: creds.appId,
      appVersion: creds.appVersion,
      cid: Number(creds.cid),
      sec: creds.sec,
      deviceId: creds.deviceId,
    });

    if (authRes.errorText) {
      throw new Error(`Tradovate auth failed: ${authRes.errorText}`);
    }

    // Resolve Tradovate account ID — use saved one or discover from /account/list
    let tradovateAccountId: number;
    let tradovateAccountSpec: string;

    if (creds.tradovateAccountId) {
      tradovateAccountId = Number(creds.tradovateAccountId);
      tradovateAccountSpec = creds.tradovateAccountSpec ?? String(tradovateAccountId);
    } else {
      const accounts = await this.tvGet<TradovateAccount[]>(
        baseUrl,
        '/account/list',
        authRes.accessToken
      );
      if (!accounts || accounts.length === 0) {
        throw new Error('No Tradovate accounts found for these credentials');
      }
      // Use the first active account
      const primary = accounts.find((a) => a.active) ?? accounts[0];
      tradovateAccountId = primary.id;
      tradovateAccountSpec = primary.name;
      this.brokerLogger.info(
        `Auto-discovered Tradovate account: ${primary.name} (id=${primary.id}). ` +
        `Add tradovateAccountId="${primary.id}" and tradovateAccountSpec="${primary.name}" ` +
        `to credentials to skip this lookup next time.`
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

  private async resolveContractSymbol(
    baseUrl: string,
    accessToken: string,
    contractId: number
  ): Promise<string> {
    const cached = this.contractCache.get(contractId);
    if (cached) return cached;

    try {
      const contract = await this.tvGet<{ name: string }>(
        baseUrl,
        `/contract/item?id=${contractId}`,
        accessToken
      );
      const name = contract?.name ?? String(contractId);
      this.contractCache.set(contractId, name);
      return name;
    } catch {
      return String(contractId);
    }
  }

  private mapOrderType(type: PlaceOrderRequest['orderType']): string {
    const map: Record<string, string> = {
      market: 'Market',
      limit: 'Limit',
      stop: 'Stop',
      stop_limit: 'StopLimit',
    };
    return map[type] ?? 'Market';
  }

  private async tvGet<T>(baseUrl: string, path: string, accessToken: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tradovate GET ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async tvPost<T>(
    baseUrl: string,
    path: string,
    accessToken: string | null,
    body: unknown
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
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
