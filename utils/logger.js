/**
 * logger.js
 * Centralized logger using Winston.
 * Outputs colorized logs to console and writes structured JSON to files.
 */

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { combine, timestamp, colorize, printf, json, errors } = format;

// Console log format: [timestamp] LEVEL: message  (metadata if any)
const consoleFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `  ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${stack || message}${metaStr}`;
});

const logger = createLogger({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'debug'),
    format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    ),
    transports: [
        // Colorized console output
        new transports.Console({
            format: combine(colorize(), consoleFormat),
        }),
    ],
    exitOnError: false,
});

module.exports = logger;
