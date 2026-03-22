/**
 * Hardened Workers
 * 
 * Critical safety improvements:
 * - Hardened processors with full safety features
 * - Dead letter queue integration
 * - Circuit breaker monitoring
 * - Heartbeat tracking
 * - Stalled job handling
 * - Graceful shutdown with proper cleanup
 */

import { Worker, Job } from 'bullmq';
import { processAlertJob } from '../processor/alertProcessorHardened';
import { processOrderJob } from '../processor/orderProcessorHardened';
import { addToDLQ } from '../services/deadLetter';
import { createHeartbeatSender } from '../services/heartbeat';
import config from '../config';
import logger from '../utils/logger';

const workerLogger = logger.child({ context: 'Workers' });

const redisOptions = {
  url: config.redis.url,
};

// ============================================
// ALERT WORKER
// ============================================

export const alertWorker = new Worker(
  'alerts',
  async (job: Job) => {
    workerLogger.debug('Alert job starting', { jobId: job.id });
    await processAlertJob(job);
  },
  {
    connection: redisOptions,
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000, // 10 alerts per second max
    },
  }
);

// ============================================
// ORDER WORKER
// ============================================

export const orderWorker = new Worker(
  'orders',
  async (job: Job) => {
    workerLogger.debug('Order job starting', { jobId: job.id });
    await processOrderJob(job);
  },
  {
    connection: redisOptions,
    concurrency: 10,
    limiter: {
      max: 20,
      duration: 1000, // 20 orders per second max
    },
  }
);

// ============================================
// EVENT HANDLERS
// ============================================

alertWorker.on('ready', () => {
  workerLogger.info('Alert worker ready');
});

alertWorker.on('completed', (job) => {
  workerLogger.debug('Alert job completed', { jobId: job.id });
});

alertWorker.on('failed', async (job, err) => {
  workerLogger.error('Alert job failed', {
    jobId: job?.id,
    error: err.message,
    stack: err.stack,
  });

  // Move to DLQ after all retries exhausted
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
    try {
      await addToDLQ({
        queueName: 'alerts',
        jobId: job.id || 'unknown',
        jobName: job.name,
        payload: job.data as unknown as Record<string, unknown>,
        errorMessage: err.message,
        errorStack: err.stack,
        attemptCount: job.attemptsMade,
        retryable: !isPermanentError(err),
      });
    } catch (dlqError) {
      workerLogger.error('Failed to add alert job to DLQ', {
        jobId: job.id,
        error: dlqError instanceof Error ? dlqError.message : String(dlqError),
      });
    }
  }
});

alertWorker.on('stalled', (jobId) => {
  workerLogger.warn('Alert job stalled', { jobId });
});

alertWorker.on('error', (error) => {
  workerLogger.error('Alert worker error', {
    error: error.message,
    stack: error.stack,
  });
});

orderWorker.on('ready', () => {
  workerLogger.info('Order worker ready');
});

orderWorker.on('completed', (job) => {
  workerLogger.debug('Order job completed', { jobId: job.id });
});

orderWorker.on('failed', async (job, err) => {
  workerLogger.error('Order job failed', {
    jobId: job?.id,
    error: err.message,
    stack: err.stack,
  });

  // Move to DLQ after all retries exhausted
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
    try {
      await addToDLQ({
        queueName: 'orders',
        jobId: job.id || 'unknown',
        jobName: job.name,
        payload: job.data as unknown as Record<string, unknown>,
        errorMessage: err.message,
        errorStack: err.stack,
        attemptCount: job.attemptsMade,
        retryable: !isPermanentError(err),
      });
    } catch (dlqError) {
      workerLogger.error('Failed to add order job to DLQ', {
        jobId: job.id,
        error: dlqError instanceof Error ? dlqError.message : String(dlqError),
      });
    }
  }
});

orderWorker.on('stalled', (jobId) => {
  workerLogger.warn('Order job stalled', { jobId });
});

orderWorker.on('error', (error) => {
  workerLogger.error('Order worker error', {
    error: error.message,
    stack: error.stack,
  });
});

// ============================================
// HEARTBEAT SENDERS
// ============================================

const alertHeartbeat = createHeartbeatSender(
  'alert_processor',
  30000,
  () => ({
    queue: 'alerts',
    waiting: alertWorker.queue?.getWaitingCount(),
    active: alertWorker.queue?.getActiveCount(),
  })
);

const orderHeartbeat = createHeartbeatSender(
  'order_executor',
  30000,
  () => ({
    queue: 'orders',
    waiting: orderWorker.queue?.getWaitingCount(),
    active: orderWorker.queue?.getActiveCount(),
  })
);

// Start heartbeats
alertHeartbeat.start();
orderHeartbeat.start();

// ============================================
// UTILITY FUNCTIONS
// ============================================

function isPermanentError(error: Error): boolean {
  const permanentErrors = [
    'account not found',
    'account is not active',
    'insufficient funds',
    'invalid order',
    'market closed',
    'symbol not found',
    'risk check failed',
    'kill switch active',
    'circuit breaker',
    'rate limit exceeded',
  ];

  const errorMessage = error.message.toLowerCase();
  return permanentErrors.some((e) => errorMessage.includes(e));
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

export async function closeWorkers(): Promise<void> {
  workerLogger.info('Closing workers...');

  // Stop heartbeats
  alertHeartbeat.stop();
  orderHeartbeat.stop();

  // Close workers
  await alertWorker.close();
  await orderWorker.close();

  workerLogger.info('Workers closed');
}
