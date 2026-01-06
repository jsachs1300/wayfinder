/**
 * Semantic Cache Tests
 *
 * Tests the semantic caching implementation including:
 * - Cache hit/miss behavior
 * - Token isolation
 * - Policy-aware caching (eligible models hash)
 * - Graceful degradation
 * - Stats and admin endpoints
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SemanticCache, hashEligibleModels, hashPrompt } from '../../src/cache';
import type { RouteDecision } from '../../src/types';

// Create mock LangCache client
const mockLangCacheClient = {
  search: vi.fn(),
  set: vi.fn(),
  deleteQuery: vi.fn(),
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

describe('SemanticCache', () => {
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

      const result = await cache.get('test prompt', 'token-1', 'hash-123');

      expect(result).toBeNull();
      expect(mockLangCacheClient.search).toHaveBeenCalledWith({
        prompt: 'test prompt',
        attributes: {
          token_id: 'token-1',
          eligible_models_hash: 'hash-123',
        },
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

      const result = await cache.get('test prompt', 'token-1', 'hash-123');

      expect(result).toEqual(cachedDecision);
    });

    it('should return null and log error on cache failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLangCacheClient.search.mockRejectedValue(new Error('Network error'));

      const result = await cache.get('test prompt', 'token-1', 'hash-123');

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('should use token_id and eligible_models_hash as attributes', async () => {
      mockLangCacheClient.search.mockResolvedValue(null);

      await cache.get('coding prompt', 'token-abc', 'models-xyz');

      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: {
            token_id: 'token-abc',
            eligible_models_hash: 'models-xyz',
          },
        })
      );
    });
  });

  describe('set()', () => {
    it('should store decision in cache with correct attributes', async () => {
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

      await cache.set('test prompt', 'token-1', 'hash-123', decision);

      expect(mockLangCacheClient.set).toHaveBeenCalledWith({
        prompt: 'test prompt',
        response: JSON.stringify(decision),
        attributes: {
          token_id: 'token-1',
          eligible_models_hash: 'hash-123',
        },
      });
    });

    it('should not throw on cache store failure (graceful degradation)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLangCacheClient.set.mockRejectedValue(new Error('Network error'));

      const decision: RouteDecision = {
        intent: 'coding',
        primary: { model: 'gpt-4', score: 8, reason: 'test' },
        alternate: { model: 'claude-3', score: 7, reason: 'test' },
      };

      await expect(
        cache.set('test', 'token-1', 'hash-1', decision)
      ).resolves.not.toThrow();

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
      await cache.get('p1', 't1', 'h1');
      await cache.get('p2', 't1', 'h1');
      await cache.get('p3', 't1', 'h1');

      // Simulate 1 cache miss
      mockLangCacheClient.search.mockResolvedValue(null);
      await cache.get('p4', 't1', 'h1');

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
    it('should clear entire cache when no token_id provided', async () => {
      await cache.clear();

      expect(mockLangCacheClient.flush).toHaveBeenCalled();
      expect(mockLangCacheClient.deleteQuery).not.toHaveBeenCalled();
    });

    it('should clear cache for specific token when token_id provided', async () => {
      await cache.clear('token-123');

      expect(mockLangCacheClient.deleteQuery).toHaveBeenCalledWith({
        attributes: {
          token_id: 'token-123',
        },
      });
      expect(mockLangCacheClient.flush).not.toHaveBeenCalled();
    });

    it('should throw error on cache clear failure', async () => {
      mockLangCacheClient.flush.mockRejectedValue(new Error('Network error'));

      await expect(cache.clear()).rejects.toThrow('Network error');
    });
  });

  describe('Token Isolation', () => {
    it('should not return cache hits for different tokens', async () => {
      // Store decision for token-1
      const decision: RouteDecision = {
        intent: 'coding',
        primary: { model: 'gpt-4', score: 8, reason: 'test' },
        alternate: { model: 'claude-3', score: 7, reason: 'test' },
      };

      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify(decision),
      });

      // Get for token-1 should hit
      const result1 = await cache.get('same prompt', 'token-1', 'hash-123');
      expect(result1).toEqual(decision);

      // Get for token-2 should query with different token_id attribute
      mockLangCacheClient.search.mockResolvedValue(null);
      const result2 = await cache.get('same prompt', 'token-2', 'hash-123');
      expect(result2).toBeNull();

      // Verify second call used token-2
      expect(mockLangCacheClient.search).toHaveBeenLastCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            token_id: 'token-2',
          }),
        })
      );
    });
  });

  describe('Policy-Aware Caching', () => {
    it('should not return cache hits when eligible models hash changes', async () => {
      const decision: RouteDecision = {
        intent: 'coding',
        primary: { model: 'gpt-4', score: 8, reason: 'test' },
        alternate: { model: 'claude-3', score: 7, reason: 'test' },
      };

      // First call with hash-abc
      mockLangCacheClient.search.mockResolvedValue({
        response: JSON.stringify(decision),
      });
      const result1 = await cache.get('prompt', 'token-1', 'hash-abc');
      expect(result1).toEqual(decision);

      // Second call with different hash (policy changed eligible models)
      mockLangCacheClient.search.mockResolvedValue(null);
      const result2 = await cache.get('prompt', 'token-1', 'hash-xyz');
      expect(result2).toBeNull();

      // Verify second call used different hash
      expect(mockLangCacheClient.search).toHaveBeenLastCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            eligible_models_hash: 'hash-xyz',
          }),
        })
      );
    });
  });
});

describe('hashEligibleModels()', () => {
  it('should create deterministic hash for model list', () => {
    const models1 = ['gpt-4', 'claude-3-opus', 'gemini-pro'];
    const models2 = ['gpt-4', 'claude-3-opus', 'gemini-pro'];

    const hash1 = hashEligibleModels(models1);
    const hash2 = hashEligibleModels(models2);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16); // truncated SHA256
  });

  it('should produce same hash regardless of order (sorted internally)', () => {
    const models1 = ['gpt-4', 'claude-3-opus', 'gemini-pro'];
    const models2 = ['gemini-pro', 'gpt-4', 'claude-3-opus'];

    const hash1 = hashEligibleModels(models1);
    const hash2 = hashEligibleModels(models2);

    expect(hash1).toBe(hash2);
  });

  it('should produce different hash for different model lists', () => {
    const models1 = ['gpt-4', 'claude-3-opus'];
    const models2 = ['gpt-4', 'gemini-pro'];

    const hash1 = hashEligibleModels(models1);
    const hash2 = hashEligibleModels(models2);

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty array', () => {
    const hash = hashEligibleModels([]);

    expect(hash).toHaveLength(16);
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
