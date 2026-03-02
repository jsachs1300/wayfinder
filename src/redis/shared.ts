import Redis from 'ioredis';
import type { Logger } from '../logging/logger';

let sharedRedis: Redis | undefined;
let sharedRedisPromise: Promise<Redis | undefined> | undefined;

export interface SharedRedisDiagnostics {
  status: string;
  connect_failures: number;
  reconnect_attempts: number;
  last_reconnect_at?: string;
  last_error_kind?: string;
  last_error_at?: string;
  last_connect_at?: string;
  last_ready_at?: string;
}

const diagnostics: SharedRedisDiagnostics = {
  status: 'not_initialized',
  connect_failures: 0,
  reconnect_attempts: 0,
};

function categorizeRedisError(error: string): string {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('auth') ||
    normalized.includes('noauth') ||
    normalized.includes('wrongpass')
  ) return 'auth';
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('refused') || normalized.includes('econnrefused')) return 'connection_refused';
  if (normalized.includes('enotfound') || normalized.includes('dns')) return 'dns';
  if (normalized.includes('tls') || normalized.includes('ssl')) return 'tls';
  return 'unknown';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getSharedRedisDiagnostics(): SharedRedisDiagnostics {
  return {
    ...diagnostics,
  };
}

export async function cleanupSharedRedis(): Promise<void> {
  if (!sharedRedis) {
    sharedRedisPromise = undefined;
    diagnostics.status = 'not_initialized';
    return;
  }
  try {
    await sharedRedis.quit();
  } catch (error) {
    console.warn('Failed to close shared Redis connection', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    sharedRedis = undefined;
    sharedRedisPromise = undefined;
    diagnostics.status = 'closed';
  }
}

export async function getSharedRedis(logger: Logger): Promise<Redis | undefined> {
  if (sharedRedis) {
    return sharedRedis;
  }
  if (sharedRedisPromise) {
    return sharedRedisPromise;
  }
  if (process.env.REDIS_ENABLED !== 'true' || !process.env.REDIS_URL) {
    diagnostics.status = 'disabled';
    return undefined;
  }

  const connectTimeoutMs = parsePositiveInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 10000);
  const keepAliveMs = parsePositiveInt(process.env.REDIS_KEEPALIVE_MS, 30000);
  const maxRetriesPerRequest = parsePositiveInt(process.env.REDIS_MAX_RETRIES_PER_REQUEST, 3);
  let fatalReconnectError = false;

  const redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: connectTimeoutMs,
    keepAlive: keepAliveMs,
    retryStrategy: (attempt: number) => {
      if (fatalReconnectError) {
        diagnostics.status = 'ended';
        return null;
      }
      const delay = Math.min(attempt * 200, 2000);
      diagnostics.reconnect_attempts += 1;
      diagnostics.status = 'reconnecting';
      return delay;
    },
  });

  redisClient.on('connect', () => {
    diagnostics.status = 'connecting';
    diagnostics.last_connect_at = new Date().toISOString();
    logger.info('Redis connection established');
  });

  redisClient.on('ready', () => {
    diagnostics.status = 'ready';
    diagnostics.last_ready_at = new Date().toISOString();
    logger.info('Redis client ready');
  });

  redisClient.on('reconnecting', (delay: number) => {
    diagnostics.status = 'reconnecting';
    diagnostics.last_reconnect_at = new Date().toISOString();
    logger.warn('Redis reconnecting', { delay_ms: delay });
  });

  redisClient.on('close', () => {
    diagnostics.status = 'closed';
    logger.warn('Redis connection closed');
  });

  redisClient.on('end', () => {
    diagnostics.status = 'ended';
    logger.warn('Redis connection ended');
  });

  redisClient.on('error', (error) => {
    diagnostics.status = 'error';
    const errorKind = categorizeRedisError(error.message);
    diagnostics.last_error_kind = errorKind;
    diagnostics.last_error_at = new Date().toISOString();
    if (errorKind === 'auth' || errorKind === 'tls') {
      fatalReconnectError = true;
    }
    logger.warn('Redis client error', { error: error.message });
  });

  sharedRedisPromise = (async () => {
    try {
      await redisClient.connect();
      sharedRedis = redisClient;
      diagnostics.status = 'ready';
      return redisClient;
    } catch (error) {
      diagnostics.connect_failures += 1;
      diagnostics.status = 'connect_failed';
      diagnostics.last_error_kind = categorizeRedisError(
        error instanceof Error ? error.message : 'Unknown error'
      );
      diagnostics.last_error_at = new Date().toISOString();
      logger.warn('Failed to connect to Redis, using in-memory stores', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      try {
        redisClient.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      sharedRedis = undefined;
      return undefined;
    } finally {
      sharedRedisPromise = undefined;
    }
  })();

  return sharedRedisPromise;
}
