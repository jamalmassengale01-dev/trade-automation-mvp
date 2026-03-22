/**
 * Circuit Breaker Service
 * 
 * Prevents cascade failures by automatically disabling accounts
 * that experience repeated errors. Implements the standard
 * circuit breaker pattern: CLOSED → OPEN → HALF_OPEN → CLOSED
 */

import { query } from '../db';
import logger from '../utils/logger';

const circuitLogger = logger.child({ context: 'CircuitBreaker' });

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  resetTimeoutMs: number;        // Time before attempting half-open
  halfOpenMaxAttempts: number;   // Max attempts in half-open state
  successThreshold: number;      // Successes needed to close
}

// Default configuration
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,           // Open after 5 failures
  resetTimeoutMs: 60000,         // Try again after 1 minute
  halfOpenMaxAttempts: 3,        // 3 attempts in half-open
  successThreshold: 2,           // 2 successes to close
};

/**
 * Record a failure for an account
 * 
 * This increments the failure counter and may open the circuit.
 * Returns the current circuit state.
 */
export async function recordFailure(
  accountId: string,
  errorMessage: string,
  config: Partial<CircuitBreakerConfig> = {}
): Promise<CircuitState> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  try {
    // Get current state
    const currentResult = await query<{
      failure_count: number;
      state: CircuitState;
      opened_at: Date | null;
    }>(
      `SELECT failure_count, state, opened_at 
       FROM account_circuit_breakers 
       WHERE account_id = $1`,
      [accountId]
    );

    const current = currentResult.rows[0] || {
      failure_count: 0,
      state: 'closed' as CircuitState,
      opened_at: null,
    };

    // If already open, just update last failure
    if (current.state === 'open') {
      await query(
        `UPDATE account_circuit_breakers 
         SET failure_count = failure_count + 1,
             last_failure_at = NOW(),
             last_failure_reason = $2,
             updated_at = NOW()
         WHERE account_id = $1`,
        [accountId, errorMessage]
      );
      
      circuitLogger.warn('Circuit already open, failure recorded', {
        accountId,
        failureCount: current.failure_count + 1,
      });
      
      return 'open';
    }

    // Check if we should open the circuit
    const newFailureCount = current.failure_count + 1;
    const shouldOpen = newFailureCount >= cfg.failureThreshold;

    if (shouldOpen) {
      await query(
        `INSERT INTO account_circuit_breakers (
          account_id, failure_count, last_failure_at, last_failure_reason,
          state, opened_at, opened_reason, updated_at
        ) VALUES ($1, $2, NOW(), $3, 'open', NOW(), $4, NOW())
        ON CONFLICT (account_id) DO UPDATE SET
          failure_count = EXCLUDED.failure_count,
          last_failure_at = EXCLUDED.last_failure_at,
          last_failure_reason = EXCLUDED.last_failure_reason,
          state = EXCLUDED.state,
          opened_at = EXCLUDED.opened_at,
          opened_reason = EXCLUDED.opened_reason,
          half_open_attempts = 0,
          updated_at = NOW()`,
        [
          accountId,
          newFailureCount,
          errorMessage,
          `Failure threshold exceeded: ${newFailureCount} failures`,
        ]
      );

      circuitLogger.error('Circuit breaker OPENED', {
        accountId,
        failureCount: newFailureCount,
        threshold: cfg.failureThreshold,
        reason: errorMessage,
      });

      // Also disable the account
      await query(
        `UPDATE broker_accounts 
         SET is_disabled = true, updated_at = NOW() 
         WHERE id = $1`,
        [accountId]
      );

      return 'open';
    }

    // Just increment failure count
    await query(
      `INSERT INTO account_circuit_breakers (
        account_id, failure_count, last_failure_at, last_failure_reason, state, updated_at
      ) VALUES ($1, $2, NOW(), $3, 'closed', NOW())
      ON CONFLICT (account_id) DO UPDATE SET
        failure_count = EXCLUDED.failure_count,
        last_failure_at = EXCLUDED.last_failure_at,
        last_failure_reason = EXCLUDED.last_failure_reason,
        updated_at = NOW()`,
      [accountId, newFailureCount, errorMessage]
    );

    circuitLogger.warn('Failure recorded, circuit still closed', {
      accountId,
      failureCount: newFailureCount,
      threshold: cfg.failureThreshold,
    });

    return 'closed';
  } catch (error) {
    circuitLogger.error('Failed to record failure', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed - assume open if we can't determine state
    return 'open';
  }
}

/**
 * Record a success for an account
 * 
 * This may transition the circuit from half_open to closed.
 */
