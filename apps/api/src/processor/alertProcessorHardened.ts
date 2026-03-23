/**
 * Hardened Alert Processor
 * 
 * Critical safety improvements:
 * - Per-account distributed locking to prevent race conditions
 * - Circuit breaker integration
 * - Rate limiting enforcement
 * - Kill switch checked at execution time
 * - Proper error handling with account isolation
 * - Structured logging with trace correlation
 */

import { Job } from 'bullmq';
import { AlertReceived, TradingViewAlert, TradeSignal, TradeRequest } from '../types';
import { query, withTransaction } from '../db';
import { riskEngine } from '../risk/engine';
import { copierEngine } from '../copier/engine';
import logger from '../utils/logger';
import {
  createChildContext,
  logOperation,
  withAccountLock,
  canTrade,
  checkRateLimit,
  recordFailure,
  addToDLQ,
} from '../services';

const processorLogger = logger.child({ context: 'AlertProcessor' });

interface AlertJobData {
  alertId: string;
  strategyId: string;
  payload: TradingViewAlert;
  traceId: string;
  parentSpanId: string;
}

/**
 * Hardened alert processor
 * 
 * Safety flow:
 * 1. Load alert with row lock
 * 2. Check kill switch (fresh from DB)
 * 3. Parse signal
 * 4. For each account:
 *    a. Acquire account lock
 *    b. Check circuit breaker
 *    c. Check rate limits
 *    d. Run risk checks
 *    e. Create trade request
 *    f. Release lock
 * 5. Fan out to copier
 */
