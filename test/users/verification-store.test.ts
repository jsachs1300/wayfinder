import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { RedisUserVerificationStore } from '../../src/users/verification-store';

function createPipeline(execResults: Array<Array<[Error | null, unknown]> | null>) {
  const pipeline = {
    del: vi.fn().mockReturnThis(),
    setex: vi.fn().mockReturnThis(),
    exec: vi.fn().mockImplementation(async () => {
      if (execResults.length === 0) {
        return [[null, 'OK']];
      }
      return execResults.shift() as Array<[Error | null, unknown]> | null;
    }),
  };
  return pipeline;
}

describe('RedisUserVerificationStore', () => {
  it('retries createEmailVerification when WATCH transaction is aborted', async () => {
    const execResults: Array<Array<[Error | null, unknown]> | null> = [
      null,
      [[null, 1], [null, 'OK'], [null, 'OK']],
    ];
    const pipelines = [createPipeline(execResults), createPipeline(execResults)];
    const watchMock = vi.fn().mockResolvedValue('OK');
    const getMock = vi.fn().mockResolvedValue('old-token-hash');
    const duplicateRedis = {
      status: 'ready',
      watch: watchMock,
      get: getMock,
      multi: vi.fn()
        .mockReturnValueOnce(pipelines[0])
        .mockReturnValueOnce(pipelines[1]),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: vi.fn().mockReturnValue(duplicateRedis),
    } as unknown as Redis;

    const store = new RedisUserVerificationStore(redis);
    const token = await store.createEmailVerification('user-1', 'user@example.com', 60);

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(pipelines[0].exec).toHaveBeenCalledTimes(1);
    expect(pipelines[1].exec).toHaveBeenCalledTimes(1);
    expect((redis as any).duplicate).toHaveBeenCalledTimes(1);
    expect(duplicateRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('retries createPasswordReset when WATCH transaction is aborted', async () => {
    const execResults: Array<Array<[Error | null, unknown]> | null> = [
      null,
      [[null, 1], [null, 'OK'], [null, 'OK']],
    ];
    const pipelines = [createPipeline(execResults), createPipeline(execResults)];
    const watchMock = vi.fn().mockResolvedValue('OK');
    const getMock = vi.fn().mockResolvedValue('old-reset-hash');
    const duplicateRedis = {
      status: 'ready',
      watch: watchMock,
      get: getMock,
      multi: vi.fn()
        .mockReturnValueOnce(pipelines[0])
        .mockReturnValueOnce(pipelines[1]),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: vi.fn().mockReturnValue(duplicateRedis),
    } as unknown as Redis;

    const store = new RedisUserVerificationStore(redis);
    const token = await store.createPasswordReset('user-2', 'user2@example.com', 60);

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(pipelines[0].exec).toHaveBeenCalledTimes(1);
    expect(pipelines[1].exec).toHaveBeenCalledTimes(1);
    expect((redis as any).duplicate).toHaveBeenCalledTimes(1);
    expect(duplicateRedis.quit).toHaveBeenCalledTimes(1);
  });
});
