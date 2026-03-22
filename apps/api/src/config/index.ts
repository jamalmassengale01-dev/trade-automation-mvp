import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function getBoolEnv(key: string, defaultValue = false): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getIntEnv(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable ${key} is required`);
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid integer`);
  }
  return parsed;
}

export const config = {
  env: getEnv('NODE_ENV', 'development'),
  isDev: getEnv('NODE_ENV', 'development') === 'development',
  isProd: getEnv('NODE_ENV', 'development') === 'production',
  
  server: {
    port: getIntEnv('PORT', 3001),
    host: getEnv('API_HOST', '0.0.0.0'),
  },
  
  database: {
    url: getEnv('DATABASE_URL'),
  },
  
  redis: {
    url: getEnv('REDIS_URL', 'redis://localhost:6379'),
  },
  
  webhook: {
    secret: getEnv('WEBHOOK_SECRET', 'dev-secret-change-me'),
  },
  
  logging: {
    level: getEnv('LOG_LEVEL', 'info'),
    file: getEnv('LOG_FILE', 'logs/app.log'),
  },
  
  features: {
    enableMockBroker: getBoolEnv('ENABLE_MOCK_BROKER', true),
    enableSimulatedBroker: getBoolEnv('ENABLE_SIMULATED_BROKER', true),
    globalKillSwitch: getBoolEnv('GLOBAL_KILL_SWITCH', false),
  },
};

export default config;
