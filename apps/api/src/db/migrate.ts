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
  const gbLivePath = path.join(__dirname, 'schema_gblive.sql');
  const gbLiveV2Path = path.join(__dirname, 'schema_gblive_v2.sql');
  const gbLiveV3Path = path.join(__dirname, 'schema_gblive_v3.sql');
  const gbLiveV4Path = path.join(__dirname, 'schema_gblive_v4.sql');
  const authPath = path.join(__dirname, 'schema_auth.sql');
  const catalogPath = path.join(__dirname, 'schema_catalog.sql');
  const gbLiveV7Path = path.join(__dirname, 'schema_gblive_v7.sql');
  const gbLiveV8Path = path.join(__dirname, 'schema_gblive_v8.sql');
  const gbLiveV9Path = path.join(__dirname, 'schema_gblive_v9.sql');
  const launchpadPath = path.join(__dirname, 'schema_launchpad.sql');
  try {
    await runSqlFile(schemaPath, 'schema.sql');
    await runSqlFile(hardeningPath, 'schema_hardening.sql');
    await runSqlFile(gbLivePath, 'schema_gblive.sql');
    await runSqlFile(gbLiveV2Path, 'schema_gblive_v2.sql');
    await runSqlFile(gbLiveV3Path, 'schema_gblive_v3.sql');
    await runSqlFile(gbLiveV4Path, 'schema_gblive_v4.sql');
    await runSqlFile(authPath, 'schema_auth.sql');
    await runSqlFile(catalogPath, 'schema_catalog.sql');
    await runSqlFile(gbLiveV7Path, 'schema_gblive_v7.sql');
    await runSqlFile(gbLiveV8Path, 'schema_gblive_v8.sql');
    await runSqlFile(gbLiveV9Path, 'schema_gblive_v9.sql');
    await runSqlFile(launchpadPath, 'schema_launchpad.sql');
    migrationLogger.info('Database migration completed successfully');
  } catch (error) {
    migrationLogger.error('Migration failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
