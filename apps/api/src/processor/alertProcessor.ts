import { Job } from 'bullmq';
import { AlertReceived, TradingViewAlert, TradeSignal, TradeRequest } from '../types';
import { query } from '../db';
import { riskEngine } from '../risk/engine';
import { copierEngine } from '../copier/engine';
import logger from '../utils/logger';

const processorLogger = logger.child({ context: 'AlertProcessor' });

interface AlertJobData {
  alertId: string;
  strategyId: string;
  payload: TradingViewAlert;
}

/**
 * Process an alert from TradingView
 * 
 * Flow:
 * 1. Parse alert into trade signal
 * 2. Run risk checks
 * 3. Create trade request
 * 4. Fan out to copier engine
 */
export async function processAlertJob(job: Job<AlertJobData>): Promise<void> {
  const { alertId, strategyId, payload } = job.data;
  
  processorLogger.info('Processing alert', {
    jobId: job.id,
    alertId,
    strategyId,
    symbol: payload.symbol,
    action: payload.action,
  });
  
  try {
    // 1. Parse signal
    const signal = parseSignal(payload);
    
    // 2. Run risk checks at strategy level
    const riskResult = await riskEngine.checkTrade(signal, strategyId);
    
    // 3. Create trade request
    const tradeRequest = await createTradeRequest(
      alertId,
      strategyId,
      signal,
      riskResult.passed,
      riskResult.message
    );
    
    if (!riskResult.passed) {
      processorLogger.warn('Trade rejected by risk engine', {
        alertId,
        strategyId,
        reason: riskResult.message,
        ruleType: riskResult.ruleType,
      });
      return;
    }
    
    // 4. Copy to follower accounts
    const copyResult = await copierEngine.copyTrade(
      tradeRequest,
      signal,
      strategyId
    );
    
    // 5. Update trade request status
    await updateTradeRequestStatus(
      tradeRequest.id,
      copyResult.success ? 'completed' : 'failed'
    );
    
    // 6. Mark alert as processed
    await markAlertProcessed(alertId);
    
    processorLogger.info('Alert processing completed', {
      jobId: job.id,
      alertId,
      copiedTo: copyResult.results.length,
      successful: copyResult.results.filter(r => r.success).length,
    });
    
  } catch (error) {
    processorLogger.error('Alert processing failed', {
      jobId: job.id,
      alertId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
 * Create trade request record
 */
async function createTradeRequest(
  alertId: string,
  strategyId: string,
  signal: TradeSignal,
  riskPassed: boolean,
  rejectionReason?: string
): Promise<TradeRequest> {
  const result = await query<TradeRequest>(`
    INSERT INTO trade_requests (
      alert_id, strategy_id, symbol, action, contracts,
      stop_loss, take_profit, status, rejection_reason, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING *
  `, [
    alertId,
    strategyId,
    signal.symbol,
    signal.action,
    signal.contracts,
    signal.stopLoss || null,
    signal.takeProfit || null,
    riskPassed ? 'copying' : 'risk_rejected',
    rejectionReason || null,
  ]);
  
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
