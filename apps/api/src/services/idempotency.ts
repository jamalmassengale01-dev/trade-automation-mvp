/**
 * Idempotency Service
 * 
 * Provides robust idempotency guarantees using database-level constraints
 * and atomic operations to prevent duplicate processing.
 */

import crypto from 'crypto';
import { query, withTransaction } from '../db';
import logger from '../utils/logger';

const idempotencyLogger = logger.child({ context: 'IdempotencyService' });

export interface IdempotencyResult {
  isNew: boolean;
  entityId?: string;
  wasAlreadyProcessed: boolean;
}

/**
 * Generate a deterministic idempotency key from input data
 */
export function generateIdempotencyKey(
  entityType: string,
  ...components: (string | number | undefined)[]
): string {
  const keyData = components.filter(Boolean).join('|');
  return `${entityType}:${crypto.createHash('sha256').update(keyData).digest('hex')}`;
}

/**
 * Check and reserve an idempotency key atomically
 * 
 * Uses INSERT ... ON CONFLICT to guarantee atomicity.
 * Returns information about whether this is a new request.
 */
export async function checkAndReserveIdempotencyKey(
  key: string,
  entityType: string,
  expiresAt: Date,
  entityId?: string
): Promise<IdempotencyResult> {
  try {
    const result = await query<{
      key_hash: string;
      entity_id: string | null;
      is_new: boolean;
    }>(`
      WITH insert_attempt AS (
        INSERT INTO idempotency_keys (key_hash, entity_type, entity_id, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (key_hash) DO NOTHING
        RETURNING key_hash, entity_id, true as is_new
      ),
      existing AS (
        SELECT key_hash, entity_id, false as is_new
        FROM idempotency_keys
        WHERE key_hash = $1
      )
      SELECT * FROM insert_attempt
      UNION ALL
      SELECT * FROM existing
      LIMIT 1
    `, [key, entityType, entityId || null, expiresAt]);

    if (result.rowCount === 0) {
      // This shouldn't happen, but handle it
      idempotencyLogger.error('Unexpected empty result from idempotency check', { key });
      return { isNew: false, wasAlreadyProcessed: true };
    }

    const row = result.rows[0];
    return {
      isNew: row.is_new,
      entityId: row.entity_id || undefined,
      wasAlreadyProcessed: !row.is_new,
    };
  } catch (error) {
    idempotencyLogger.error('Idempotency check failed', {
      key,
      entityType,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Update idempotency key with the created entity ID
 */
export async function updateIdempotencyEntityId(
  key: string,
  entityId: string
): Promise<void> {
  await query(
    'UPDATE idempotency_keys SET entity_id = $1 WHERE key_hash = $2',
    [entityId, key]
  );
}

/**
 * Clean up expired idempotency keys
 */
export async function cleanupExpiredKeys(): Promise<number> {
  const result = await query(
    'DELETE FROM idempotency_keys WHERE expires_at < NOW()'
  );
  
  const count = result.rowCount || 0;
  if (count > 0) {
    idempotencyLogger.debug('Cleaned up expired idempotency keys', { count });
  }
  
  return count;
}

/**
 * Check if an alert has already been processed (for webhook handler)
 * 
 * This uses the alerts_received table directly for fast lookup
 * without requiring a separate idempotency key table lookup.
 */
export async function isAlertDuplicate(
  strategyId: string,
  alertId: string
): Promise<{ isDuplicate: boolean; existingAlertId?: string }> {
  const result = await query<{ id: string }>(
    'SELECT id FROM alerts_received WHERE strategy_id = $1 AND alert_id = $2 LIMIT 1',
    [strategyId, alertId]
  );

  if (result.rowCount && result.rowCount > 0) {
    return {
      isDuplicate: true,
      existingAlertId: result.rows[0].id,
    };
  }

  return { isDuplicate: false };
}

/**
 * Atomic insert of alert with duplicate detection
 * 
 * This uses INSERT ... ON CONFLICT to guarantee only one alert is recorded.
 * Returns the alert record and whether it was newly created.
 */
export async function insertAlertAtomic(
  data: {
    strategyId: string;
    alertId: string;
    rawPayload: Record<string, unknown>;
    isValid: boolean;
    validationError?: string;
    isDuplicate: boolean;
  }
): Promise<{ alert: Record<string, unknown>; isNew: boolean }> {
  return withTransaction(async (client) => {
    // Try to insert - if duplicate, the unique constraint will catch it
    const insertResult = await client.query<
      { id: string; is_new: boolean }
    >(
    `INSERT INTO alerts_received (
        strategy_id, alert_id, raw_payload, is_valid,
        validation_error, is_duplicate, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (strategy_id, alert_id) DO NOTHING
      RETURNING id, true as is_new`,
      [
        data.strategyId,
        data.alertId,
        JSON.stringify(data.rawPayload),
        data.isValid,
        data.validationError || null,
        data.isDuplicate,
      ]
    );

    if (insertResult.rowCount && insertResult.rowCount > 0) {
      // New alert inserted
      const alertResult = await client.query(
        'SELECT * FROM alerts_received WHERE id = $1',
        [insertResult.rows[0].id]
      );
      
      return {
        alert: alertResult.rows[0],
        isNew: true,
      };
    }

    // Alert already exists - fetch it
    const existingResult = await client.query<
      Record<string, unknown>
    >(
    `SELECT * FROM alerts_received 
       WHERE strategy_id = $1 AND alert_id = $2 
       LIMIT 1`,
      [data.strategyId, data.alertId]
    );

    return {
      alert: existingResult.rows[0],
      isNew: false,
    };
  });
}

/**
 * Create a unique execution key for order deduplication
 */
export function createOrderExecutionKey(
  tradeRequestId: string,
  accountId: string,
  symbol: string,
  side: string
): string {
  return generateIdempotencyKey(
    'order',
    tradeRequestId,
    accountId,
    symbol,
    side
  );
}

/**
 * Reserve an order execution slot
 * 
 * Returns true if this is a new order, false if already exists.
 */
export async function reserveOrderExecution(
  tradeRequestId: string,
  accountId: string,
  symbol: string,
  side: string,
  orderId: string
): Promise<boolean> {
  const key = createOrderExecutionKey(tradeRequestId, accountId, symbol, side);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const result = await checkAndReserveIdempotencyKey(key, 'order', expiresAt, orderId);
  
  return result.isNew;
}
