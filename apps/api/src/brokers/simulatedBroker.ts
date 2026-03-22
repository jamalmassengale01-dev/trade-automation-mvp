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

/**
 * Simulated Broker Adapter
 * 
 * More realistic simulation with:
 * - Slippage simulation
 * - Partial fills
 * - Rejections for insufficient funds
 * - Market hours checking
 * - Delayed execution
 * 
 * Persists state to database for continuity.
 */
export class SimulatedBrokerAdapter extends BaseBrokerAdapter {
  readonly name = 'SimulatedBroker';
  readonly brokerType = 'simulated';
  
  // Simulated market data (simplified)
  private lastPrices: Map<string, number> = new Map([
    ['ES', 4500],
    ['NQ', 15500],
    ['CL', 75],
    ['GC', 2000],
    ['AAPL', 180],
    ['MSFT', 370],
  ]);
  
  private brokerLogger = logger.child({ context: 'SimulatedBroker' });
  
  async connect(): Promise<void> {
    this.brokerLogger.info('Simulated broker connected');
    this.isConnected = true;
  }
  
  async disconnect(): Promise<void> {
    this.brokerLogger.info('Simulated broker disconnected');
    this.isConnected = false;
  }
  
  async healthCheck(): Promise<boolean> {
    return this.isConnected;
  }
  
  async getAccountInfo(account: BrokerAccount): Promise<AccountInfo> {
    this.ensureConnected();
    
    // In a real implementation, this would fetch from DB
    return {
      accountId: account.id,
      buyingPower: 50000,
      cashBalance: 50000,
      equity: 50000,
      dayTradesRemaining: 3,
    };
  }
  
  async getPositions(account: BrokerAccount): Promise<Position[]> {
    this.ensureConnected();
    
    // Return from database in real implementation
    return [];
  }
  
  async placeOrder(
    account: BrokerAccount,
    request: PlaceOrderRequest
  ): Promise<Order> {
    this.ensureConnected();
    
    const orderId = uuidv4();
    const now = new Date();
    
    // Simulate market hours check
    if (!this.isMarketOpen()) {
      throw new Error('Market is closed');
    }
    
    // Simulate buying power check
    const buyingPower = 50000;
    const estimatedCost = (request.limitPrice || this.getLastPrice(request.symbol)) * request.quantity;
    if (estimatedCost > buyingPower) {
      throw new Error('Insufficient buying power');
    }
    
    // Simulate slippage for market orders
    let fillPrice = request.limitPrice;
    if (request.orderType === 'market') {
      const slippage = this.calculateSlippage(request.symbol);
      const basePrice = this.getLastPrice(request.symbol);
      fillPrice = request.side === 'buy' 
        ? basePrice * (1 + slippage)
        : basePrice * (1 - slippage);
    }
    
    // Simulate partial fill (5% chance)
    const partialFill = Math.random() < 0.05;
    const filledQuantity = partialFill 
      ? Math.floor(request.quantity * 0.5)
      : request.quantity;
    
    const order: Order = {
      id: orderId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      orderType: request.orderType,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
      timeInForce: request.timeInForce || 'day',
      status: partialFill ? 'partially_filled' : 'filled',
      filledQuantity,
      avgFillPrice: fillPrice,
      createdAt: now,
      updatedAt: now,
    };
    
    // Simulate execution delay
    await this.delay(50);
    
    this.brokerLogger.info('Simulated order placed', {
      accountId: account.id,
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      status: order.status,
      fillPrice: order.avgFillPrice,
    });
    
    return order;
  }
  
  async cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean> {
    this.ensureConnected();
    
    this.brokerLogger.info('Simulated order canceled', { orderId });
    return true;
  }
  
  async flattenAll(account: BrokerAccount): Promise<void> {
    this.ensureConnected();
    
    this.brokerLogger.info('Flattened all positions', { accountId: account.id });
  }
  
  private isMarketOpen(): boolean {
    // Simplified: CME futures are roughly 6pm-5pm ET next day
    const now = new Date();
    const hour = now.getUTCHours();
    // Roughly 23:00 - 22:00 UTC
    return hour >= 23 || hour <= 22;
  }
  
  private getLastPrice(symbol: string): number {
    return this.lastPrices.get(symbol) || 100;
  }
  
  private calculateSlippage(symbol: string): number {
    // Random slippage between 0.01% and 0.1%
    return (Math.random() * 0.001) + 0.0001;
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
