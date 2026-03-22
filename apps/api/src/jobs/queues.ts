import { Queue } from 'bullmq';
import config from '../config';
import logger from '../utils/logger';

const queueLogger = logger.child({ context: 'Queue' });

// Redis connection options
const redisOptions = {
  url: config.redis.url,
};

/**
 * Alert Queue
 * 
 * Holds incoming TradingView alerts for processing.
 * Workers pick up jobs and run through risk checks and copier logic.
 */
export const alertQueue = new Queue('alerts', {
  connection: redisOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep for 7 days
    },
  },
});

/**
 * Order Queue
 * 
 * Holds individual orders ready for execution.
 * Separate queue allows prioritization and retry logic per-order.
 */
export const orderQueue = new Queue('orders', {
  connection: redisOptions,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 24 * 3600,
      count: 5000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600,
    },
  },
});

// Log queue events
alertQueue.on('waiting', (jobId) => {
  queueLogger.debug('Alert job waiting', { jobId });
});

alertQueue.on('completed', (job) => {
  queueLogger.info('Alert job completed', {
    jobId: job.id,
    name: job.name,
  });
});

alertQueue.on('failed', (job, err) => {
  queueLogger.error('Alert job failed', {
    jobId: job?.id,
    name: job?.name,
    error: err.message,
  });
});

orderQueue.on('completed', (job) => {
  queueLogger.info('Order job completed', {
    jobId: job.id,
    name: job.name,
  });
});

orderQueue.on('failed', (job, err) => {
  queueLogger.error('Order job failed', {
    jobId: job?.id,
    name: job?.name,
    error: err.message,
  });
});

/**
 * Get queue metrics
 */
export async function getQueueMetrics(): Promise<{
  alerts: { waiting: number; active: number; completed: number; failed: number };
  orders: { waiting: number; active: number; completed: number; failed: number };
}> {
  const [alertWaiting, alertActive, alertCompleted, alertFailed] = await Promise.all([
    alertQueue.getWaitingCount(),
    alertQueue.getActiveCount(),
    alertQueue.getCompletedCount(),
    alertQueue.getFailedCount(),
  ]);
  
  const [orderWaiting, orderActive, orderCompleted, orderFailed] = await Promise.all([
    orderQueue.getWaitingCount(),
    orderQueue.getActiveCount(),
    orderQueue.getCompletedCount(),
    orderQueue.getFailedCount(),
  ]);
  
  return {
    alerts: {
      waiting: alertWaiting,
      active: alertActive,
      completed: alertCompleted,
      failed: alertFailed,
    },
    orders: {
      waiting: orderWaiting,
      active: orderActive,
      completed: orderCompleted,
      failed: orderFailed,
    },
  };
}

/**
 * Clean queues (useful for testing)
 */
export async function cleanQueues(): Promise<void> {
  await alertQueue.obliterate({ force: true });
  await orderQueue.obliterate({ force: true });
  queueLogger.info('Queues cleaned');
}

/**
 * Close queue connections
 */
export async function closeQueues(): Promise<void> {
  await alertQueue.close();
  await orderQueue.close();
  queueLogger.info('Queues closed');
}
