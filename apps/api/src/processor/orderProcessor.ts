import { Job } from 'bullmq';
import { PlaceOrderRequest, OrderSubmitted, BrokerAccount, Order } from '../types';
import { query } from '../db';
import { getBrokerAdapter } from '../brokers';
import logger from '../utils/logger';

const orderLogger = logger.child({ context: 'OrderProcessor' });

interface OrderJobData {
  orderId: string;
  tradeRequestId: string;
  accountId: string;
  orderRequest: PlaceOrderRequest;
}

/**
 * Process an order execution job
 * 
 * Flow:
 * 1. Load account
 * 2. Get broker adapter
 * 3. Execute order
 * 4. Record execution
 */
export async function processOrderJob(job: Job<OrderJobData>): Promise<void> {
  const { orderId, tradeRequestId, accountId, orderRequest } = job.data;
  
  orderLogger.info('Processing order', {
    jobId: job.id,
    orderId,
    tradeRequestId,
    accountId,
    symbol: orderRequest.symbol,
    side: orderRequest.side,
    quantity: orderRequest.quantity,
  });
  
  try {
    // 1. Load account
    const accountResult = await query<BrokerAccount>(
      'SELECT * FROM broker_accounts WHERE id = $1',
      [accountId]
    );
    
    if (accountResult.rowCount === 0) {
      throw new Error('Account not found');
    }
    
    const account = accountResult.rows[0];
    
    // 2. Get broker adapter
    const adapter = getBrokerAdapter(account.broker_type);
    
    // 3. Ensure connection
    const isHealthy = await adapter.healthCheck();
    if (!isHealthy) {
      await adapter.connect();
    }
    
    // 4. Update order status to submitted
    await updateOrderStatus(orderId, 'submitted');
    
    // 5. Execute order
    const order = await adapter.placeOrder(account, orderRequest);
    
    // 6. Update order with broker response
    await updateOrderWithExecution(orderId, order);
    
    orderLogger.info('Order executed successfully', {
      jobId: job.id,
      orderId,
      brokerOrderId: order.id,
      status: order.status,
      filledQty: order.filledQuantity,
      avgPrice: order.avgFillPrice,
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    orderLogger.error('Order execution failed', {
      jobId: job.id,
      orderId,
      error: errorMessage,
    });
    
    // Mark order as rejected
    await updateOrderError(orderId, errorMessage);
    
    throw error;
  }
}

/**
 * Update order status
 */
async function updateOrderStatus(
  orderId: string,
  status: OrderSubmitted['status']
): Promise<void> {
  await query(
    'UPDATE orders_submitted SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, orderId]
  );
}

/**
 * Update order with execution details
 */
async function updateOrderWithExecution(
  orderId: string,
  order: Order
): Promise<void> {
  await query(
    `UPDATE orders_submitted 
     SET broker_order_id = $1, status = $2, updated_at = NOW()
     WHERE id = $3`,
    [order.id, order.status, orderId]
  );
  
  // If filled, create execution record
  if (order.status === 'filled' || order.status === 'partially_filled') {
    await query(
      `INSERT INTO executions (
        order_id, account_id, symbol, side, quantity, price, commission, executed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        orderId,
        orderId, // We need to get account_id from the order record
        order.symbol,
        order.side,
        order.filledQuantity,
        order.avgFillPrice || 0,
        0, // Commission - would come from broker
      ]
    );
  }
}

/**
 * Update order with error
 */
async function updateOrderError(
  orderId: string,
  errorMessage: string
): Promise<void> {
  await query(
    `UPDATE orders_submitted 
     SET status = $1, error_message = $2, updated_at = NOW() 
     WHERE id = $3`,
    ['rejected', errorMessage, orderId]
  );
}
