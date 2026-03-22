import { Worker } from 'bullmq';
import { processAlertJob } from '../processor/alertProcessor';
import { processOrderJob } from '../processor/orderProcessor';
import config from '../config';
import logger from '../utils/logger';

const workerLogger = logger.child({ context: 'Workers' });

const redisOptions = {
  url: config.redis.url,
};

/**
 * Alert Worker
 * 
 * Processes TradingView alerts through risk engine and copier.
 */
export const alertWorker = new Worker('alerts', processAlertJob, {
  connection: redisOptions,
  concurrency: 5,
  limiter: {
    max: 10,
    duration: 1000, // 10 alerts per second max
  },
});

/**
 * Order Worker
 * 
 * Executes orders through broker adapters.
 */
export const orderWorker = new Worker('orders', processOrderJob, {
  connection: redisOptions,
  concurrency: 10,
  limiter: {
    max: 20,
    duration: 1000, // 20 orders per second max
  },
});

// Log worker events
alertWorker.on('ready', () => {
  workerLogger.info('Alert worker ready');
});

alertWorker.on('completed', (job) => {
  workerLogger.debug('Alert job completed', { jobId: job.id });
});

alertWorker.on('failed', (job, err) => {
  workerLogger.error('Alert job failed', {
    jobId: job?.id,
    error: err.message,
  });
});

alertWorker.on('stalled', (jobId) => {
  workerLogger.warn('Alert job stalled', { jobId });
});

orderWorker.on('ready', () => {
  workerLogger.info('Order worker ready');
});

orderWorker.on('completed', (job) => {
  workerLogger.debug('Order job completed', { jobId: job.id });
});

orderWorker.on('failed', (job, err) => {
  workerLogger.error('Order job failed', {
    jobId: job?.id,
    error: err.message,
  });
});

orderWorker.on('stalled', (jobId) => {
  workerLogger.warn('Order job stalled', { jobId });
});

/**
 * Graceful shutdown
 */
export async function closeWorkers(): Promise<void> {
  workerLogger.info('Closing workers...');
  
  await alertWorker.close();
  await orderWorker.close();
  
  workerLogger.info('Workers closed');
}
