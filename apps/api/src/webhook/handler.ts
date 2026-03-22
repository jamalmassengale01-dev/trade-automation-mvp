import { Request, Response } from 'express';
import crypto from 'crypto';
import { validateAlert } from './schema';
import { AlertReceived, TradingViewAlert } from '../types';
import { query } from '../db';
import { alertQueue } from '../jobs/queues';
import config from '../config';
import logger from '../utils/logger';

const webhookLogger = logger.child({ context: 'WebhookHandler' });

/**
 * Webhook handler for TradingView alerts
 * 
 * Flow:
 * 1. Validate shared secret
 * 2. Validate payload schema
 * 3. Check idempotency (prevent duplicates)
 * 4. Persist raw alert
 * 5. Enqueue for processing
 */
export async function handleTradingViewWebhook(
  req: Request,
  res: Response
): Promise<void> {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  
  webhookLogger.debug('Webhook received', {
    requestId,
    ip: req.ip,
    contentType: req.headers['content-type'],
  });
  
  try {
    // 1. Validate shared secret
    const providedSecret = req.headers['x-webhook-secret'] as string;
    if (!providedSecret || providedSecret !== config.webhook.secret) {
      webhookLogger.warn('Invalid webhook secret', {
        requestId,
        ip: req.ip,
        provided: providedSecret ? 'present' : 'missing',
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
        error: validation.error,
      });
      
      // Persist invalid alert for audit
      await persistAlert({
        strategyId: '',
        alertId: req.body?.id || 'unknown',
        rawPayload: req.body as TradingViewAlert,
        isValid: false,
        validationError: validation.error,
        isDuplicate: false,
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
      webhookLogger.warn('No active strategy found for webhook', { requestId });
      res.status(404).json({
        success: false,
        error: 'Strategy not found or inactive',
      });
      return;
    }
    
    const strategyId = strategyResult.rows[0].id;
    
    // 4. Check idempotency
    const duplicateCheck = await query(
      'SELECT id FROM alerts_received WHERE alert_id = $1 LIMIT 1',
      [alert.id]
    );
    
    const isDuplicate = duplicateCheck.rowCount !== null && duplicateCheck.rowCount > 0;
    
    if (isDuplicate) {
      webhookLogger.info('Duplicate alert detected', {
        requestId,
        alertId: alert.id,
      });
    }
    
    // 5. Persist alert
    const alertRecord = await persistAlert({
      strategyId,
      alertId: alert.id,
      rawPayload: alert as TradingViewAlert,
      isValid: true,
      isDuplicate,
    });
    
    // 6. Enqueue for processing (if not duplicate)
    if (!isDuplicate) {
      await alertQueue.add('process-alert', {
        alertId: alertRecord.id,
        strategyId,
        payload: alert,
      }, {
        jobId: `alert-${alert.id}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      });
      
      webhookLogger.info('Alert enqueued for processing', {
        requestId,
        alertId: alert.id,
        strategyId,
        symbol: alert.symbol,
        action: alert.action,
      });
    }
    
    // 7. Respond quickly
    const duration = Date.now() - startTime;
    res.status(200).json({
      success: true,
      message: isDuplicate ? 'Duplicate alert acknowledged' : 'Alert accepted',
      alertId: alert.id,
      processed: !isDuplicate,
      durationMs: duration,
    });
    
    webhookLogger.debug('Webhook handled successfully', {
      requestId,
      durationMs: duration,
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    webhookLogger.error('Webhook handling failed', {
      requestId,
      durationMs: duration,
      error: error instanceof Error ? error.message : String(error),
    });
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * Persist alert to database
 */
async function persistAlert(data: {
  strategyId: string;
  alertId: string;
  rawPayload: TradingViewAlert;
  isValid: boolean;
  validationError?: string;
  isDuplicate: boolean;
}): Promise<AlertReceived> {
  const result = await query<AlertReceived>(`
    INSERT INTO alerts_received (
      strategy_id, alert_id, raw_payload, is_valid, 
      validation_error, is_duplicate, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING *
  `, [
    data.strategyId,
    data.alertId,
    JSON.stringify(data.rawPayload),
    data.isValid,
    data.validationError || null,
    data.isDuplicate,
  ]);
  
  return result.rows[0];
}
