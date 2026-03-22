/**
 * Dead Letter Queue Service
 * 
 * Handles jobs that have failed permanently.
 * Stores failed jobs for manual review and potential retry.
 */

import { query } from '../db';
import logger from '../utils/logger';

const dlqLogger = logger.child({ context: 'DeadLetterQueue' });

export interface FailedJob {
  queueName: string;
  jobId: string;
  jobName: string;
  payload: Record<string, unknown>;
  errorMessage: string;
  errorStack?: string;
  attemptCount: number;
  retryable: boolean;
}

export interface DLQEntry {
  id: string;
  queueName: string;
  jobId: string;
  jobName: string;
  payload: Record<string, unknown>;
  errorMessage: string;
  errorStack?: string;
  attemptCount: number;
  failedAt: Date;
  retryable: boolean;
  retriedAt?: Date;
  retriedSuccessfully?: boolean;
}

/**
 * Add a failed job to the dead letter queue
 */
export async function addToDLQ(job: FailedJob): Promise<string> {
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO dead_letter_queue (
        queue_name, job_id, job_name, payload, error_message, error_stack,
        attempt_count, failed_at, retryable, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, NOW())
      RETURNING id`,
      [
        job.queueName,
        job.jobId,
        job.jobName,
        JSON.stringify(job.payload),
        job.errorMessage,
        job.errorStack || null,
        job.attemptCount,
        job.retryable,
      ]
    );

    const id = result.rows[0].id;

    dlqLogger.error('Job moved to dead letter queue', {
      dlqId: id,
      queueName: job.queueName,
      jobId: job.jobId,
      jobName: job.jobName,
      errorMessage: job.errorMessage,
      retryable: job.retryable,
    });

    return id;
  } catch (error) {
    dlqLogger.error('Failed to add job to DLQ', {
      jobId: job.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get all failed jobs from DLQ
 */
export async function getDLQEntries(
  options: {
    queueName?: string;
    retryable?: boolean;
    limit?: number;
    since?: Date;
  } = {}
): Promise<DLQEntry[]> {
  const { queueName, retryable, limit = 100, since } = options;

  let sql = `SELECT * FROM dead_letter_queue WHERE 1=1`;
  const params: (string | Date | number | boolean)[] = [];
  let paramIndex = 1;

  if (queueName) {
    sql += ` AND queue_name = $${paramIndex++}`;
    params.push(queueName);
  }

  if (retryable !== undefined) {
    sql += ` AND retryable = $${paramIndex++}`;
    params.push(retryable);
  }

  if (since) {
    sql += ` AND failed_at > $${paramIndex++}`;
    params.push(since);
  }

  sql += ` ORDER BY failed_at DESC LIMIT $${paramIndex}`;
  params.push(limit);

  const result = await query<DLQEntry>(sql, params);

  return result.rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' 
      ? JSON.parse(row.payload) 
      : row.payload,
  }));
}

/**
 * Mark a DLQ entry as retried
 */
export async function markAsRetried(
  dlqId: string,
  success: boolean
): Promise<void> {
  await query(
    `UPDATE dead_letter_queue 
     SET retried_at = NOW(), 
         retried_successfully = $2 
     WHERE id = $1`,
    [dlqId, success]
  );

  dlqLogger.info('DLQ entry marked as retried', {
    dlqId,
    success,
  });
}

/**
 * Delete old DLQ entries
 */
export async function cleanupOldEntries(
  olderThanDays: number = 30
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const result = await query(
    'DELETE FROM dead_letter_queue WHERE failed_at < $1',
    [cutoff]
  );

  const count = result.rowCount || 0;
  dlqLogger.info('Cleaned up old DLQ entries', { count, olderThanDays });

  return count;
}

/**
 * Get DLQ statistics
 */
export async function getDLQStats(): Promise<{
  total: number;
  retryable: number;
  notRetryable: number;
  retried: number;
  retriedSuccessfully: number;
  byQueue: Array<{ queueName: string; count: number }>;
}> {
  const [totalResult, retryableResult, retriedResult, byQueueResult] =
    await Promise.all([
      query<{ count: number }>('SELECT COUNT(*) as count FROM dead_letter_queue'),
      query<{ count: number }>(
        "SELECT COUNT(*) as count FROM dead_letter_queue WHERE retryable = true"
      ),
      query<{ count: number; success: number }>(`,
        `SELECT 
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE retried_successfully = true) as success
         FROM dead_letter_queue
         WHERE retried_at IS NOT NULL`
      ),
      query<{ queue_name: string; count: number }>(`,
        `SELECT queue_name, COUNT(*) as count 
         FROM dead_letter_queue 
         GROUP BY queue_name 
         ORDER BY count DESC`
      ),
    ]);

  return {
    total: parseInt(totalResult.rows[0].count as unknown as string, 10),
    retryable: parseInt(retryableResult.rows[0].count as unknown as string, 10),
    notRetryable:
      parseInt(totalResult.rows[0].count as unknown as string, 10) -
      parseInt(retryableResult.rows[0].count as unknown as string, 10),
    retried: parseInt(retriedResult.rows[0].count as unknown as string, 10),
    retriedSuccessfully: parseInt(
      retriedResult.rows[0].success as unknown as string,
      10
    ),
    byQueue: byQueueResult.rows.map((row) => ({
      queueName: row.queue_name,
      count: parseInt(row.count as unknown as string, 10),
    })),
  };
}
