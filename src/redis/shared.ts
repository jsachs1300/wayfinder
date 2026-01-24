import Redis from 'ioredis';
import type { Logger } from '../logging/logger';

let sharedRedis: Redis | undefined;
let sharedRedisPromise: Promise<Redis | undefined> | undefined;

export async function cleanupSharedRedis(): Promise<void> {
  if (!sharedRedis) {
    sharedRedisPromise = undefined;
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
    return undefined;
  }

  const redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  sharedRedisPromise = (async () => {
    try {
      await redisClient.connect();
      sharedRedis = redisClient;
      logger.info('Connected to Redis');
      return redisClient;
    } catch (error) {
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
