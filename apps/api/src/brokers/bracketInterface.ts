import { BrokerAccount } from '../types';

/**
 * Optional capability for brokers that can run the GB LIVE bracket lifecycle:
 * market entry → fill → OCO take-profit / stop per group → stop modification → fills stream.
 *
 * Implemented by TradovateBrokerAdapter (real) and MockBrokerAdapter (instant fills, for local testing).
 */
export type OrderSide = 'buy' | 'sell';

export type OrderState =
  | 'working'
  | 'filled'
  | 'partially_filled'
  | 'canceled'
  | 'rejected'
  | 'expired'
  | 'unknown';

export interface BrokerFill {
  /** Broker order id the fill belongs to */
  orderId: string;
  /** Broker fill id when available (used for de-duplication) */
  fillId?: string;
  qty: number;
  price: number;
  at: Date;
}

export interface IBracketBroker {
  /** MNQ1! → the contract this broker actually trades (MNQM6). */
  resolveTradableSymbol(account: BrokerAccount, symbol: string): Promise<string>;

  placeMarketOrder(
    account: BrokerAccount,
    req: { symbol: string; side: OrderSide; qty: number; refPrice?: number; clientId?: string }
  ): Promise<{ orderId: string }>;

  /** Limit take-profit + stop loss as an OCO pair. Returns both broker ids. */
  placeOcoExit(
    account: BrokerAccount,
    req: { symbol: string; side: OrderSide; qty: number; tpPrice: number; slPrice: number }
  ): Promise<{ tpOrderId: string; slOrderId: string }>;

  modifyStopPrice(
    account: BrokerAccount,
    orderId: string,
    req: { stopPrice: number; qty: number }
  ): Promise<void>;

  cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean>;

  getOrderState(account: BrokerAccount, orderId: string): Promise<OrderState>;

  getFillsForOrder(account: BrokerAccount, orderId: string): Promise<BrokerFill[]>;

  /** Push stream of fills for this account. Returns an unsubscribe function. */
  subscribeFills(account: BrokerAccount, handler: (fill: BrokerFill) => void): Promise<() => void>;
}

export function isBracketBroker(adapter: unknown): adapter is IBracketBroker {
  const a = adapter as Partial<IBracketBroker> | null;
  return !!a &&
    typeof a.placeMarketOrder === 'function' &&
    typeof a.placeOcoExit === 'function' &&
    typeof a.modifyStopPrice === 'function' &&
    typeof a.getOrderState === 'function' &&
    typeof a.getFillsForOrder === 'function' &&
    typeof a.subscribeFills === 'function' &&
    typeof a.resolveTradableSymbol === 'function';
}
