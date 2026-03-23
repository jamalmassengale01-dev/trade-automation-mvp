/**
 * Heartbeat Service
 * 
 * Monitors system health by tracking heartbeats from various components.
 * Detects when components become unhealthy.
 */

import { query } from '../db';
import logger from '../utils/logger';
import os from 'os';

const heartbeatLogger = logger.child({ context: 'HeartbeatService' });

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy';
export type ComponentType =
  | 'webhook'
  | 'alert_processor'
  | 'order_executor'
  | 'reconciler'
  | 'risk_engine'
  | 'copier';

export interface HeartbeatData {
  component: ComponentType;
  status: ComponentStatus;
  metrics?: Record<string, unknown>;
}

export interface ComponentHealth {
  component: ComponentType;
  instanceId: string;
  status: ComponentStatus;
  metrics: Record<string, unknown>;
  lastBeatAt: Date;
  secondsSinceLastBeat: number;
}

const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

/**
 * Send a heartbeat for a component
 */
export async function sendHeartbeat(data: HeartbeatData): Promise<void> {
  try {
    await query(
      `INSERT INTO system_heartbeats (
        component, instance_id, status, metrics, last_beat_at, created_at
      ) VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (component, instance_id) DO UPDATE SET
        status = EXCLUDED.status,
        metrics = EXCLUDED.metrics,
        last_beat_at = EXCLUDED.last_beat_at`,
      [data.component, INSTANCE_ID, data.status, JSON.stringify(data.metrics || {})]
    );
  } catch (error) {
    heartbeatLogger.error('Failed to send heartbeat', {
      component: data.component,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get health status of all components
 */
export async function getSystemHealth(options: {
  maxStalenessSeconds?: number;
} = {}): Promise<{
  overall: ComponentStatus;
  components: ComponentHealth[];
}> {
  const { maxStalenessSeconds = 60 } = options;
  const staleThreshold = new Date(Date.now() - maxStalenessSeconds * 1000);

  const result = await query<{
    component: ComponentType;
    instance_id: string;
    status: ComponentStatus;
    metrics: Record<string, unknown>;
    last_beat_at: Date;
  }>(
    `SELECT 
      component,
      instance_id,
      status,
      metrics,
      last_beat_at
     FROM system_heartbeats
     WHERE last_beat_at > $1
     ORDER BY component, last_beat_at DESC`,
    [staleThreshold]
  );

  const now = new Date();
  const components: ComponentHealth[] = result.rows.map((row) => ({
    component: row.component,
    instanceId: row.instance_id,
    status: row.status,
    metrics: row.metrics,
    lastBeatAt: row.last_beat_at,
    secondsSinceLastBeat: Math.floor(
      (now.getTime() - new Date(row.last_beat_at).getTime()) / 1000
    ),
  }));

  // Determine overall health
  let overall: ComponentStatus = 'healthy';
  for (const comp of components) {
    if (comp.status === 'unhealthy') {
      overall = 'unhealthy';
      break;
    }
    if (comp.status === 'degraded' && overall === 'healthy') {
      overall = 'degraded';
    }
  }

  return { overall, components };
}

/**
 * Get stale components (haven't sent heartbeat recently)
 */
export async function getStaleComponents(
  maxStalenessSeconds: number = 60
): Promise<ComponentHealth[]> {
  const staleThreshold = new Date(Date.now() - maxStalenessSeconds * 1000);

  const result = await query<{
    component: ComponentType;
    instance_id: string;
    status: ComponentStatus;
    metrics: Record<string, unknown>;
    last_beat_at: Date;
  }>(
    `SELECT 
      component,
      instance_id,
      status,
      metrics,
      last_beat_at
     FROM system_heartbeats
     WHERE last_beat_at <= $1
     ORDER BY last_beat_at ASC`,
    [staleThreshold]
  );

  const now = new Date();
  return result.rows.map((row) => ({
    component: row.component,
    instanceId: row.instance_id,
    status: 'unhealthy' as ComponentStatus,
    metrics: row.metrics,
    lastBeatAt: row.last_beat_at,
    secondsSinceLastBeat: Math.floor(
      (now.getTime() - new Date(row.last_beat_at).getTime()) / 1000
    ),
  }));
}

/**
 * Clean up old heartbeat entries
 */
export async function cleanupOldHeartbeats(
  olderThanMinutes: number = 60
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const result = await query(
    'DELETE FROM system_heartbeats WHERE last_beat_at < $1',
    [cutoff]
  );

  const count = result.rowCount || 0;
  if (count > 0) {
    heartbeatLogger.debug('Cleaned up old heartbeats', { count });
  }

  return count;
}

/**
 * Create a heartbeat sender that automatically sends periodic heartbeats
 */
export function createHeartbeatSender(
  component: ComponentType,
  intervalMs: number = 30000,
  getMetrics?: () => Record<string, unknown>
): { start: () => void; stop: () => void } {
  let intervalId: NodeJS.Timeout | null = null;

  return {
    start: () => {
      if (intervalId) return;

      // Send initial heartbeat
      sendHeartbeat({
        component,
        status: 'healthy',
        metrics: getMetrics?.(),
      });

      // Start periodic heartbeats
      intervalId = setInterval(() => {
        sendHeartbeat({
          component,
          status: 'healthy',
          metrics: getMetrics?.(),
        });
      }, intervalMs);
    },

    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}
