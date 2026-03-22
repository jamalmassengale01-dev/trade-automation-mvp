/**
 * Broker Reconciliation Service
 * 
 * Periodically syncs system state with broker state.
 * Treats the broker as the source of truth and auto-corrects mismatches.
 */

import { query } from '../db';
import { getBrokerAdapter } from '../brokers';
import { BrokerAccount, Position } from '../types';
import logger from '../utils/logger';

const reconLogger = logger.child({ context: 'ReconciliationService' });

export interface ReconciliationResult {
  accountId: string;
  accountName: string;
  status: 'success' | 'failed';
  discrepanciesFound: number;
  discrepanciesResolved: number;
  positionsFromBroker: number;
  positionsInSystem: number;
  errors: string[];
}

export interface PositionDiscrepancy {
  symbol: string;
  brokerSide: 'long' | 'short' | 'flat';
  brokerQuantity: number;
  systemSide: 'long' | 'short' | 'flat';
  systemQuantity: number;
  action: 'sync' | 'alert' | 'manual_review';
}

/**
 * Reconcile positions for a single account
 */
export async function reconcileAccount(
  account: BrokerAccount
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    accountId: account.id,
    accountName: account.name,
    status: 'success',
    discrepanciesFound: 0,
    discrepanciesResolved: 0,
    positionsFromBroker: 0,
    positionsInSystem: 0,
    errors: [],
  };

  try {
    reconLogger.info('Starting reconciliation for account', {
      accountId: account.id,
      accountName: account.name,
      brokerType: account.brokerType,
    });

    // Get positions from broker (source of truth)
    const adapter = getBrokerAdapter(account.brokerType);
    const brokerPositions = await adapter.getPositions(account);
    result.positionsFromBroker = brokerPositions.length;

    // Get positions from our system
    const systemPositions = await getSystemPositions(account.id);
    result.positionsInSystem = systemPositions.length;

    // Find discrepancies
    const discrepancies = findDiscrepancies(brokerPositions, systemPositions);
    result.discrepanciesFound = discrepancies.length;

    // Resolve discrepancies
    for (const discrepancy of discrepancies) {
      try {
        await resolveDiscrepancy(account.id, discrepancy);
        result.discrepanciesResolved++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to resolve ${discrepancy.symbol}: ${errorMsg}`);
        reconLogger.error('Failed to resolve discrepancy', {
          accountId: account.id,
          symbol: discrepancy.symbol,
          error: errorMsg,
        });
      }
    }

    // Record reconciliation run
    await recordReconciliationRun(result);

    // Store position snapshot
    await storePositionSnapshot(account.id, brokerPositions, 'broker');

    reconLogger.info('Reconciliation completed', {
      accountId: account.id,
      discrepanciesFound: result.discrepanciesFound,
      discrepanciesResolved: result.discrepanciesResolved,
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.status = 'failed';
    result.errors.push(errorMsg);

    await recordReconciliationRun(result);

    reconLogger.error('Reconciliation failed', {
      accountId: account.id,
      error: errorMsg,
    });

    return result;
  }
}

/**
 * Run reconciliation for all active accounts
 */
export async function reconcileAllAccounts(): Promise<
  ReconciliationResult[]
> {
  const accountsResult = await query<BrokerAccount>(
    `SELECT * FROM broker_accounts 
     WHERE is_active = true 
     AND is_disabled = false`
  );

  const results: ReconciliationResult[] = [];

  for (const account of accountsResult.rows) {
    const result = await reconcileAccount(account);
    results.push(result);

    // Small delay between accounts to avoid rate limiting
    await delay(100);
  }

  return results;
}

/**
 * Get positions from system database
 */
async function getSystemPositions(
  accountId: string
): Promise<Position[]> {
  // Query filled orders and calculate positions
  const result = await query<{
    symbol: string;
    side: 'buy' | 'sell';
    total_quantity: number;
    avg_price: number;
  }>(`,
    `WITH fills AS (
      SELECT 
        symbol,
        side,
        quantity,
        COALESCE(broker_order_id, 'unknown') as exec_id
      FROM orders_submitted
      WHERE account_id = $1
      AND status IN ('filled', 'partially_filled')
      AND created_at > NOW() - INTERVAL '30 days'
    )
    SELECT 
      symbol,
      CASE 
        WHEN SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END) > 0 THEN 'buy'
        ELSE 'sell'
      END as side,
      ABS(SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END)) as total_quantity,
      0 as avg_price
    FROM fills
    GROUP BY symbol
    HAVING ABS(SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END)) > 0`,
    [accountId]
  );

  return result.rows.map((row) => ({
    symbol: row.symbol,
    quantity: parseInt(row.total_quantity as unknown as string, 10),
    side: row.side === 'buy' ? 'long' : 'short',
    avgEntryPrice: 0, // Would need executions table
    unrealizedPnl: 0,
  }));
}

/**
 * Find discrepancies between broker and system positions
 */
function findDiscrepancies(
  brokerPositions: Position[],
  systemPositions: Position[]
): PositionDiscrepancy[] {
  const discrepancies: PositionDiscrepancy[] = [];
  const allSymbols = new Set([
    ...brokerPositions.map((p) => p.symbol),
    ...systemPositions.map((p) => p.symbol),
  ]);

  for (const symbol of allSymbols) {
    const brokerPos = brokerPositions.find((p) => p.symbol === symbol);
    const systemPos = systemPositions.find((p) => p.symbol === symbol);

    const brokerSide = brokerPos
      ? brokerPos.side
      : 'flat';
    const brokerQty = brokerPos ? brokerPos.quantity : 0;
    const systemSide = systemPos
      ? systemPos.side
      : 'flat';
    const systemQty = systemPos ? systemPos.quantity : 0;

    // Check for discrepancy
    if (brokerSide !== systemSide || brokerQty !== systemQty) {
      discrepancies.push({
        symbol,
        brokerSide,
        brokerQuantity: brokerQty,
        systemSide,
        systemQuantity: systemQty,
        action: determineResolutionAction(brokerSide, systemSide, brokerQty, systemQty),
      });
    }
  }

  return discrepancies;
}

/**
 * Determine what action to take for a discrepancy
 */
function determineResolutionAction(
  brokerSide: 'long' | 'short' | 'flat',
  systemSide: 'long' | 'short' | 'flat',
  brokerQty: number,
  systemQty: number
): 'sync' | 'alert' | 'manual_review' {
  // If broker is flat but system thinks we have a position
  // This is dangerous - we might try to close a non-existent position
  if (brokerSide === 'flat' && systemSide !== 'flat') {
    return 'sync';
  }

  // If broker has a position but system doesn't
  // This could happen if an order was placed outside the system
  if (brokerSide !== 'flat' && systemSide === 'flat') {
    return 'sync';
  }

  // If sides differ (e.g., broker says long, system says short)
  // This is a serious discrepancy requiring manual review
  if (brokerSide !== systemSide && brokerSide !== 'flat' && systemSide !== 'flat') {
    return 'manual_review';
  }

  // Quantity mismatch - alert but auto-sync if close
  if (Math.abs(brokerQty - systemQty) <= 1) {
    return 'sync';
  }

  if (Math.abs(brokerQty - systemQty) > 5) {
    return 'manual_review';
  }

  return 'alert';
}

/**
 * Resolve a position discrepancy
 */
async function resolveDiscrepancy(
  accountId: string,
  discrepancy: PositionDiscrepancy
): Promise<void> {
  reconLogger.warn('Resolving position discrepancy', {
    accountId,
    symbol: discrepancy.symbol,
    broker: `${discrepancy.brokerSide} ${discrepancy.brokerQuantity}`,
    system: `${discrepancy.systemSide} ${discrepancy.systemQuantity}`,
    action: discrepancy.action,
  });

  switch (discrepancy.action) {
    case 'sync':
      // Update system to match broker
      await syncPositionToBroker(accountId, discrepancy);
      break;

    case 'alert':
      // Log but don't auto-correct
      await logDiscrepancyAlert(accountId, discrepancy);
      break;

    case 'manual_review':
      // Flag for manual review, don't auto-correct
      await flagForManualReview(accountId, discrepancy);
      break;
  }
}

/**
 * Sync system position to match broker
 */
async function syncPositionToBroker(
  accountId: string,
  discrepancy: PositionDiscrepancy
): Promise<void> {
  // Record the sync action
  await query(
    `INSERT INTO position_snapshots (
      account_id, symbol, side, quantity, source, synced_at
    ) VALUES ($1, $2, $3, $4, 'system_sync', NOW())`,
    [
      accountId,
      discrepancy.symbol,
      discrepancy.brokerSide,
      discrepancy.brokerQuantity,
    ]
  );

  // Log audit event
  await query(
    `INSERT INTO audit_logs (
      action, entity_type, entity_id, new_value, created_at
    ) VALUES ($1, $2, $3, $4, NOW())`,
    [
      'position_sync',
      'account',
      accountId,
      JSON.stringify({
        symbol: discrepancy.symbol,
        from: {
          side: discrepancy.systemSide,
          quantity: discrepancy.systemQuantity,
        },
        to: {
          side: discrepancy.brokerSide,
          quantity: discrepancy.brokerQuantity,
        },
      }),
    ]
  );
}

/**
 * Log a discrepancy alert
 */
async function logDiscrepancyAlert(
  accountId: string,
  discrepancy: PositionDiscrepancy
): Promise<void> {
  await query(
    `INSERT INTO risk_events (
      type, rule_type, account_id, message, details, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      'warning',
      'position_discrepancy',
      accountId,
      `Position discrepancy detected for ${discrepancy.symbol}`,
      JSON.stringify(discrepancy),
    ]
  );
}

/**
 * Flag a discrepancy for manual review
 */
async function flagForManualReview(
  accountId: string,
  discrepancy: PositionDiscrepancy
): Promise<void> {
  await logDiscrepancyAlert(accountId, discrepancy);

  // Could also send notification, create ticket, etc.
  reconLogger.error('Position discrepancy flagged for manual review', {
    accountId,
    symbol: discrepancy.symbol,
    discrepancy,
  });
}

/**
 * Record reconciliation run
 */
async function recordReconciliationRun(
  result: ReconciliationResult
): Promise<void> {
  await query(
    `INSERT INTO reconciliation_runs (
      account_id, status, discrepancies_found, discrepancies_resolved, errors, completed_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      result.accountId,
      result.status,
      result.discrepanciesFound,
      result.discrepanciesResolved,
      JSON.stringify(result.errors),
    ]
  );
}

/**
 * Store position snapshot
 */
async function storePositionSnapshot(
  accountId: string,
  positions: Position[],
  source: 'broker' | 'system'
): Promise<void> {
  for (const position of positions) {
    await query(
      `INSERT INTO position_snapshots (
        account_id, symbol, side, quantity, avg_entry_price, unrealized_pnl, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        accountId,
        position.symbol,
        position.side,
        position.quantity,
        position.avgEntryPrice,
        position.unrealizedPnl,
        source,
      ]
    );
  }
}

/**
 * Run startup reconciliation for all accounts
 */
export async function runStartupReconciliation(): Promise<void> {
  reconLogger.info('Running startup reconciliation...');

  const results = await reconcileAllAccounts();

  const totalDiscrepancies = results.reduce(
    (sum, r) => sum + r.discrepanciesFound,
    0
  );
  const totalResolved = results.reduce(
    (sum, r) => sum + r.discrepanciesResolved,
    0
  );
  const failures = results.filter((r) => r.status === 'failed');

  reconLogger.info('Startup reconciliation complete', {
    accountsProcessed: results.length,
    totalDiscrepancies,
    totalResolved,
    failures: failures.length,
  });

  if (failures.length > 0) {
    reconLogger.error('Some accounts failed reconciliation', {
      failedAccounts: failures.map((f) => f.accountId),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
