/**
 * Rate Limiting Service
 * 
 * Enforces trading rate limits per account and strategy.
 * Tracks trades within time windows and rejects exceeding limits.
 */

import { query, withTransaction } from '../db';
import logger from '../utils/logger';

const rateLimitLogger = logger.child({ context: 'RateLimitService' });

export interface RateLimitConfig {
  maxTradesPerMinute: number;
  maxTradesPerHour: number;
  maxTradesPerDay: number;
}

// Default configuration
const DEFAULT_CONFIG: RateLimitConfig = {
  maxTradesPerMinute: 10,
  maxTradesPerHour: 100,
  maxTradesPerDay: 500,
};

export interface RateLimitStatus {
  allowed: boolean;
  reason?: string;
  currentMinute: number;
  currentHour: number;
  currentDay: number;
  limits: RateLimitConfig;
}

/**
 * Check if a trade is allowed based on rate limits
 * 
 * This is called before allowing a trade to proceed.
 */
export async function checkRateLimit(
  accountId: string,
  strategyId: string,
  config: Partial<RateLimitConfig> = {}
): Promise<RateLimitStatus> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date();

  try {
    // Calculate window start times
    const minuteWindowStart = new Date(now.getTime() - 60 * 1000);
    const hourWindowStart = new Date(now.getTime() - 60 * 60 * 1000);
    const dayWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Count trades in each window
    const [minuteCount, hourCount, dayCount] = await Promise.all([
      countTradesInWindow(accountId, strategyId, minuteWindowStart),
      countTradesInWindow(accountId, strategyId, hourWindowStart),
      countTradesInWindow(accountId, strategyId, dayWindowStart),
    ]);

    // Check limits
    if (minuteCount >= cfg.maxTradesPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${minuteCount}/${cfg.maxTradesPerMinute} trades per minute`,
        currentMinute: minuteCount,
        currentHour: hourCount,
        currentDay: dayCount,
        limits: cfg,
      };
    }

    if (hourCount >= cfg.maxTradesPerHour) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${hourCount}/${cfg.maxTradesPerHour} trades per hour`,
        currentMinute: minuteCount,
        currentHour: hourCount,
        currentDay: dayCount,
        limits: cfg,
      };
    }

    if (dayCount >= cfg.maxTradesPerDay) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${dayCount}/${cfg.maxTradesPerDay} trades per day`,
        currentMinute: minuteCount,
        currentHour: hourCount,
        currentDay: dayCount,
        limits: cfg,
      };
    }

    // Record the trade
    await recordTrade(accountId, strategyId, now);

    return {
      allowed: true,
      currentMinute: minuteCount + 1,
      currentHour: hourCount + 1,
      currentDay: dayCount + 1,
      limits: cfg,
    };
  } catch (error) {
    rateLimitLogger.error('Rate limit check failed', {
      accountId,
      strategyId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed - deny if we can't verify
    return {
      allowed: false,
      reason: 'Rate limit check failed',
      currentMinute: 0,
      currentHour: 0,
      currentDay: 0,
      limits: cfg,
    };
  }
}

/**
 * Count trades in a time window
 */
async function countTradesInWindow(
  accountId: string,
  strategyId: string,
  windowStart: Date
): Promise<number> {
  // Count from trade_requests
  const result = await query<{ count: number }>(
    `SELECT COUNT(*) as count 
     FROM trade_requests 
     WHERE strategy_id = $1 
     AND created_at > $2`,
    [strategyId, windowStart]
  );

  // Count from orders_submitted for this account
  const accountResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count 
     FROM orders_submitted 
     WHERE account_id = $1 
     AND created_at > $2`,
    [accountId, windowStart]
  );

  return Math.max(
    parseInt(result.rows[0].count as unknown as string, 10),
    parseInt(accountResult.rows[0].count as unknown as string, 10)
  );
}

/**
 * Record a trade in the rate limit tracking table
 */
