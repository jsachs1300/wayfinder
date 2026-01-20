/**
 * Global Semantic Cache Tests
 *
 * Tests the global semantic caching implementation including:
 * - Cache hit/miss behavior
 * - Pure semantic matching (no token isolation)
 * - Graceful degradation
 * - Stats calculation
 * - Global cache clearing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SemanticCache, hashPrompt } from '../../src/cache';
import type { SimpleCachedResponse, RankedRouteDecision, RouterModelPreference } from '../../src/types';

// Create mock LangCache client
const mockLangCacheClient = {
  search: vi.fn(),
  set: vi.fn(),
  flush: vi.fn(),
};

// Mock LangCache client
vi.mock('@redis-ai/langcache', () => {
  return {
    LangCache: vi.fn().mockImplementation(() => mockLangCacheClient),
    SearchStrategy: {
      Exact: 'exact',
      Semantic: 'semantic',
    },
  };
});

// Helper to build SimpleCachedResponse from RankedRouteDecision
function buildCachedResponse(
  decision: RankedRouteDecision,
  prompt: string = 'test',
  routerModel: RouterModelPreference = 'consensus'
): SimpleCachedResponse {
  return {
    prompt,
    ranking: decision,
    router_model: routerModel,
    cached_at: new Date().toISOString(),
    ttl: 3600,
  };
}

describe('Global Semantic Cache', () => {
  let cache: SemanticCache;

  beforeEach(() => {
    // Reset mock calls
    vi.clearAllMocks();

    cache = new SemanticCache({
      serverURL: 'https://test-cache.langcache.redis.io',
      cacheId: 'test-cache-id',
      apiKey: 'test-api-key',
      similarityThreshold: 0.9,
      ttl: 3600,
      timeoutMs: 5000,
    });
  });

  describe('get()', () => {
    it('should return null on cache miss', async () => {
      mockLangCacheClient.search.mockResolvedValue(null);

      const result = await cache.get('test prompt');

      expect(result).toBeNull();
      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        {
          prompt: 'test prompt',
          searchStrategies: ['semantic'],
          similarityThreshold: 0.9,
        },
        {
          timeoutMs: 5000,
        }
      );
    });

    it('should return cached decision on cache hit', async () => {
      const rankedDecision: RankedRouteDecision = {
        intent: 'coding',
        ranked_models: [
          {
            rank: 1,
            model: 'gpt-4-turbo',
            score: 8.5,
            reason: 'Best for coding tasks',
          },
          {
            rank: 2,
            model: 'claude-3-5-sonnet',
            score: 8.0,
            reason: 'Good alternative',
          },
        ],
      };

      const cachedResponse = buildCachedResponse(rankedDecision, 'test prompt');

      // LangCache returns { data: [{ response, similarity, ... }] } structure
      mockLangCacheClient.search.mockResolvedValue({
        data: [
          {
            id: 'test-id',
            prompt: 'test prompt',
            response: JSON.stringify(cachedResponse),
            attributes: {},
            similarity: 1,
            searchStrategy: 'semantic',
          },
        ],
      });

      const result = await cache.get('test prompt');

      expect(result).toEqual(cachedResponse);
    });

    it('should return null and log error on cache failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLangCacheClient.search.mockRejectedValue(new Error('Network error'));

      const result = await cache.get('test prompt');

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('should perform pure semantic matching without scoping', async () => {
      mockLangCacheClient.search.mockResolvedValue(null);

      await cache.get('process a csv file');

      // Verify no attributes (token isolation or policy scoping) are used
      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        {
          prompt: 'process a csv file',
          searchStrategies: ['semantic'],
          similarityThreshold: 0.9,
        },
        {
          timeoutMs: 5000,
        }
      );

      // Verify attributes field is not present
      const callArgs = mockLangCacheClient.search.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('attributes');

      // Verify timeout was passed
      const options = mockLangCacheClient.search.mock.calls[0][1];
      expect(options.timeoutMs).toBe(5000);
    });
  });

  describe('set()', () => {
    it('should store decision in global cache without scoping', async () => {
      const decision: RankedRouteDecision = {
        intent: 'coding',
        ranked_models: [
          {
            rank: 1,
            model: 'gpt-4-turbo',
            score: 8.5,
            reason: 'Best for coding',
          },
          {
            rank: 2,
            model: 'claude-3-5-sonnet',
            score: 8.0,
            reason: 'Good alternative',
          },
        ],
      };

      const cachedResponse = buildCachedResponse(decision, 'test prompt');

      await cache.set('test prompt', cachedResponse);

      expect(mockLangCacheClient.set).toHaveBeenCalledWith(
        {
          prompt: 'test prompt',
          response: JSON.stringify(cachedResponse),
          ttlMillis: 3600000, // Converted to milliseconds
        },
        {
          timeoutMs: 3000,
        }
      );

      // Verify no attributes (token isolation or policy scoping) are used
      const callArgs = mockLangCacheClient.set.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('attributes');

      // Verify TTL was converted to milliseconds
      expect(callArgs.ttlMillis).toBe(3600000);

      // Verify timeout was passed
      const options = mockLangCacheClient.set.mock.calls[0][1];
      expect(options.timeoutMs).toBe(3000);
    });

    it('should reject promise on cache store failure (but caller handles gracefully)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLangCacheClient.set.mockRejectedValue(new Error('Network error'));

      const decision: RankedRouteDecision = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4', score: 8, reason: 'test' },
          { rank: 2, model: 'claude-3', score: 7, reason: 'test' },
        ],
      };

      const cachedResponse = buildCachedResponse(decision, 'test');

      // set() should reject so routing engine can log the error
      await expect(cache.set('test', cachedResponse)).rejects.toThrow('Network error');

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('getStats()', () => {
    it('should return cache statistics with correct hit rate', async () => {
      // Simulate 3 cache hits
      const decision: RankedRouteDecision = {
        intent: 'test',
        ranked_models: [{ rank: 1, model: 'gpt-4', score: 8, reason: 'test' }]
      };
      const cachedResponse = buildCachedResponse(decision, 'test');

      mockLangCacheClient.search.mockResolvedValue({
        data: [
          {
            id: 'test-id',
            prompt: 'test',
            response: JSON.stringify(cachedResponse),
            attributes: {},
            similarity: 1,
            searchStrategy: 'semantic',
          },
        ],
      });
      await cache.get('p1');
      await cache.get('p2');
      await cache.get('p3');

      // Simulate 1 cache miss
      mockLangCacheClient.search.mockResolvedValue(null);
      await cache.get('p4');

      const stats = await cache.getStats();

      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(1);
      expect(stats.hit_rate).toBe(0.75); // 3 / (3 + 1)
    });

    it('should handle zero requests correctly', async () => {
      const stats = await cache.getStats();

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hit_rate).toBe(0);
    });
  });

  describe('clear()', () => {
    it('should clear entire global cache', async () => {
      await cache.clear();

      expect(mockLangCacheClient.flush).toHaveBeenCalled();
    });

    it('should throw error on cache clear failure', async () => {
      mockLangCacheClient.flush.mockRejectedValue(new Error('Network error'));

      await expect(cache.clear()).rejects.toThrow('Network error');
    });
  });

  describe('Global Semantic Matching', () => {
    it('should return cache hits for semantically similar prompts', async () => {
      const decision: RankedRouteDecision = {
        intent: 'csv_processing',
        ranked_models: [
          { rank: 1, model: 'gpt-4', score: 8, reason: 'Good for data tasks' },
          { rank: 2, model: 'claude-3', score: 7, reason: 'Alternative' },
        ],
      };

      const cachedResponse = buildCachedResponse(decision, 'process a csv file');

      // First request: "process a csv file"
      mockLangCacheClient.search.mockResolvedValue({
        data: [
          {
            id: 'test-id-1',
            prompt: 'process a csv file',
            response: JSON.stringify(cachedResponse),
            attributes: {},
            similarity: 1,
            searchStrategy: 'semantic',
          },
        ],
      });

      const result1 = await cache.get('process a csv file');
      expect(result1).toEqual(cachedResponse);

      // Second request: "analyze a csv file" (semantically similar)
      // LangCache would return the same cached decision due to semantic similarity
      mockLangCacheClient.search.mockResolvedValue({
        data: [
          {
            id: 'test-id-1',
            prompt: 'process a csv file',
            response: JSON.stringify(cachedResponse),
            attributes: {},
            similarity: 0.95,
            searchStrategy: 'semantic',
          },
        ],
      });

      const result2 = await cache.get('analyze a csv file');
      expect(result2).toEqual(cachedResponse);

      // Verify both queries used pure prompts (no scoping)
      expect(mockLangCacheClient.search).toHaveBeenCalledTimes(2);
      expect(mockLangCacheClient.search).toHaveBeenNthCalledWith(
        1,
        {
          prompt: 'process a csv file',
          searchStrategies: ['semantic'],
          similarityThreshold: 0.9,
        },
        {
          timeoutMs: 5000,
        }
      );
      expect(mockLangCacheClient.search).toHaveBeenNthCalledWith(
        2,
        {
          prompt: 'analyze a csv file',
          searchStrategies: ['semantic'],
          similarityThreshold: 0.9,
        },
        {
          timeoutMs: 5000,
        }
      );
    });

    it('should share cache across all tokens (no token isolation)', async () => {
      // This test demonstrates that cache is global
      // Token A caches a decision
      const decision: RankedRouteDecision = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4', score: 8, reason: 'test' },
          { rank: 2, model: 'claude-3', score: 7, reason: 'test' },
        ],
      };

      const cachedResponse = buildCachedResponse(decision, 'same prompt');

      mockLangCacheClient.search.mockResolvedValue({
        data: [
          {
            id: 'test-id',
            prompt: 'same prompt',
            response: JSON.stringify(cachedResponse),
            attributes: {},
            similarity: 1,
            searchStrategy: 'semantic',
          },
        ],
      });

      // Any token can retrieve it (no token_id in cache key)
      const result = await cache.get('same prompt');
      expect(result).toEqual(cachedResponse);

      // Verify no token scoping in search
      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        {
          prompt: 'same prompt',
          searchStrategies: ['semantic'],
          similarityThreshold: 0.9,
        },
        {
          timeoutMs: 5000,
        }
      );
    });
  });
});

describe('hashPrompt()', () => {
  it('should create deterministic hash for prompt', () => {
    const prompt = 'Write a function to reverse a string';

    const hash1 = hashPrompt(prompt);
    const hash2 = hashPrompt(prompt);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16); // truncated SHA256
  });

  it('should produce different hash for different prompts', () => {
    const prompt1 = 'Write a function to reverse a string';
    const prompt2 = 'Write a function to sort an array';

    const hash1 = hashPrompt(prompt1);
    const hash2 = hashPrompt(prompt2);

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', () => {
    const hash = hashPrompt('');

    expect(hash).toHaveLength(16);
  });
});
