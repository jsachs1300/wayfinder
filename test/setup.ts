import { afterAll } from 'vitest';
import { cleanupSharedRedis } from '../src/redis/shared';

// Cloud Build exposes trigger substitutions with underscore-prefixed names.
// Map them to the LangCache env vars used by tests.
if (!process.env.LANGCACHE_HOST && process.env._LANGCACHE_HOST) {
  process.env.LANGCACHE_HOST = process.env._LANGCACHE_HOST;
}
if (!process.env.LANGCACHE_CACHE_ID && process.env._LANGCACHE_CACHE_ID) {
  process.env.LANGCACHE_CACHE_ID = process.env._LANGCACHE_CACHE_ID;
}
if (!process.env.LANGCACHE_API_KEY && process.env._LANGCACHE_API_KEY) {
  process.env.LANGCACHE_API_KEY = process.env._LANGCACHE_API_KEY;
}

afterAll(async () => {
  await cleanupSharedRedis();
});