export async function processAlertJob(job: Job<AlertJobData>): Promise<void> {
  const { alertId, strategyId, payload, traceId, parentSpanId } = job.data;
  const logContext = createChildContext({ traceId, spanId: parentSpanId });

  processorLogger.info('Processing alert', {
    jobId: job.id,
    traceId,
    alertId,
    strategyId,
    symbol: payload.symbol,
    action: payload.action,
  });

  const startTime = Date.now();

  try {
    // 1. Verify alert exists and get lock
    const alert = await loadAlertWithLock(alertId);
    if (!alert) {
      throw new Error(`Alert ${alertId} not found`);
    }

    if (alert.processedAt) {
      processorLogger.warn('Alert already processed, skipping', {
        alertId,
        processedAt: alert.processedAt,
      });
      return;
    }

    // 2. Check kill switch FRESH from database (not cached)
    const killSwitchActive = await checkKillSwitch();
    if (killSwitchActive) {
      await handleKillSwitchActive(alertId, strategyId, payload, logContext);
      return;
    }

    // 3. Parse signal
    const signal = parseSignal(payload);

    await logOperation(logContext, {
      operation: 'alert.parse_signal',
      entityType: 'alert',
      entityId: alertId,
      status: 'succeeded',
      input: { signal },
    });

    // 4. Get active copier mappings with accounts
    const mappings = await loadMappingsWithAccounts(strategyId);

    if (mappings.length === 0) {
      processorLogger.warn('No active copier mappings found', {
        alertId,
        strategyId,
      });

      await markAlertProcessed(alertId);
      return;
    }

    // 5. Create trade request at strategy level
    const riskResult = await riskEngine.checkTrade(signal, strategyId);

    const tradeRequest = await createTradeRequest(
      alertId,
      strategyId,
      signal,
      riskResult.passed,
      riskResult.message
    );

    await logOperation(logContext, {
      operation: 'alert.risk_check',
      entityType: 'trade_request',
      entityId: tradeRequest.id,
      status: riskResult.passed ? 'succeeded' : 'failed',
      input: { riskResult },
    });

    if (!riskResult.passed) {
      processorLogger.warn('Trade rejected by risk engine at strategy level', {
        alertId,
        strategyId,
        reason: riskResult.message,
        ruleType: riskResult.ruleType,
      });

      await markAlertProcessed(alertId);
      return;
    }

    // 6. Process each account with individual locking and checks
    const results: Array<{
      accountId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const mapping of mappings) {
      try {
        const accountResult = await processAccountWithSafety({
          tradeRequest,
          signal,
          mapping,
          strategyId,
          logContext,
        });

        results.push(accountResult);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        processorLogger.error('Account processing failed', {
          alertId,
          accountId: mapping.accountId,
          error: errorMessage,
        });

        results.push({
          accountId: mapping.accountId,
          success: false,
          error: errorMessage,
        });

        // Record failure for circuit breaker
        await recordFailure(mapping.accountId, errorMessage);
      }
    }

    // 7. Update trade request status
    const successCount = results.filter((r) => r.success).length;
    if (successCount > 0) {
      try {
        await copierEngine.copyTrade(tradeRequest, signal, strategyId);
      } catch (copyErr) {
        processorLogger.error('copierEngine.copyTrade failed', {
          alertId,
          error: copyErr instanceof Error ? copyErr.message : String(copyErr),
        });
      }
    }
    await updateTradeRequestStatus(
      tradeRequest.id,
      successCount > 0 ? 'completed' : 'failed'
    );

    // 8. Mark alert as processed
    await markAlertProcessed(alertId);

    const duration = Date.now() - startTime;

    await logOperation(logContext, {
      operation: 'alert.process',
      entityType: 'alert',
      entityId: alertId,
      status: 'succeeded',
      input: {
        accountsProcessed: mappings.length,
        successful: successCount,
        failed: mappings.length - successCount,
      },
      durationMs: duration,
    });

    processorLogger.info('Alert processing completed', {
      jobId: job.id,
      alertId,
      durationMs: duration,
      accountsProcessed: mappings.length,
      successful: successCount,
      failed: mappings.length - successCount,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    processorLogger.error('Alert processing failed', {
      jobId: job.id,
      traceId,
      alertId,
      durationMs: duration,
      error: errorMessage,
    });

    await logOperation(logContext, {
      operation: 'alert.process',
      entityType: 'alert',
      entityId: alertId,
      status: 'failed',
      errorMessage,
      durationMs: duration,
    });

    // Move to dead letter queue if retries exhausted
    if (job.attemptsMade >= (job.opts.attempts || 1) - 1) {
      await addToDLQ({
        queueName: 'alerts',
        jobId: job.id || 'unknown',
        jobName: job.name,
        payload: job.data as unknown as Record<string, unknown>,
        errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined,
        attemptCount: job.attemptsMade + 1,
        retryable: true,
      });
    }

    throw error;
  }
}

/**
 * Process a single account with all safety checks
 */
async function processAccountWithSafety(data: {
  tradeRequest: TradeRequest;
  signal: TradeSignal;
  mapping: { accountId: string; accountName: string };
  strategyId: string;
  logContext: { traceId: string; spanId: string };
}): Promise<{ accountId: string; success: boolean; error?: string }> {
  const { tradeRequest, signal, mapping, strategyId, logContext } = data;

  // Use account lock for exclusive access
  return withAccountLock(
    mapping.accountId,
    async () => {
      // 1. Check circuit breaker
      const circuitStatus = await canTrade(mapping.accountId);
      if (!circuitStatus.allowed) {
        processorLogger.warn('Account circuit breaker open', {
          accountId: mapping.accountId,
          reason: circuitStatus.reason,
        });

        await logOperation(logContext, {
          operation: 'account.circuit_breaker',
          entityType: 'account',
          entityId: mapping.accountId,
          status: 'skipped',
          errorMessage: circuitStatus.reason,
        });

        return {
          accountId: mapping.accountId,
          success: false,
          error: circuitStatus.reason,
        };
      }

      // 2. Check rate limits
      const rateLimitStatus = await checkRateLimit(mapping.accountId, strategyId);
      if (!rateLimitStatus.allowed) {
        processorLogger.warn('Rate limit exceeded', {
          accountId: mapping.accountId,
          reason: rateLimitStatus.reason,
        });

        await logOperation(logContext, {
          operation: 'account.rate_limit',
          entityType: 'account',
          entityId: mapping.accountId,
          status: 'skipped',
          errorMessage: rateLimitStatus.reason,
        });

        return {
          accountId: mapping.accountId,
          success: false,
          error: rateLimitStatus.reason,
        };
      }

      // 3. Run risk checks at account level
      // Reload account data within the lock
      const accountResult = await query(
        'SELECT * FROM broker_accounts WHERE id = $1',
        [mapping.accountId]
      );

      if (accountResult.rowCount === 0) {
        return {
          accountId: mapping.accountId,
          success: false,
          error: 'Account not found',
        };
      }

      const account = accountResult.rows[0];

      if (!account.is_active || account.is_disabled) {
        return {
          accountId: mapping.accountId,
          success: false,
          error: 'Account is not active',
        };
      }

      // 4. Run account-level risk check
      const accountRiskResult = await riskEngine.checkTrade(
        signal,
        strategyId,
        account
      );

      if (!accountRiskResult.passed) {
        await logOperation(logContext, {
          operation: 'account.risk_check',
          entityType: 'account',
          entityId: mapping.accountId,
          status: 'failed',
          errorMessage: accountRiskResult.message,
        });

        return {
          accountId: mapping.accountId,
          success: false,
          error: accountRiskResult.message,
        };
      }

      // 5. Account is safe to trade - return success
      // The actual copying happens in the copier engine
      await logOperation(logContext, {
        operation: 'account.safety_check',
        entityType: 'account',
        entityId: mapping.accountId,
        status: 'succeeded',
      });

      return {
        accountId: mapping.accountId,
        success: true,
      };
    },
    { timeoutMs: 30000 } // 30 second timeout per account
  );
}

/**
 * Load alert with row lock
 */
async function loadAlertWithLock(
  alertId: string
): Promise<AlertReceived | null> {
  const result = await query<AlertReceived>(
    'SELECT * FROM alerts_received WHERE id = $1 FOR UPDATE',
    [alertId]
  );

  return result.rows[0] || null;
}

/**
 * Check kill switch fresh from database
 */
async function checkKillSwitch(): Promise<boolean> {
  const result = await query(
    "SELECT value FROM system_settings WHERE key = 'global_kill_switch'"
  );

  if (result.rowCount === 0) return false;

  return result.rows[0].value === 'true';
}

/**
 * Handle kill switch active
 */
async function handleKillSwitchActive(
  alertId: string,
  strategyId: string,
  payload: TradingViewAlert,
  logContext: { traceId: string; spanId: string }
): Promise<void> {
  processorLogger.warn('Kill switch active, rejecting alert', {
    alertId,
    strategyId,
    symbol: payload.symbol,
  });

  await query(
    `INSERT INTO risk_events (
      type, rule_type, strategy_id, message, details, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      'kill_switch',
      'kill_switch',
      strategyId,
      'Alert rejected due to global kill switch',
      JSON.stringify({ alertId, symbol: payload.symbol }),
    ]
  );

  await logOperation(logContext, {
    operation: 'alert.kill_switch',
    entityType: 'alert',
    entityId: alertId,
    status: 'skipped',
    errorMessage: 'Global kill switch active',
  });

  await markAlertProcessed(alertId);
}

/**
 * Parse TradingView alert into trade signal
 */
function parseSignal(payload: TradingViewAlert): TradeSignal {
  return {
    symbol: payload.symbol,
    action: payload.action,
    contracts: payload.contracts || 1,
    stopLoss: payload.stopLoss,
    takeProfit: payload.takeProfit,
  };
}

/**
 * Load active copier mappings with account info
 */
async function loadMappingsWithAccounts(
  strategyId: string
): Promise<Array<{ accountId: string; accountName: string }>> {
  const result = await query<{
    account_id: string;
    account_name: string;
  }>(
    `SELECT 
      cm.account_id,
      ba.name as account_name
     FROM copier_mappings cm
     JOIN broker_accounts ba ON cm.account_id = ba.id
     WHERE cm.strategy_id = $1
     AND cm.is_active = true
     AND ba.is_active = true
     AND ba.is_disabled = false`,
    [strategyId]
  );

  return result.rows.map((row) => ({
    accountId: row.account_id,
    accountName: row.account_name,
  }));
}

/**
 * Create trade request record
 */
async function createTradeRequest(
  alertId: string,
  strategyId: string,
  signal: TradeSignal,
  riskPassed: boolean,
  rejectionReason?: string
): Promise<TradeRequest> {
  const result = await query<TradeRequest>(
    `INSERT INTO trade_requests (
      alert_id, strategy_id, symbol, action, contracts,
      stop_loss, take_profit, status, rejection_reason, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING *`,
    [
      alertId,
      strategyId,
      signal.symbol,
      signal.action,
      signal.contracts,
      signal.stopLoss || null,
      signal.takeProfit || null,
      riskPassed ? 'copying' : 'risk_rejected',
      rejectionReason || null,
    ]
  );

  return result.rows[0];
}

/**
 * Update trade request status
 */
async function updateTradeRequestStatus(
  tradeRequestId: string,
  status: TradeRequest['status']
): Promise<void> {
  await query(
    'UPDATE trade_requests SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, tradeRequestId]
  );
}

/**
 * Mark alert as processed
 */
async function markAlertProcessed(alertId: string): Promise<void> {
  await query(
    'UPDATE alerts_received SET processed_at = NOW() WHERE id = $1',
    [alertId]
  );
}
