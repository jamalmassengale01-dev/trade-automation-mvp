import fs from 'fs';
import path from 'path';
import { pool } from './index';
import logger from '../utils/logger';

const migrationLogger = logger.child({ context: 'migration' });
const FORCE = process.argv.includes('--force');

async function runSqlFile(filePath: string, label: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    migrationLogger.warn(`SQL file not found, skipping: ${filePath}`);
    return;
  }
  const sql = fs.readFileSync(filePath, 'utf8');
  migrationLogger.info(`Running ${label}...`, { path: filePath });
  try {
    await pool.query(sql);
    migrationLogger.info(`${label} completed successfully`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('already exists') ||
      (error as any)?.code === '42P07' ||
      (error as any)?.code === '42710'
    ) {
      migrationLogger.warn(`${label} skipped (objects already exist)`, { detail: msg });
    } else {
      migrationLogger.error(`${label} failed`, { error: msg });
      throw error;
    }
  }
}

async function migrate() {
  migrationLogger.info('Starting database migration...', { force: FORCE });
  const schemaPath = path.join(__dirname, 'schema.sql');
  const hardeningPath = path.join(__dirname, 'schema_hardening.sql');
  try {
    await runSqlFile(schemaPath, 'schema.sql');
    await runSqlFile(hardeningPath, 'schema_hardening.sql');
    migrationLogger.info('Database migration completed successfully');
  } catch (error) {
    migrationLogger.error('Migration failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
