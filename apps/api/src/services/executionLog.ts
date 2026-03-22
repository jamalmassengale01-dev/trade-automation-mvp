/**
 * Execution Log Service
 * 
 * Provides structured logging with trace IDs for end-to-end visibility.
 * Every operation is logged with correlation IDs to trace a trade
 * from webhook receipt through to execution.
 */

import crypto from 'crypto';
import { query } from '../db';
import logger from '../utils/logger';

const executionLogger = logger.child({ context: 'ExecutionLog' });

export interface LogContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface OperationLog {
  operation: string;
  entityType?: string;
  entityId?: string;
  accountId?: string;
  status: 'started' | 'succeeded' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string;
  durationMs?: number;
}

/**
 * Generate a unique trace ID for end-to-end tracking
 */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a span ID for an operation
 */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Log an operation
 */
export async function logOperation(
  context: LogContext,
  log: OperationLog
): Promise<void> {
  try {
    await query(
      `INSERT INTO execution_logs (
        trace_id, span_id, parent_span_id, operation,
        entity_type, entity_id, account_id, status,
        input_payload, output_payload, error_message, duration_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
      [
        context.traceId,
        context.spanId,
        context.parentSpanId || null,
        log.operation,
        log.entityType || null,
        log.entityId || null,
        log.accountId || null,
        log.status,
        log.input ? JSON.stringify(sanitizePayload(log.input)) : null,
        log.output ? JSON.stringify(sanitizePayload(log.output)) : null,
        log.errorMessage || null,
        log.durationMs || null,
      ]
    );
  } catch (error) {
    // Don't throw - logging should never break the main flow
    executionLogger.error('Failed to write execution log', {
      traceId: context.traceId,
      operation: log.operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Create a child context for nested operations
 */
export function createChildContext(parent: LogContext): LogContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
  };
}

/**
 * Wrapper to log an operation with automatic timing
 */
export async function withLogging<T>(
  context: LogContext,
  operation: string,
  entityType: string,
  entityId: string,
  fn: () => Promise<T>,
  options: {
    accountId?: string;
    logInput?: boolean;
    logOutput?: boolean;
  } = {}
): Promise<T> {
  const startTime = Date.now();
  
  // Log start
  await logOperation(context, {
    operation: `${operation}.start`,
    entityType,
    entityId,
    accountId: options.accountId,
    status: 'started',
  });

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;

    // Log success
    await logOperation(context, {
      operation,
      entityType,
      entityId,
      accountId: options.accountId,
      status: 'succeeded',
      output: options.logOutput ? { result } : undefined,
      durationMs,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log failure
    await logOperation(context, {
      operation,
      entityType,
      entityId,
      accountId: options.accountId,
      status: 'failed',
      errorMessage,
      durationMs,
    });

    throw error;
  }
}

/**
 * Get execution trace for a specific trace ID
 */
export async function getExecutionTrace(
  traceId: string
): Promise<Array<Record<string, unknown>>> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM execution_logs 
     WHERE trace_id = $1 
     ORDER BY created_at ASC`,
    [traceId]
  );

  return result.rows;
}

/**
 * Get execution trace for a specific entity
 */
export async function getEntityTrace(
  entityType: string,
  entityId: string,
  limit = 100
): Promise<Array<Record<string, unknown>>> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM execution_logs 
     WHERE entity_type = $1 AND entity_id = $2 
     ORDER BY created_at DESC 
     LIMIT $3`,
    [entityType, entityId, limit]
  );

  return result.rows;
}

/**
 * Get recent execution logs
 */
export async function getRecentLogs(
  options: {
    operation?: string;
    status?: string;
    accountId?: string;
    limit?: number;
    since?: Date;
  } = {}
): Promise<Array<Record<string, unknown>>> {
  const {
    operation,
    status,
    accountId,
    limit = 100,
    since = new Date(Date.now() - 24 * 60 * 60 * 1000),
  } = options;

  let sql = `SELECT * FROM execution_logs WHERE created_at > $1`;
  const params: (Date | string | number)[] = [since];
  let paramIndex = 2;

  if (operation) {
    sql += ` AND operation = $${paramIndex++}`;
    params.push(operation);
  }

  if (status) {
    sql += ` AND status = $${paramIndex++}`;
    params.push(status);
  }

  if (accountId) {
    sql += ` AND account_id = $${paramIndex++}`;
    params.push(accountId);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
  params.push(limit);

  const result = await query<Record<string, unknown>>(sql, params);
  return result.rows;
}

/**
 * Get execution statistics
 */
export async function getExecutionStats(
  since?: Date
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  averageDurationMs: number;
  topOperations: Array<{ operation: string; count: number; failRate: number }>;
}> {
  const sinceDate = since || new Date(Date.now() - 24 * 60 * 60 * 1000);

  const statsResult = await query<{
    total: number;
    succeeded: number;
    failed: number;
    avg_duration: number;
  }>(`,
    `SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'succeeded') as succeeded,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) as avg_duration
     FROM execution_logs 
     WHERE created_at > $1`,
    [sinceDate]
  );

  const topOpsResult = await query<{
    operation: string;
    count: number;
    fail_rate: number;
  }>(`,
    `SELECT 
      operation,
      COUNT(*) as count,
      ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / COUNT(*), 2) as fail_rate
     FROM execution_logs 
     WHERE created_at > $1
     GROUP BY operation
     ORDER BY count DESC
     LIMIT 10`,
    [sinceDate]
  );

  const stats = statsResult.rows[0];

  return {
    total: parseInt(stats.total as unknown as string, 10),
    succeeded: parseInt(stats.succeeded as unknown as string, 10),
    failed: parseInt(stats.failed as unknown as string, 10),
    averageDurationMs: Math.round(stats.avg_duration),
    topOperations: topOpsResult.rows.map((row) => ({
      operation: row.operation,
      count: parseInt(row.count as unknown as string, 10),
      failRate: parseFloat(row.fail_rate as unknown as string),
    })),
  };
}

/**
 * Sanitize payload to remove sensitive data
 */
function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['password', 'secret', 'token', 'key', 'credential', 'apiKey'];
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizePayload(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
