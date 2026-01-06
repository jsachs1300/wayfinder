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
import type { RouteDecision } from '../../src/types';

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
    });
  });

  describe('get()', () => {
    it('should return null on cache miss', async () => {
      mockLangCacheClient.search.mockResolvedValue(null);

      const result = await cache.get('test prompt');

      expect(result).toBeNull();
      expect(mockLangCacheClient.search).toHaveBeenCalledWith({
        prompt: 'test prompt',
        searchStrategies: ['semantic'],
        similarityThreshold: 0.9,
      });
    });

    it('should return cached decision on cache hit', async () => {
      const cachedDecision: RouteDecision = {
        intent: 'coding',
        primary: {
          model: 'gpt-4-turbo',
          score: 8.5,
          reason: 'Best for coding tasks',
        },
        alternate: {
          model: 'claude-3-5-sonnet',
          score: 8.0,
          reason: 'Good alternative',
        },
      };

      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify(cachedDecision),
      });

      const result = await cache.get('test prompt');

      expect(result).toEqual(cachedDecision);
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
      expect(mockLangCacheClient.search).toHaveBeenCalledWith({
        prompt: 'process a csv file',
        searchStrategies: ['semantic'],
        similarityThreshold: 0.9,
      });

      // Verify attributes field is not present
      const callArgs = mockLangCacheClient.search.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('attributes');
    });
  });

  describe('set()', () => {
    it('should store decision in global cache without scoping', async () => {
      const decision: RouteDecision = {
        intent: 'coding',
        primary: {
          model: 'gpt-4-turbo',
          score: 8.5,
          reason: 'Best for coding',
        },
        alternate: {
          model: 'claude-3-5-sonnet',
          score: 8.0,
          reason: 'Good alternative',
        },
      };

      await cache.set('test prompt', decision);

      expect(mockLangCacheClient.set).toHaveBeenCalledWith({
        prompt: 'test prompt',
        response: JSON.stringify(decision),
        ttl: 3600,
      });

      // Verify no attributes (token isolation or policy scoping) are used
      const callArgs = mockLangCacheClient.set.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('attributes');
    });

    it('should not throw on cache store failure (graceful degradation)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLangCacheClient.set.mockRejectedValue(new Error('Network error'));

      const decision: RouteDecision = {
        intent: 'coding',
        primary: { model: 'gpt-4', score: 8, reason: 'test' },
        alternate: { model: 'claude-3', score: 7, reason: 'test' },
      };

      await expect(cache.set('test', decision)).resolves.not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('getStats()', () => {
    it('should return cache statistics with correct hit rate', async () => {
      // Simulate 3 cache hits
      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify({ intent: 'test', primary: {}, alternate: {} }),
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
      const decision: RouteDecision = {
        intent: 'csv_processing',
        primary: { model: 'gpt-4', score: 8, reason: 'Good for data tasks' },
        alternate: { model: 'claude-3', score: 7, reason: 'Alternative' },
      };

      // First request: "process a csv file"
      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify(decision),
      });

      const result1 = await cache.get('process a csv file');
      expect(result1).toEqual(decision);

      // Second request: "analyze a csv file" (semantically similar)
      // LangCache would return the same cached decision due to semantic similarity
      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify(decision),
      });

      const result2 = await cache.get('analyze a csv file');
      expect(result2).toEqual(decision);

      // Verify both queries used pure prompts (no scoping)
      expect(mockLangCacheClient.search).toHaveBeenCalledTimes(2);
      expect(mockLangCacheClient.search).toHaveBeenNthCalledWith(1, {
        prompt: 'process a csv file',
        searchStrategies: ['semantic'],
        similarityThreshold: 0.9,
      });
      expect(mockLangCacheClient.search).toHaveBeenNthCalledWith(2, {
        prompt: 'analyze a csv file',
        searchStrategies: ['semantic'],
        similarityThreshold: 0.9,
      });
    });

    it('should share cache across all tokens (no token isolation)', async () => {
      // This test demonstrates that cache is global
      // Token A caches a decision
      const decision: RouteDecision = {
        intent: 'coding',
        primary: { model: 'gpt-4', score: 8, reason: 'test' },
        alternate: { model: 'claude-3', score: 7, reason: 'test' },
      };

      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify(decision),
      });

      // Any token can retrieve it (no token_id in cache key)
      const result = await cache.get('same prompt');
      expect(result).toEqual(decision);

      // Verify no token scoping in search
      expect(mockLangCacheClient.search).toHaveBeenCalledWith({
        prompt: 'same prompt',
        searchStrategies: ['semantic'],
        similarityThreshold: 0.9,
      });
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
