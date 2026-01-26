import type Redis from 'ioredis';

export interface TokenUsageMetrics {
  route_requests: number;
  cache_hits: number;
}

export interface TokenMetricsStore {
  incrementRouteRequest(tokenId: string, cacheHit: boolean): Promise<void>;
  getMetrics(tokenId: string): Promise<TokenUsageMetrics>;
  getMetricsBulk(tokenIds: string[]): Promise<Record<string, TokenUsageMetrics>>;
}

const METRICS_PREFIX = 'wayfinder:token:metrics:';

function routeRequestsKey(tokenId: string): string {
  return `${METRICS_PREFIX}${tokenId}:route_requests`;
}

function cacheHitsKey(tokenId: string): string {
  return `${METRICS_PREFIX}${tokenId}:cache_hits`;
}

export class RedisTokenMetricsStore implements TokenMetricsStore {
  constructor(private readonly redis: Redis) {}

  async incrementRouteRequest(tokenId: string, cacheHit: boolean): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.incr(routeRequestsKey(tokenId));
    if (cacheHit) {
      pipeline.incr(cacheHitsKey(tokenId));
    }
    await pipeline.exec();
  }

  async getMetrics(tokenId: string): Promise<TokenUsageMetrics> {
    const pipeline = this.redis.multi();
    pipeline.get(routeRequestsKey(tokenId));
    pipeline.get(cacheHitsKey(tokenId));
    const result = await pipeline.exec();
    const routeRequests = Number(result?.[0]?.[1] ?? 0);
    const cacheHits = Number(result?.[1]?.[1] ?? 0);
    return {
      route_requests: Number.isNaN(routeRequests) ? 0 : routeRequests,
      cache_hits: Number.isNaN(cacheHits) ? 0 : cacheHits,
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
    });
    const result = await pipeline.exec();
    const metrics: Record<string, TokenUsageMetrics> = {};
    tokenIds.forEach((tokenId, index) => {
      const routeIdx = index * 2;
      const cacheIdx = routeIdx + 1;
      const routeRequests = Number(result?.[routeIdx]?.[1] ?? 0);
      const cacheHits = Number(result?.[cacheIdx]?.[1] ?? 0);
      metrics[tokenId] = {
        route_requests: Number.isNaN(routeRequests) ? 0 : routeRequests,
        cache_hits: Number.isNaN(cacheHits) ? 0 : cacheHits,
      };
    });
    return metrics;
  }
}

export function createTokenMetricsStore(redis?: Redis): TokenMetricsStore | undefined {
  if (!redis) return undefined;
  return new RedisTokenMetricsStore(redis);
}