export async function recordSuccess(
  accountId: string,
  config: Partial<CircuitBreakerConfig> = {}
): Promise<CircuitState> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  try {
    const currentResult = await query<{
      state: CircuitState;
      half_open_attempts: number;
    }>(
      `SELECT state, half_open_attempts 
       FROM account_circuit_breakers 
       WHERE account_id = $1`,
      [accountId]
    );

    if (currentResult.rowCount === 0) {
      // No record, circuit is closed
      return 'closed';
    }

    const current = currentResult.rows[0];

    if (current.state === 'closed') {
      // Already closed, maybe reset failure count on sustained success
      return 'closed';
    }

    if (current.state === 'open') {
      // Check if enough time has passed to try half-open
      const openResult = await query<{
        opened_at: Date;
        failure_count: number;
      }>(
        'SELECT opened_at, failure_count FROM account_circuit_breakers WHERE account_id = $1',
        [accountId]
      );

      if (openResult.rowCount === 0) return 'open';

      const { opened_at, failure_count } = openResult.rows[0];
      const timeOpen = Date.now() - new Date(opened_at).getTime();

      if (timeOpen < cfg.resetTimeoutMs) {
        // Not enough time passed
        return 'open';
      }

      // Transition to half-open
      await query(
        `UPDATE account_circuit_breakers 
         SET state = 'half_open', 
             half_open_attempts = 1,
             updated_at = NOW()
         WHERE account_id = $1`,
        [accountId]
      );

      circuitLogger.info('Circuit breaker HALF_OPEN', {
        accountId,
        timeOpenMs: timeOpen,
      });

      return 'half_open';
    }

    if (current.state === 'half_open') {
      // Check if we have enough successes to close
      const newAttempts = current.half_open_attempts + 1;
      
      if (newAttempts >= cfg.successThreshold) {
        // Close the circuit
        await query(
          `UPDATE account_circuit_breakers 
           SET state = 'closed',
               failure_count = 0,
               half_open_attempts = 0,
               opened_at = NULL,
               opened_reason = NULL,
               updated_at = NOW()
           WHERE account_id = $1`,
          [accountId]
        );

        // Re-enable the account
        await query(
          `UPDATE broker_accounts 
           SET is_disabled = false, updated_at = NOW() 
           WHERE id = $1`,
          [accountId]
        );

        circuitLogger.info('Circuit breaker CLOSED', {
          accountId,
          successCount: newAttempts,
        });

        return 'closed';
      }

      // More attempts needed
      await query(
        `UPDATE account_circuit_breakers 
         SET half_open_attempts = $2,
             updated_at = NOW()
         WHERE account_id = $1`,
        [accountId, newAttempts]
      );

      circuitLogger.debug('Success in half-open, more attempts needed', {
        accountId,
        attempts: newAttempts,
        required: cfg.successThreshold,
      });

      return 'half_open';
    }

    return current.state;
  } catch (error) {
    circuitLogger.error('Failed to record success', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'open';
  }
}

/**
 * Get current circuit state for an account
 */
export async function getCircuitState(
  accountId: string
): Promise<CircuitState> {
  try {
    // First check if the account is disabled
    const accountResult = await query<{ is_disabled: boolean }>(
      'SELECT is_disabled FROM broker_accounts WHERE id = $1',
      [accountId]
    );

    if (accountResult.rowCount === 0) {
      return 'open'; // Account doesn't exist, treat as open
    }

    if (accountResult.rows[0].is_disabled) {
      // Check if we should try half-open
      const circuitResult = await query<{
        state: CircuitState;
        opened_at: Date;
      }>(
        'SELECT state, opened_at FROM account_circuit_breakers WHERE account_id = $1',
        [accountId]
      );

      if (circuitResult.rowCount === 0) {
        // Account disabled but no circuit record - manually disabled
        return 'open';
      }

      const { state, opened_at } = circuitResult.rows[0];
      
      if (state === 'open') {
        const timeOpen = Date.now() - new Date(opened_at).getTime();
        if (timeOpen >= DEFAULT_CONFIG.resetTimeoutMs) {
          return 'half_open';
        }
      }

      return state;
    }

    return 'closed';
  } catch (error) {
    circuitLogger.error('Failed to get circuit state', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'open';
  }
}

/**
 * Check if an account can trade
 */
export async function canTrade(accountId: string): Promise<{
  allowed: boolean;
  reason?: string;
  state: CircuitState;
}> {
  const state = await getCircuitState(accountId);

  if (state === 'open') {
    return {
      allowed: false,
      reason: 'Circuit breaker is open - account temporarily disabled due to repeated failures',
      state,
    };
  }

  if (state === 'half_open') {
    return {
      allowed: true,
      reason: 'Circuit breaker is half-open - testing account',
      state,
    };
  }

  return { allowed: true, state: 'closed' };
}

/**
 * Manually reset circuit breaker for an account
 */
export async function resetCircuit(accountId: string): Promise<void> {
  await query(
    `UPDATE account_circuit_breakers 
     SET state = 'closed',
         failure_count = 0,
         half_open_attempts = 0,
         opened_at = NULL,
         opened_reason = NULL,
         updated_at = NOW()
     WHERE account_id = $1`,
    [accountId]
  );

  await query(
    `UPDATE broker_accounts 
     SET is_disabled = false, updated_at = NOW() 
     WHERE id = $1`,
    [accountId]
  );

  circuitLogger.info('Circuit breaker manually reset', { accountId });
}

/**
 * Get all circuit breaker statuses
 */
export async function getAllCircuitStatuses(): Promise<
  Array<{
    accountId: string;
    accountName: string;
    state: CircuitState;
    failureCount: number;
    lastFailureAt?: Date;
    openedAt?: Date;
  }>
> {
  const result = await query<
    {
      account_id: string;
      account_name: string;
      state: CircuitState;
      failure_count: number;
      last_failure_at: Date;
      opened_at: Date;
    }
  >(`,
    `SELECT 
      cb.account_id,
      ba.name as account_name,
      cb.state,
      cb.failure_count,
      cb.last_failure_at,
      cb.opened_at
     FROM account_circuit_breakers cb
     JOIN broker_accounts ba ON cb.account_id = ba.id
     ORDER BY cb.state, cb.failure_count DESC`
  );

  return result.rows.map((row) => ({
    accountId: row.account_id,
    accountName: row.account_name,
    state: row.state,
    failureCount: row.failure_count,
    lastFailureAt: row.last_failure_at,
    openedAt: row.opened_at,
  }));
}
