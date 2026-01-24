import { afterAll } from 'vitest';
import { cleanupSharedRedis } from '../src/app';

afterAll(async () => {
  await cleanupSharedRedis();
});