async function recordTrade(
  accountId: string,
  strategyId: string,
  timestamp: Date
): Promise<void> {
  // Round to minute for window tracking
  const windowStart = new Date(
    Math.floor(timestamp.getTime() / 60000) * 60000
  );

  await query(
    `INSERT INTO rate_limit_windows (
      account_id, strategy_id, window_start, window_duration_seconds, trade_count, updated_at
    ) VALUES ($1, $2, $3, 60, 1, NOW())
    ON CONFLICT (account_id, strategy_id, window_start) 
    DO UPDATE SET 
      trade_count = rate_limit_windows.trade_count + 1,
      updated_at = NOW()`,
    [accountId, strategyId, windowStart]
  );
}

/**
 * Get current rate limit status without incrementing
 */
export async function getRateLimitStatus(
  accountId: string,
  strategyId: string,
  config: Partial<RateLimitConfig> = {}
): Promise<RateLimitStatus> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date();

  const minuteWindowStart = new Date(now.getTime() - 60 * 1000);
  const hourWindowStart = new Date(now.getTime() - 60 * 60 * 1000);
  const dayWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [minuteCount, hourCount, dayCount] = await Promise.all([
    countTradesInWindow(accountId, strategyId, minuteWindowStart),
    countTradesInWindow(accountId, strategyId, hourWindowStart),
    countTradesInWindow(accountId, strategyId, dayWindowStart),
  ]);

  return {
    allowed: true,
    currentMinute: minuteCount,
    currentHour: hourCount,
    currentDay: dayCount,
    limits: cfg,
  };
}

/**
 * Reset rate limit tracking for an account/strategy
 */
export async function resetRateLimits(
  accountId?: string,
  strategyId?: string
): Promise<void> {
  let sql = 'DELETE FROM rate_limit_windows WHERE 1=1';
  const params: (string | Date)[] = [];
  let paramIndex = 1;

  if (accountId) {
    sql += ` AND account_id = $${paramIndex++}`;
    params.push(accountId);
  }

  if (strategyId) {
    sql += ` AND strategy_id = $${paramIndex++}`;
    params.push(strategyId);
  }

  // Always keep last 24 hours of data for audit
  sql += ` AND window_start < $${paramIndex}`;
  params.push(new Date(Date.now() - 24 * 60 * 60 * 1000));

  await query(sql, params);

  rateLimitLogger.info('Rate limits reset', { accountId, strategyId });
}

/**
 * Check signal cooldown - prevent duplicate signals
 */
export async function checkSignalCooldown(
  strategyId: string,
  symbol: string,
  action: string,
  cooldownSeconds: number
): Promise<{ allowed: boolean; remainingSeconds?: number }> {
  const signalKey = `${symbol}:${action}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cooldownSeconds * 1000);

  try {
    const result = await query<{ created_at: Date }>(
      `INSERT INTO signal_cooldowns (
        strategy_id, symbol, action, signal_key, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (strategy_id, symbol, signal_key) 
      DO UPDATE SET 
        expires_at = EXCLUDED.expires_at,
        created_at = NOW()
        WHERE signal_cooldowns.expires_at < NOW()
      RETURNING created_at`,
      [strategyId, symbol, action, signalKey, expiresAt]
    );

    if (result.rowCount && result.rowCount > 0) {
      // Insert succeeded or updated expired cooldown
      return { allowed: true };
    }

    // Cooldown is active
    const existingResult = await query<{ expires_at: Date }>(
      `SELECT expires_at FROM signal_cooldowns 
       WHERE strategy_id = $1 AND symbol = $2 AND signal_key = $3`,
      [strategyId, symbol, signalKey]
    );

    if (existingResult.rowCount && existingResult.rowCount > 0) {
      const expiresAt = new Date(existingResult.rows[0].expires_at);
      const remainingSeconds = Math.ceil((expiresAt.getTime() - now.getTime()) / 1000);
      return { allowed: false, remainingSeconds };
    }

    return { allowed: true };
  } catch (error) {
    rateLimitLogger.error('Cooldown check failed', {
      strategyId,
      symbol,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail open - allow if we can't verify
    return { allowed: true };
  }
}
