import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { BaseBrokerAdapter } from './interface';
import { IBracketBroker, BrokerFill, OrderState, OrderSide } from './bracketInterface';
import {
  BrokerAccount,
  AccountInfo,
  Position,
  Order,
  PlaceOrderRequest,
  OrderStatus,
} from '../types';
import logger from '../utils/logger';

interface MockBracketOrder {
  symbol: string;
  side: OrderSide;
  qty: number;
  state: OrderState;
  fills: BrokerFill[];
}

/**
 * Mock Broker Adapter
 *
 * Simulates broker behavior for development and testing.
 * Stores state in memory only - resets on restart.
 *
 * Also implements IBracketBroker so the GB LIVE bracket engine can be exercised
 * end-to-end without real Tradovate credentials: market orders fill instantly,
 * OCO exits sit "working" until canceled or driven to a fill by test code
 * (see bracketManager.simulateExit, which is mock/simulated-only).
 */
export class MockBrokerAdapter extends BaseBrokerAdapter implements IBracketBroker {
  readonly name = 'MockBroker';
  readonly brokerType = 'mock';

  // In-memory state
  private mockPositions: Map<string, Position[]> = new Map();
  private mockOrders: Map<string, Order[]> = new Map();
  private mockAccountInfo: Map<string, AccountInfo> = new Map();
  private bracketOrders: Map<string, MockBracketOrder> = new Map();
  private fillEmitter = new EventEmitter();

  private brokerLogger = logger.child({ context: 'MockBroker' });
  
  async connect(): Promise<void> {
    this.brokerLogger.info('Mock broker connected');
    this.isConnected = true;
  }
  
  async disconnect(): Promise<void> {
    this.brokerLogger.info('Mock broker disconnected');
    this.isConnected = false;
  }
  
  async healthCheck(): Promise<boolean> {
    return this.isConnected;
  }
  
  async getAccountInfo(account: BrokerAccount): Promise<AccountInfo> {
    this.ensureConnected();
    
    const cached = this.mockAccountInfo.get(account.id);
    if (cached) return cached;
    
    const info: AccountInfo = {
      account_id: account.id,
      buyingPower: 100000,
      cashBalance: 100000,
      equity: 100000,
      dayTradesRemaining: 3,
    };
    
    this.mockAccountInfo.set(account.id, info);
    return info;
  }
  
  async getPositions(account: BrokerAccount): Promise<Position[]> {
    this.ensureConnected();
    return this.mockPositions.get(account.id) || [];
  }
  
  async placeOrder(
    account: BrokerAccount,
    request: PlaceOrderRequest
  ): Promise<Order> {
    this.ensureConnected();
    
    const orderId = uuidv4();
    const now = new Date();
    
    const order: Order = {
      id: orderId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      orderType: request.orderType,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
      timeInForce: request.timeInForce || 'day',
      status: 'filled',
      filledQuantity: request.quantity,
      avgFillPrice: request.limitPrice || 100.00,
      createdAt: now,
      updatedAt: now,
    };
    
    // Store order
    const accountOrders = this.mockOrders.get(account.id) || [];
    accountOrders.push(order);
    this.mockOrders.set(account.id, accountOrders);
    
    // Update positions (simplified)
    await this.updatePosition(account, request);
    
    this.brokerLogger.info('Mock order placed', {
      accountId: account.id,
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
    });
    
    return order;
  }
  
  async cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean> {
    this.ensureConnected();

    const bracket = this.bracketOrders.get(orderId);
    if (bracket) {
      if (bracket.state !== 'working') return false;
      bracket.state = 'canceled';
      this.brokerLogger.info('Mock bracket order canceled', { orderId });
      return true;
    }

    const orders = this.mockOrders.get(account.id) || [];
    const order = orders.find(o => o.id === orderId);

    if (!order) return false;

    order.status = 'canceled';
    order.updatedAt = new Date();

    this.brokerLogger.info('Mock order canceled', { orderId });
    return true;
  }

  // ------------------------------------------------------------------
  // IBracketBroker — used by the GB LIVE bracket manager
  // ------------------------------------------------------------------

  async resolveTradableSymbol(_account: BrokerAccount, symbol: string): Promise<string> {
    return symbol.endsWith('1!') ? `${symbol.slice(0, -2)}MOCK` : symbol;
  }

