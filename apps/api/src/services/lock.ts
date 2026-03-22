/**
 * Distributed Lock Service
 * 
 * Provides per-account and per-symbol locking to prevent race conditions
 * when multiple alerts hit the same account simultaneously.
 * 
 * Uses PostgreSQL advisory locks for true atomicity.
 */

import { PoolClient } from 'pg';
import { pool, query, withTransaction } from '../db';
import logger from '../utils/logger';

const lockLogger = logger.child({ context: 'LockService' });

// Lock types
export type LockType = 'account' | 'symbol' | 'strategy';

/**
 * Generate a lock ID from lock type and resource ID
 * Uses 64-bit integer hash for PostgreSQL advisory locks
 */
function generateLockId(lockType: LockType, resourceId: string): number {
  // Simple hash function for demonstration
  // In production, use a more robust hash
  const str = `${lockType}:${resourceId}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  // Convert to positive 64-bit integer range
  return Math.abs(hash) % 9007199254740991;
}

/**
 * Acquire an advisory lock
 * 
 * Returns true if lock was acquired, false otherwise.
 */
export async function acquireLock(
  client: PoolClient,
  lockType: LockType,
  resourceId: string,
  wait = false
): Promise<boolean> {
  const lockId = generateLockId(lockType, resourceId);

  try {
    if (wait) {
      // Block until lock is available
      await client.query('SELECT pg_advisory_lock($1)', [lockId]);
      return true;
    } else {
      // Try to acquire immediately, return false if not available
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [lockId]
      );
      return result.rows[0].acquired;
    }
  } catch (error) {
    lockLogger.error('Failed to acquire lock', {
      lockType,
      resourceId,
      lockId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Release an advisory lock
 */
export async function releaseLock(
  client: PoolClient,
  lockType: LockType,
  resourceId: string
): Promise<void> {
  const lockId = generateLockId(lockType, resourceId);

  try {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
  } catch (error) {
    lockLogger.error('Failed to release lock', {
      lockType,
      resourceId,
      lockId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Execute a function with a lock
 * 
 * Automatically acquires and releases the lock around the callback.
 */
export async function withLock<T>(
  lockType: LockType,
  resourceId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { wait?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const { wait = true, timeoutMs } = options;

  return withTransaction(async (client) => {
    const acquired = await acquireLock(client, lockType, resourceId, wait);

    if (!acquired) {
      throw new Error(
        `Could not acquire ${lockType} lock for ${resourceId}`
      );
    }

    try {
      // Set statement timeout if specified
      if (timeoutMs) {
        await client.query('SET LOCAL statement_timeout = $1', [timeoutMs]);
      }

      return await fn(client);
    } finally {
      await releaseLock(client, lockType, resourceId);
    }
  });
}

/**
 * Acquire multiple locks in a consistent order to prevent deadlocks
 */
export async function withMultiLock<T>(
  locks: Array<{ type: LockType; resourceId: string }>,
  fn: (client: PoolClient) => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  // Sort locks by lockId to ensure consistent ordering
  const sortedLocks = locks
    .map((lock) => ({
      ...lock,
      lockId: generateLockId(lock.type, lock.resourceId),
    }))
    .sort((a, b) => a.lockId - b.lockId);

  return withTransaction(async (client) => {
    // Acquire all locks
    for (const lock of sortedLocks) {
      const acquired = await acquireLock(
        client,
        lock.type,
        lock.resourceId,
        true
      );
      if (!acquired) {
        throw new Error(
          `Could not acquire ${lock.type} lock for ${lock.resourceId}`
        );
      }
    }

    try {
      if (options.timeoutMs) {
        await client.query('SET LOCAL statement_timeout = $1', [
          options.timeoutMs,
        ]);
      }

      return await fn(client);
    } finally {
      // Release in reverse order
      for (const lock of sortedLocks.reverse()) {
        await releaseLock(client, lock.type, lock.resourceId);
      }
    }
  });
}

/**
 * Check if a lock is currently held
 */
export async function isLockHeld(
  lockType: LockType,
  resourceId: string
): Promise<boolean> {
  const lockId = generateLockId(lockType, resourceId);

  const result = await query<{ held: boolean }>(
    'SELECT pg_try_advisory_lock($1) as held',
    [lockId]
  );

  const held = result.rows[0].held;

  if (held) {
    // We acquired it, so release it immediately
    await query('SELECT pg_advisory_unlock($1)', [lockId]);
    return false;
  }

  return true;
}

/**
 * Get all currently held locks (requires pg_locks view access)
 */
export async function getHeldLocks(): Promise<
  Array<{
    lockType: string;
    lockId: number;
    pid: number;
    mode: string;
  }>
> {
  const result = await query<{
    locktype: string;
    objid: number;
    pid: number;
    mode: string;
  }>(`,
    `SELECT locktype, objid, pid, mode 
     FROM pg_locks 
     WHERE locktype = 'advisory' 
     AND granted = true`
  );

  return result.rows.map((row) => ({
    lockType: row.locktype,
    lockId: row.objid,
    pid: row.pid,
    mode: row.mode,
  }));
}

/**
 * Emergency release all locks for current session
 */
export async function releaseAllLocks(): Promise<void> {
  await query('SELECT pg_advisory_unlock_all()');
  lockLogger.warn('All advisory locks released');
}

// ============================================
// Application-Level Locking Primitives
// ============================================

/**
 * Lock an account for exclusive access during trade processing
 */
export async function withAccountLock<T>(
  accountId: string,
  fn: (client: PoolClient) => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T> {
  return withLock('account', accountId, fn, options);
}

/**
 * Lock a symbol for exclusive access
 */
export async function withSymbolLock<T>(
  symbol: string,
  fn: (client: PoolClient) => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T> {
  return withLock('symbol', symbol, fn, options);
}

/**
 * Lock a strategy for exclusive access
 */
export async function withStrategyLock<T>(
  strategyId: string,
  fn: (client: PoolClient) => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T> {
  return withLock('strategy', strategyId, fn, options);
}

/**
 * Lock multiple accounts in consistent order
 */
export async function withMultiAccountLock<T>(
  accountIds: string[],
  fn: (client: PoolClient) => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T> {
  const locks = accountIds.map((id) => ({ type: 'account' as LockType, resourceId: id }));
  return withMultiLock(locks, fn, options);
}
