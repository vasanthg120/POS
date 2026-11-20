'use strict';
const winston = require('winston');
const { combine, timestamp, printf, colorize, errors } = winston.format;

const devFmt = printf(({ level, message, timestamp, stack }) =>
  stack ? `${timestamp} [${level}] ${message}\n${stack}` : `${timestamp} [${level}] ${message}`
);

const logger = winston.createLogger({
  // LOG_LEVEL=info in production keeps the per-run "[CRM Sync] …" summaries;
  // the default ('warn') still records partial and failed syncs.
  level : process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'debug'),
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    process.env.NODE_ENV !== 'production' ? combine(colorize(), devFmt) : winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

module.exports = logger;