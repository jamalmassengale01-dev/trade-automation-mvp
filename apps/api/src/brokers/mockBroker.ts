import { v4 as uuidv4 } from 'uuid';
import { BaseBrokerAdapter } from './interface';
import {
  BrokerAccount,
  AccountInfo,
  Position,
  Order,
  PlaceOrderRequest,
  OrderStatus,
} from '../types';
import logger from '../utils/logger';

/**
 * Mock Broker Adapter
 * 
 * Simulates broker behavior for development and testing.
 * Stores state in memory only - resets on restart.
 */
export class MockBrokerAdapter extends BaseBrokerAdapter {
  readonly name = 'MockBroker';
  readonly brokerType = 'mock';
  
  // In-memory state
  private mockPositions: Map<string, Position[]> = new Map();
  private mockOrders: Map<string, Order[]> = new Map();
  private mockAccountInfo: Map<string, AccountInfo> = new Map();
  
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
      accountId: account.id,
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
    
    const orders = this.mockOrders.get(account.id) || [];
    const order = orders.find(o => o.id === orderId);
    
    if (!order) return false;
    
    order.status = 'canceled';
    order.updatedAt = new Date();
    
    this.brokerLogger.info('Mock order canceled', { orderId });
    return true;
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
  }
}
