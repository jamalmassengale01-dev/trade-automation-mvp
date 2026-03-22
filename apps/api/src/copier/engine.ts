import { v5 as uuidv5 } from 'uuid';
import {
  BrokerAccount,
  CopierMapping,
  TradeSignal,
  TradeRequest,
  OrderSubmitted,
  PlaceOrderRequest,
} from '../types';
import { query } from '../db';
import { orderQueue } from '../jobs/queues';
import { getBrokerAdapter } from '../brokers';
import logger from '../utils/logger';

const copierLogger = logger.child({ context: 'CopierEngine' });

// UUID namespace for deterministic order IDs
const ORDER_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Copier Engine
 * 
 * Takes a trade signal and fans it out to multiple follower accounts.
 * Each account can have its own sizing and filtering rules.
 * 
 * Key features:
 * - Isolated execution (one failure doesn't affect others)
 * - Per-account sizing (fixed or multiplier)
 * - Direction filtering (long-only, short-only)
 * - Symbol filtering
 * - Deterministic order IDs for idempotency
 */
export class CopierEngine {
  /**
   * Copy a trade signal to all configured accounts
   */
  async copyTrade(
    tradeRequest: TradeRequest,
    signal: TradeSignal,
    strategyId: string
  ): Promise<{ success: boolean; results: CopierResult[] }> {
    copierLogger.info('Starting trade copy', {
      tradeRequestId: tradeRequest.id,
      strategyId,
      symbol: signal.symbol,
      action: signal.action,
    });
    
    // Load active copier mappings
    const mappings = await this.loadMappings(strategyId);
    
    if (mappings.length === 0) {
      copierLogger.warn('No active copier mappings found', { strategyId });
      return { success: false, results: [] };
    }
    
    copierLogger.debug('Found copier mappings', { count: mappings.length });
    
    // Process each mapping
    const results: CopierResult[] = [];
    
    for (const mapping of mappings) {
      try {
        const result = await this.copyToAccount(
          tradeRequest,
          signal,
          mapping
        );
        results.push(result);
      } catch (error) {
        copierLogger.error('Failed to copy to account', {
          tradeRequestId: tradeRequest.id,
          accountId: mapping.account_id,
          error: error instanceof Error ? error.message : String(error),
        });
        
        results.push({
          accountId: mapping.account_id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    copierLogger.info('Trade copy completed', {
      tradeRequestId: tradeRequest.id,
      total: results.length,
      success: successCount,
      failed: results.length - successCount,
    });
    
    return {
      success: successCount > 0,
      results,
    };
  }
  
  /**
   * Copy trade to a single account
   */
  private async copyToAccount(
    tradeRequest: TradeRequest,
    signal: TradeSignal,
    mapping: CopierMapping
  ): Promise<CopierResult> {
    // Load account details
    const accountResult = await query<BrokerAccount>(
      'SELECT * FROM broker_accounts WHERE id = $1',
      [mapping.account_id]
    );
    
    if (accountResult.rowCount === 0) {
      throw new Error('Account not found');
    }
    
    const account = accountResult.rows[0];
    
    // Check if account is active
    if (!account.is_active || account.is_disabled) {
      throw new Error('Account is not active');
    }
    
    // Apply filters
    const filterResult = this.applyFilters(signal, mapping, account);
    if (!filterResult.allowed) {
      copierLogger.debug('Trade filtered for account', {
        tradeRequestId: tradeRequest.id,
        accountId: account.id,
        reason: filterResult.reason,
      });
      return {
        accountId: account.id,
        success: false,
        error: filterResult.reason,
      };
    }
    
    // Calculate position size
    const contracts = this.calculateSize(signal, mapping, account);
    if (contracts <= 0) {
      return {
        accountId: account.id,
        success: false,
        error: 'Calculated size is zero',
      };
    }
    
    // Determine order side
    const side = this.getOrderSide(signal.action);
    if (!side) {
      return {
        accountId: account.id,
        success: false,
        error: `Unsupported action: ${signal.action}`,
      };
    }
    
    // Create order request
    const orderRequest: PlaceOrderRequest = {
      symbol: signal.symbol,
      side,
      quantity: contracts,
      orderType: 'market',
      timeInForce: 'day',
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    };
    
    // Generate deterministic order ID
    const orderId = uuidv5(
      `${tradeRequest.id}-${account.id}`,
      ORDER_ID_NAMESPACE
    );
    
    // Persist order
    await this.persistOrder(tradeRequest.id, account.id, orderRequest, orderId);
    
    // Enqueue for execution
    await orderQueue.add('execute-order', {
      orderId,
      tradeRequestId: tradeRequest.id,
      accountId: account.id,
      orderRequest,
    }, {
      jobId: orderId,
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });
    
    copierLogger.debug('Order enqueued', {
      tradeRequestId: tradeRequest.id,
      accountId: account.id,
      orderId,
      symbol: orderRequest.symbol,
      side: orderRequest.side,
      quantity: orderRequest.quantity,
    });
    
    return {
      accountId: account.id,
      success: true,
      orderId,
    };
  }
  
  /**
   * Load active copier mappings for a strategy
   */
  private async loadMappings(strategyId: string): Promise<CopierMapping[]> {
    const result = await query<CopierMapping>(`
      SELECT cm.* FROM copier_mappings cm
      JOIN broker_accounts ba ON cm.account_id = ba.id
      WHERE cm.strategy_id = $1 
        AND cm.is_active = true
        AND ba.is_active = true
        AND ba.is_disabled = false
    `, [strategyId]);
    
    return result.rows;
  }
  
  /**
   * Apply account filters
   */
  private applyFilters(
    signal: TradeSignal,
    mapping: CopierMapping,
    account: BrokerAccount
  ): { allowed: boolean; reason?: string } {
    // Long-only filter
    if (mapping.long_only && signal.action === 'sell') {
      return { allowed: false, reason: 'Account is long-only' };
    }
    
    // Short-only filter
    if (mapping.short_only && signal.action === 'buy') {
      return { allowed: false, reason: 'Account is short-only' };
    }
    
    // Symbol filter
    if (
      mapping.allowed_symbols.length > 0 &&
      !mapping.allowed_symbols.includes(signal.symbol)
    ) {
      return {
        allowed: false,
        reason: `Symbol ${signal.symbol} not in allowed list`,
      };
    }
    
    return { allowed: true };
  }
  
  /**
   * Calculate position size
   */
  private calculateSize(
    signal: TradeSignal,
    mapping: CopierMapping,
    account: BrokerAccount
  ): number {
    // Use fixed size if configured
    if (mapping.fixed_size) {
      return Math.min(mapping.fixed_size, account.settings.maxContracts);
    }
    
    // Apply multiplier
    const baseSize = signal.contracts || 1;
    const multiplied = Math.floor(baseSize * mapping.multiplier);
    
    // Apply account limits
    const accountLimit = account.settings.maxContracts;
    return Math.min(multiplied, accountLimit);
  }
  
  /**
   * Get order side from action
   */
  private getOrderSide(
    action: TradeSignal['action']
  ): 'buy' | 'sell' | null {
    switch (action) {
      case 'buy':
        return 'buy';
      case 'sell':
        return 'sell';
      case 'close':
      case 'reverse':
        // These require position lookup - simplified for now
        return 'sell'; // Default, should check current position
      default:
        return null;
    }
  }
  
  /**
   * Persist order to database
   */
  private async persistOrder(
    tradeRequestId: string,
    accountId: string,
    orderRequest: PlaceOrderRequest,
    orderId: string
  ): Promise<void> {
    await query(
      `INSERT INTO orders_submitted (
        id, trade_request_id, account_id, symbol, side, quantity, 
        order_type, stop_loss, take_profit, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        orderId,
        tradeRequestId,
        accountId,
        orderRequest.symbol,
        orderRequest.side,
        orderRequest.quantity,
        orderRequest.orderType,
        orderRequest.stopLoss || null,
        orderRequest.takeProfit || null,
        'pending',
      ]
    );
  }
}

export interface CopierResult {
  accountId: string;
  success: boolean;
  orderId?: string;
  error?: string;
}

// Export singleton instance
export const copierEngine = new CopierEngine();
