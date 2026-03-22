import { Pool, PoolClient, QueryResult } from 'pg';
import config from '../config';
import logger from '../utils/logger';

const dbLogger = logger.child({ context: 'database' });

// Create connection pool
export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log pool events
pool.on('connect', () => {
  dbLogger.debug('New database connection established');
});

pool.on('error', (err) => {
  dbLogger.error('Unexpected database error', { error: err.message });
});

// Query helper with logging
export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    dbLogger.debug('Query executed', {
      text: text.substring(0, 100),
      duration,
      rows: result.rowCount,
    });
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    dbLogger.error('Query failed', {
      text: text.substring(0, 100),
      duration,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Transaction helper
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Health check
export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// Close pool (for graceful shutdown)
export async function closePool(): Promise<void> {
  await pool.end();
}

export default { query, withTransaction, healthCheck, closePool };
