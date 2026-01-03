// IMPORTANT: Must be first import to load .env before any module initialization
// With CommonJS, all imports are hoisted, but 'dotenv/config' runs its side-effects
// before other modules are evaluated, ensuring env vars are available at import time
import 'dotenv/config';

import { createApp } from './app';
import { logger } from './logging';
import { getRateLimitConfigSummary } from './middleware';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const NODE_ENV = process.env.NODE_ENV ?? 'development';

async function main(): Promise<void> {
  logger.info('Starting Wayfinder server', {
    port: PORT,
    environment: NODE_ENV,
    redis_enabled: process.env.REDIS_ENABLED === 'true',
  });

  // Log rate limit configuration
  const rateLimitConfig = getRateLimitConfigSummary();
  logger.info('Rate limiting enabled', rateLimitConfig);

  const { app, dependencies } = createApp();

  // Connect to Redis if available
  if (dependencies.redis) {
    try {
      await dependencies.redis.connect();
      logger.info('Connected to Redis');
    } catch (error) {
      logger.warn('Failed to connect to Redis, using in-memory stores', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const server = app.listen(PORT, () => {
    logger.info(`Wayfinder server listening on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    server.close(() => {
      logger.info('HTTP server closed');
    });

    if (dependencies.redis) {
      await dependencies.redis.quit();
      logger.info('Redis connection closed');
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Failed to start server', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});
