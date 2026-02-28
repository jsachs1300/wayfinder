import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import { RedisTokenMetricsStore, createTokenMetricsStore } from '../../src/tokens/metrics';

describe('RedisTokenMetricsStore', () => {
  let redis: Redis;
  let store: RedisTokenMetricsStore;

  beforeEach(() => {
    redis = new Redis();
    store = new RedisTokenMetricsStore(redis as unknown as Redis);
  });

  afterEach(async () => {
    await redis.quit();
  });

  it('incrementRouteRequest increments route_requests counter', async () => {
    await store.incrementRouteRequest('token-1', false);
    const metrics = await store.getMetrics('token-1');
    expect(metrics).toEqual({ route_requests: 1, cache_hits: 0, throttled_requests: 0 });
  });

  it('incrementRouteRequest with cacheHit=true increments both counters', async () => {
    await store.incrementRouteRequest('token-2', true);
    const metrics = await store.getMetrics('token-2');
    expect(metrics).toEqual({ route_requests: 1, cache_hits: 1, throttled_requests: 0 });
  });

  it('getMetrics returns correct values for existing metrics', async () => {
    await store.incrementRouteRequest('token-3', false);
    await store.incrementRouteRequest('token-3', true);
    await store.incrementThrottled('token-3');
    const metrics = await store.getMetrics('token-3');
    expect(metrics).toEqual({ route_requests: 2, cache_hits: 1, throttled_requests: 1 });
  });

  it('getMetrics returns zeros for non-existent token', async () => {
    const metrics = await store.getMetrics('missing-token');
    expect(metrics).toEqual({ route_requests: 0, cache_hits: 0, throttled_requests: 0 });
  });

  it('getMetricsBulk handles empty array input', async () => {
    const metrics = await store.getMetricsBulk([]);
    expect(metrics).toEqual({});
  });

  it('incrementThrottled increments throttled_requests counter', async () => {
    await store.incrementThrottled('token-throttle');
    const metrics = await store.getMetrics('token-throttle');
    expect(metrics).toEqual({ route_requests: 0, cache_hits: 0, throttled_requests: 1 });
  });

  it('getMetricsBulk returns metrics for multiple tokens', async () => {
    await store.incrementRouteRequest('token-a', false);
    await store.incrementRouteRequest('token-b', true);
    await store.incrementRouteRequest('token-b', true);
    await store.incrementThrottled('token-b');

    const metrics = await store.getMetricsBulk(['token-a', 'token-b']);
    expect(metrics['token-a']).toEqual({ route_requests: 1, cache_hits: 0, throttled_requests: 0 });
    expect(metrics['token-b']).toEqual({ route_requests: 2, cache_hits: 2, throttled_requests: 1 });
  });

  it('deleteMetrics clears all counters for a token', async () => {
    await store.incrementRouteRequest('token-delete', true);
    await store.incrementThrottled('token-delete');
    await store.deleteMetrics('token-delete');
    const metrics = await store.getMetrics('token-delete');
    expect(metrics).toEqual({ route_requests: 0, cache_hits: 0, throttled_requests: 0 });
  });

  it('createTokenMetricsStore returns undefined when Redis is not available', () => {
    const result = createTokenMetricsStore(undefined);
    expect(result).toBeUndefined();
  });
});

describe('RedisTokenMetricsStore pipeline errors', () => {
  function createMockRedis(results: Array<[Error | null, unknown]> | null) {
    const pipeline = {
      incr: () => pipeline,
      get: () => pipeline,
      del: () => pipeline,
      exec: async () => results,
    };
    return {
      multi: () => pipeline,
    };
  }

  it('incrementRouteRequest throws when pipeline exec returns null', async () => {
    const store = new RedisTokenMetricsStore(createMockRedis(null) as any);
    await expect(store.incrementRouteRequest('token-err', false)).rejects.toThrow(
      'Redis transaction aborted'
    );
  });

  it('incrementRouteRequest throws on pipeline command error', async () => {
    const store = new RedisTokenMetricsStore(createMockRedis([[new Error('boom'), null]]) as any);
    await expect(store.incrementRouteRequest('token-err', false)).rejects.toThrow('boom');
  });

  it('getMetrics throws when pipeline exec returns null', async () => {
    const store = new RedisTokenMetricsStore(createMockRedis(null) as any);
    await expect(store.getMetrics('token-err')).rejects.toThrow('Redis transaction aborted');
  });

  it('getMetrics throws on pipeline command error', async () => {
    const store = new RedisTokenMetricsStore(createMockRedis([[new Error('boom'), null]]) as any);
    await expect(store.getMetrics('token-err')).rejects.toThrow('boom');
  });

  it('getMetricsBulk throws when pipeline exec returns null', async () => {
    const store = new RedisTokenMetricsStore(createMockRedis(null) as any);
    await expect(store.getMetricsBulk(['token-err'])).rejects.toThrow(
      'Redis transaction aborted'
    );
  });

  it('getMetricsBulk throws on pipeline command error', async () => {
    const store = new RedisTokenMetricsStore(createMockRedis([[new Error('boom'), null]]) as any);
    await expect(store.getMetricsBulk(['token-err'])).rejects.toThrow('boom');
  });
});
