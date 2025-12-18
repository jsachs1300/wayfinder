import { LogEntry, LoggingLevel } from '../types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  child(context: { tokenId?: string; requestId?: string }): Logger;
}

/**
 * Default logger implementation
 */
export class DefaultLogger implements Logger {
  private minLevel: LogLevel;
  private tokenId?: string;
  private requestId?: string;

  constructor(
    minLevel: LogLevel = 'info',
    context?: { tokenId?: string; requestId?: string }
  ) {
    this.minLevel = minLevel;
    this.tokenId = context?.tokenId;
    this.requestId = context?.requestId;
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log('error', message, metadata);
  }

  child(context: { tokenId?: string; requestId?: string }): Logger {
    return new DefaultLogger(this.minLevel, {
      tokenId: context.tokenId ?? this.tokenId,
      requestId: context.requestId ?? this.requestId,
    });
  }

  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      token_id: this.tokenId,
      request_id: this.requestId,
      metadata,
    };

    // Output as JSON for structured logging
    const output = JSON.stringify(entry);

    switch (level) {
      case 'debug':
      case 'info':
        console.log(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }
}

/**
 * Parse log level from environment or token config
 */
export function parseLogLevel(level?: string): LogLevel {
  switch (level?.toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * Map token logging level to log level
 */
export function tokenLoggingLevelToLogLevel(level?: LoggingLevel): LogLevel {
  switch (level) {
    case 'verbose':
      return 'debug';
    case 'normal':
    default:
      return 'info';
  }
}

/**
 * Create a logger instance
 */
export function createLogger(
  level?: string,
  context?: { tokenId?: string; requestId?: string }
): Logger {
  return new DefaultLogger(parseLogLevel(level), context);
}

/**
 * Global logger instance
 */
export const logger = createLogger(process.env.LOG_LEVEL);
