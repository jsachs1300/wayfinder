import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { RedisTokenStore } from '../../src/tokens/store';

describe('RedisTokenStore', () => {
  it('retries stale cleanup when EXEC returns null during deleteUserToken', async () => {
    const watch = vi.fn().mockResolvedValue('OK');
    const unwatch = vi.fn().mockResolvedValue('OK');
    const sismember = vi.fn().mockResolvedValue(1);
    const scard = vi.fn().mockResolvedValue(2);
    const get = vi.fn().mockResolvedValue(null);
    const multi = vi.fn();

    const firstCleanupTx = {
      srem: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null),
    };
    const secondCleanupTx = {
      srem: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 1], [null, 1]]),
    };
    multi.mockReturnValueOnce(firstCleanupTx).mockReturnValueOnce(secondCleanupTx);

    const redis = {
      watch,
      unwatch,
      sismember,
      scard,
      get,
      multi,
    } as unknown as Redis;

    const store = new RedisTokenStore(redis);
    const result = await store.deleteUserToken('user-1', 'token-1');

    expect(result).toEqual({ deleted: false, reason: 'not_found' });
    expect(watch).toHaveBeenCalledTimes(2);
    expect(firstCleanupTx.exec).toHaveBeenCalledTimes(1);
    expect(secondCleanupTx.exec).toHaveBeenCalledTimes(1);
  });
});