  async placeMarketOrder(
    _account: BrokerAccount,
    req: { symbol: string; side: OrderSide; qty: number; refPrice?: number; clientId?: string }
  ): Promise<{ orderId: string }> {
    this.ensureConnected();
    const orderId = uuidv4();
    const price = req.refPrice ?? 100;
    const fill: BrokerFill = { orderId, fillId: `${orderId}-fill`, qty: req.qty, price, at: new Date() };
    this.bracketOrders.set(orderId, { symbol: req.symbol, side: req.side, qty: req.qty, state: 'filled', fills: [fill] });
    // Emit async so callers that subscribe immediately after this returns still see it;
    // the poll-based fallback in the bracket manager also picks it up either way.
    setImmediate(() => this.fillEmitter.emit('fill', fill));
    this.brokerLogger.info('Mock market order filled instantly', { orderId, symbol: req.symbol, side: req.side, qty: req.qty, price });
    return { orderId };
  }

  async placeOcoExit(
    _account: BrokerAccount,
    req: { symbol: string; side: OrderSide; qty: number; tpPrice: number; slPrice: number }
  ): Promise<{ tpOrderId: string; slOrderId: string }> {
    this.ensureConnected();
    const tpOrderId = uuidv4();
    const slOrderId = uuidv4();
    this.bracketOrders.set(tpOrderId, { symbol: req.symbol, side: req.side, qty: req.qty, state: 'working', fills: [] });
    this.bracketOrders.set(slOrderId, { symbol: req.symbol, side: req.side, qty: req.qty, state: 'working', fills: [] });
    this.brokerLogger.debug('Mock OCO exit placed', { tpOrderId, slOrderId, tpPrice: req.tpPrice, slPrice: req.slPrice });
    return { tpOrderId, slOrderId };
  }

  async modifyStopPrice(_account: BrokerAccount, orderId: string, req: { stopPrice: number; qty: number }): Promise<void> {
    this.brokerLogger.debug('Mock modify stop price (no-op)', { orderId, stopPrice: req.stopPrice, qty: req.qty });
  }

  async getOrderState(_account: BrokerAccount, orderId: string): Promise<OrderState> {
    return this.bracketOrders.get(orderId)?.state ?? 'unknown';
  }

  async getFillsForOrder(_account: BrokerAccount, orderId: string): Promise<BrokerFill[]> {
    return this.bracketOrders.get(orderId)?.fills ?? [];
  }

  async subscribeFills(_account: BrokerAccount, handler: (fill: BrokerFill) => void): Promise<() => void> {
    this.fillEmitter.on('fill', handler);
    return () => { this.fillEmitter.off('fill', handler); };
  }
  
  async flattenAll(account: BrokerAccount): Promise<void> {
    this.ensureConnected();
    
    const positions = this.mockPositions.get(account.id) || [];
    
    for (const position of positions) {
      // Create closing order
      await this.placeOrder(account, {
        symbol: position.symbol,
        side: position.side === 'long' ? 'sell' : 'buy',
        quantity: position.quantity,
        orderType: 'market',
        timeInForce: 'day',
      });
    }
    
    // Clear positions
    this.mockPositions.set(account.id, []);
    
    this.brokerLogger.info('Flattened all positions', {
      accountId: account.id,
      positionCount: positions.length,
    });
  }
  
  private async updatePosition(
    account: BrokerAccount,
    request: PlaceOrderRequest
  ): Promise<void> {
    const positions = this.mockPositions.get(account.id) || [];
    const existingIndex = positions.findIndex(p => p.symbol === request.symbol);
    
    const isBuy = request.side === 'buy';
    const side: 'long' | 'short' = isBuy ? 'long' : 'short';
    
    if (existingIndex >= 0) {
      const existing = positions[existingIndex];
      
      if (existing.side === side) {
        // Adding to position
        existing.quantity += request.quantity;
        existing.avgEntryPrice = 
          (existing.avgEntryPrice * (existing.quantity - request.quantity) + 
           (request.limitPrice || 100) * request.quantity) / existing.quantity;
      } else {
        // Reducing or reversing position
        if (existing.quantity <= request.quantity) {
          // Position closed or reversed
          const remaining = request.quantity - existing.quantity;
          positions.splice(existingIndex, 1);
          
          if (remaining > 0) {
            // Create new position in opposite direction
            positions.push({
              symbol: request.symbol,
              quantity: remaining,
              side,
              avgEntryPrice: request.limitPrice || 100,
              unrealizedPnl: 0,
            });
          }
        } else {
          // Partial close
          existing.quantity -= request.quantity;
        }
      }
    } else {
      // New position
      positions.push({
        symbol: request.symbol,
        quantity: request.quantity,
        side,
        avgEntryPrice: request.limitPrice || 100,
        unrealizedPnl: 0,
      });
    }
    
    this.mockPositions.set(account.id, positions);
  }
  
  // Helper method for testing - reset state
  resetState(): void {
    this.mockPositions.clear();
    this.mockOrders.clear();
    this.mockAccountInfo.clear();
    this.bracketOrders.clear();
  }
}
