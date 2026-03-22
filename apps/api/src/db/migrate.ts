import fs from 'fs';
import path from 'path';
import { pool } from './index';
import logger from '../utils/logger';

const migrationLogger = logger.child({ context: 'migration' });

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  
  migrationLogger.info('Starting database migration...');
  
  try {
    await pool.query(schema);
    migrationLogger.info('Database migration completed successfully');
  } catch (error) {
    migrationLogger.error('Migration failed', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    process.exit(1);
  }
  
  await pool.end();
}

migrate();
