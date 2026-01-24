import { afterAll } from 'vitest';
import { cleanupSharedRedis } from '../src/redis/shared';

afterAll(async () => {
  await cleanupSharedRedis();
});
