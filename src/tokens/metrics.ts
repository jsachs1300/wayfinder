import type Redis from 'ioredis';
import { assertRedisExecResults } from '../redis/exec';

export interface TokenUsageMetrics {
  route_requests: number;
  cache_hits: number;
  throttled_requests: number;
}

export interface TokenMetricsStore {
  incrementRouteRequest(tokenId: string, cacheHit: boolean): Promise<void>;
  incrementThrottled(tokenId: string): Promise<void>;
  getMetrics(tokenId: string): Promise<TokenUsageMetrics>;
  getMetricsBulk(tokenIds: string[]): Promise<Record<string, TokenUsageMetrics>>;
  deleteMetrics(tokenId: string): Promise<void>;
}

const METRICS_PREFIX = 'wayfinder:token:metrics:';
const DEFAULT_METRICS_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function routeRequestsKey(tokenId: string): string {
  return `${METRICS_PREFIX}${tokenId}:route_requests`;
}

function cacheHitsKey(tokenId: string): string {
  return `${METRICS_PREFIX}${tokenId}:cache_hits`;
}

function throttledRequestsKey(tokenId: string): string {
  return `${METRICS_PREFIX}${tokenId}:throttled_requests`;
}

function getMetricsTTLSeconds(): number {
  const raw = process.env.TOKEN_METRICS_TTL_SECONDS;
  if (!raw) {
    return DEFAULT_METRICS_TTL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_METRICS_TTL_SECONDS;
  }
  return parsed;
}

function addExpiryCommands(pipeline: Redis['multi'], tokenId: string): void {
  const ttlSeconds = getMetricsTTLSeconds();
  pipeline.expire(routeRequestsKey(tokenId), ttlSeconds);
  pipeline.expire(cacheHitsKey(tokenId), ttlSeconds);
  pipeline.expire(throttledRequestsKey(tokenId), ttlSeconds);
}

export class RedisTokenMetricsStore implements TokenMetricsStore {
  constructor(private readonly redis: Redis) {}

  async incrementRouteRequest(tokenId: string, cacheHit: boolean): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.incr(routeRequestsKey(tokenId));
    if (cacheHit) {
      pipeline.incr(cacheHitsKey(tokenId));
    }
    addExpiryCommands(pipeline, tokenId);
    assertRedisExecResults(await pipeline.exec(), 'tokenMetrics.incrementRouteRequest');
  }

  async incrementThrottled(tokenId: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.incr(throttledRequestsKey(tokenId));
    addExpiryCommands(pipeline, tokenId);
    assertRedisExecResults(await pipeline.exec(), 'tokenMetrics.incrementThrottled');
  }

  async getMetrics(tokenId: string): Promise<TokenUsageMetrics> {
    const pipeline = this.redis.multi();
    pipeline.get(routeRequestsKey(tokenId));
    pipeline.get(cacheHitsKey(tokenId));
    pipeline.get(throttledRequestsKey(tokenId));
    const result = assertRedisExecResults(await pipeline.exec(), 'tokenMetrics.getMetrics');
    const routeRequests = Number(result?.[0]?.[1] ?? 0);
    const cacheHits = Number(result?.[1]?.[1] ?? 0);
    const throttledRequests = Number(result?.[2]?.[1] ?? 0);
    return {
      route_requests: Number.isNaN(routeRequests) ? 0 : routeRequests,
      cache_hits: Number.isNaN(cacheHits) ? 0 : cacheHits,
      throttled_requests: Number.isNaN(throttledRequests) ? 0 : throttledRequests,
    };
  }

  async getMetricsBulk(tokenIds: string[]): Promise<Record<string, TokenUsageMetrics>> {
    if (tokenIds.length === 0) {
      return {};
    }
    const pipeline = this.redis.multi();
    tokenIds.forEach((tokenId) => {
      pipeline.get(routeRequestsKey(tokenId));
      pipeline.get(cacheHitsKey(tokenId));
      pipeline.get(throttledRequestsKey(tokenId));
    });
    const result = assertRedisExecResults(await pipeline.exec(), 'tokenMetrics.getMetricsBulk');
    const metrics: Record<string, TokenUsageMetrics> = {};
    tokenIds.forEach((tokenId, index) => {
      const routeIdx = index * 3;
      const cacheIdx = routeIdx + 1;
      const throttledIdx = routeIdx + 2;
      const routeRequests = Number(result?.[routeIdx]?.[1] ?? 0);
      const cacheHits = Number(result?.[cacheIdx]?.[1] ?? 0);
      const throttledRequests = Number(result?.[throttledIdx]?.[1] ?? 0);
      metrics[tokenId] = {
        route_requests: Number.isNaN(routeRequests) ? 0 : routeRequests,
        cache_hits: Number.isNaN(cacheHits) ? 0 : cacheHits,
        throttled_requests: Number.isNaN(throttledRequests) ? 0 : throttledRequests,
      };
    });
    return metrics;
  }

  async deleteMetrics(tokenId: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.del(routeRequestsKey(tokenId));
    pipeline.del(cacheHitsKey(tokenId));
    pipeline.del(throttledRequestsKey(tokenId));
    assertRedisExecResults(await pipeline.exec(), 'tokenMetrics.deleteMetrics');
  }
}

export function createTokenMetricsStore(redis?: Redis): TokenMetricsStore | undefined {
  if (!redis) return undefined;
  return new RedisTokenMetricsStore(redis);
}
