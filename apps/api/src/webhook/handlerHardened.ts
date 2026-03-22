/**
 * Hardened Webhook Handler
 * 
 * Critical safety improvements:
 * - Atomic duplicate detection using INSERT ... ON CONFLICT
 * - Database-level unique constraint on (strategy_id, alert_id)
 * - Proper idempotency key handling
 * - Structured logging with trace IDs
 * - Signal cooldown enforcement
 * - Rate limiting at the webhook level
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { validateAlert } from './schema';
import { AlertReceived, TradingViewAlert } from '../types';
import { query } from '../db';
import { alertQueue } from '../jobs/queues';
import config from '../config';
import logger from '../utils/logger';
import {
  generateTraceId,
  generateSpanId,
  logOperation,
  isAlertDuplicate,
  insertAlertAtomic,
  checkSignalCooldown,
} from '../services';

const webhookLogger = logger.child({ context: 'WebhookHandler' });

/**
 * Hardened Webhook Handler for TradingView alerts
 * 
 * Safety guarantees:
 * 1. Duplicate alerts are detected atomically at the database level
 * 2. Each alert gets a unique trace ID for end-to-end tracking
 * 3. Signal cooldown prevents duplicate signals
 * 4. All operations are logged with correlation IDs
 */
export async function handleTradingViewWebhook(
  req: Request,
  res: Response
): Promise<void> {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  const traceId = generateTraceId();
  const spanId = generateSpanId();

  // Create logging context
  const logContext = { traceId, spanId };

  webhookLogger.debug('Webhook received', {
    requestId,
    traceId,
    ip: req.ip,
    contentType: req.headers['content-type'],
  });

  try {
    // 1. Validate shared secret
    const providedSecret = req.headers['x-webhook-secret'] as string;
    if (!providedSecret || providedSecret !== config.webhook.secret) {
      webhookLogger.warn('Invalid webhook secret', {
        requestId,
        traceId,
        ip: req.ip,
        provided: providedSecret ? 'present' : 'missing',
      });

      await logOperation(logContext, {
        operation: 'webhook.auth',
        status: 'failed',
        errorMessage: 'Invalid or missing webhook secret',
      });

      res.status(401).json({
        success: false,
        error: 'Invalid or missing webhook secret',
      });
      return;
    }

    // 2. Validate payload schema
    const validation = validateAlert(req.body);
    if (!validation.success) {
      webhookLogger.warn('Invalid webhook payload', {
        requestId,
        traceId,
        error: validation.error,
      });

      await logOperation(logContext, {
        operation: 'webhook.validation',
        status: 'failed',
        errorMessage: validation.error,
      });

      // Persist invalid alert for audit
      await persistInvalidAlert({
        requestId,
        rawPayload: req.body as TradingViewAlert,
        validationError: validation.error,
      });

      res.status(400).json({
        success: false,
        error: 'Invalid payload: ' + validation.error,
      });
      return;
    }

    const alert = validation.data!;

    // 3. Find strategy by webhook secret
    const strategyResult = await query(
      'SELECT id FROM strategies WHERE webhook_secret = $1 AND is_active = true',
      [config.webhook.secret]
    );

    if (strategyResult.rowCount === 0) {
      webhookLogger.warn('No active strategy found for webhook', {
        requestId,
        traceId,
      });

      await logOperation(logContext, {
        operation: 'webhook.strategy_lookup',
        status: 'failed',
        errorMessage: 'Strategy not found or inactive',
      });

      res.status(404).json({
        success: false,
        error: 'Strategy not found or inactive',
      });
      return;
    }

    const strategyId = strategyResult.rows[0].id;

    // 4. Check global kill switch FIRST (before any processing)
    if (config.features.globalKillSwitch) {
      webhookLogger.warn('Global kill switch is active, rejecting alert', {
        requestId,
        traceId,
        alertId: alert.id,
      });

      await persistAlertWithKillSwitch({
        strategyId,
        alert,
        requestId,
        logContext,
      });

      res.status(503).json({
        success: false,
        error: 'Trading is globally disabled (kill switch active)',
        alertId: alert.id,
      });
      return;
    }

    // 5. Check signal cooldown (prevent duplicate signals within window)
    const cooldownResult = await checkSignalCooldown(
      strategyId,
      alert.symbol,
      alert.action,
      30 // 30 second cooldown
    );

    if (!cooldownResult.allowed) {
      webhookLogger.info('Signal in cooldown period', {
        requestId,
        traceId,
        alertId: alert.id,
        symbol: alert.symbol,
        action: alert.action,
        remainingSeconds: cooldownResult.remainingSeconds,
      });

      // Still acknowledge but don't process
      res.status(200).json({
        success: true,
        message: 'Signal in cooldown period',
        alertId: alert.id,
        cooldownRemaining: cooldownResult.remainingSeconds,
        processed: false,
      });
      return;
    }

    // 6. ATOMIC duplicate check and insert
    // This uses INSERT ... ON CONFLICT to guarantee atomicity
    const { alert: alertRecord, isNew } = await insertAlertAtomic({
      strategyId,
      alertId: alert.id,
      rawPayload: alert as unknown as Record<string, unknown>,
      isValid: true,
      isDuplicate: false,
    });

    if (!isNew) {
      // This is a duplicate - alert already exists
      webhookLogger.info('Duplicate alert detected and ignored', {
        requestId,
        traceId,
        alertId: alert.id,
        existingAlertId: alertRecord.id,
      });

      await logOperation(logContext, {
        operation: 'webhook.duplicate_check',
        entityType: 'alert',
        entityId: alertRecord.id as string,
        status: 'skipped',
      });

      res.status(200).json({
        success: true,
        message: 'Duplicate alert acknowledged',
        alertId: alert.id,
        processed: false,
        duplicate: true,
      });
      return;
    }

    // 7. Log the successful receipt
    await logOperation(logContext, {
      operation: 'webhook.received',
      entityType: 'alert',
      entityId: alertRecord.id as string,
      status: 'succeeded',
      input: {
        alertId: alert.id,
        symbol: alert.symbol,
        action: alert.action,
        strategyId,
      },
    });

    // 8. Enqueue for processing
    await alertQueue.add(
      'process-alert',
      {
        alertId: alertRecord.id,
        strategyId,
        payload: alert,
        traceId, // Pass trace ID for correlation
        parentSpanId: spanId,
      },
      {
        jobId: `alert-${alert.id}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }
    );

    const duration = Date.now() - startTime;

    webhookLogger.info('Alert enqueued for processing', {
      requestId,
      traceId,
      alertId: alert.id,
      alertRecordId: alertRecord.id,
      strategyId,
      symbol: alert.symbol,
      action: alert.action,
      durationMs: duration,
    });

    // 9. Respond quickly
    res.status(200).json({
      success: true,
      message: 'Alert accepted',
      alertId: alert.id,
      traceId,
      processed: true,
      durationMs: duration,
    });

    webhookLogger.debug('Webhook handled successfully', {
      requestId,
      traceId,
      durationMs: duration,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    webhookLogger.error('Webhook handling failed', {
      requestId,
      traceId,
      durationMs: duration,
      error: errorMessage,
    });

    await logOperation(logContext, {
      operation: 'webhook',
      status: 'failed',
      errorMessage,
      durationMs: duration,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      traceId,
    });
  }
}

/**
 * Persist invalid alert for audit
 */
async function persistInvalidAlert(data: {
  requestId: string;
  rawPayload: TradingViewAlert;
  validationError: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO alerts_received (
        strategy_id, alert_id, raw_payload, is_valid, validation_error, is_duplicate, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        null, // No strategy for invalid alerts
        data.rawPayload.id || 'unknown',
        JSON.stringify(data.rawPayload),
        false,
        data.validationError,
        false,
      ]
    );
  } catch (error) {
    webhookLogger.error('Failed to persist invalid alert', {
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Persist alert when kill switch is active
 */
async function persistAlertWithKillSwitch(data: {
  strategyId: string;
  alert: TradingViewAlert;
  requestId: string;
  logContext: { traceId: string; spanId: string };
}): Promise<void> {
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO alerts_received (
        strategy_id, alert_id, raw_payload, is_valid, is_duplicate, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id`,
      [
        data.strategyId,
        data.alert.id,
        JSON.stringify(data.alert),
        true,
        false,
      ]
    );

    // Log risk event for kill switch
    await query(
      `INSERT INTO risk_events (
        type, rule_type, strategy_id, message, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        'kill_switch',
        'kill_switch',
        data.strategyId,
        'Alert rejected due to global kill switch',
        JSON.stringify({
          alertId: data.alert.id,
          symbol: data.alert.symbol,
          action: data.alert.action,
        }),
      ]
    );

    await logOperation(data.logContext, {
      operation: 'webhook.kill_switch',
      entityType: 'alert',
      entityId: result.rows[0].id,
      status: 'skipped',
      errorMessage: 'Global kill switch active',
    });
  } catch (error) {
    webhookLogger.error('Failed to persist kill switch alert', {
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
