import winston from 'winston';
import path from 'path';
import fs from 'fs';
import config from '../config';

// Ensure logs directory exists
const logsDir = path.dirname(config.logging.file);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, json } = winston.format;

// Console format (human readable)
const consoleFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

// Create logger instance
export const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'trade-automation-api' },
  transports: [
    // File transport (JSON format for parsing)
    new winston.transports.File({
      filename: config.logging.file,
      format: combine(timestamp(), json()),
    }),
    // Console transport (human readable)
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        consoleFormat
      ),
    }),
  ],
});

// Create a child logger with context
export function createContextLogger(context: string) {
  return logger.child({ context });
}

export default logger;
