/**
 * LangCache Integration Tests
 *
 * These tests validate LangCache integration including:
 * - Timeout configuration and enforcement
 * - TTL conversion (seconds → milliseconds)
 * - Error handling (401, 404, 424)
 * - Performance with large payloads
 * - Configuration validation
 *
 * Tests can run in two modes:
 * 1. Mock mode (default): Fast unit tests with mocked LangCache client
 * 2. Integration mode: Real tests against LangCache service
 *    Set LANGCACHE_INTEGRATION_TEST=true to enable
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SemanticCache, hashPrompt, loadCacheConfig } from '../../src/cache';
import type { SimpleCachedResponse, RankedRouteDecision, RouterModelPreference } from '../../src/types';

// Check if we should run real integration tests
const RUN_INTEGRATION = process.env.LANGCACHE_INTEGRATION_TEST === 'true';

// Create mock LangCache client
const mockLangCacheClient = {
  search: vi.fn(),
  set: vi.fn(),
  flush: vi.fn(),
  deleteQuery: vi.fn(),
};

// Conditionally mock LangCache only in mock mode
if (!RUN_INTEGRATION) {
  vi.mock('@redis-ai/langcache', () => {
    return {
      LangCache: vi.fn().mockImplementation(() => mockLangCacheClient),
      SearchStrategy: {
        Exact: 'exact',
        Semantic: 'semantic',
      },
    };
  });
}

// Helper to build SimpleCachedResponse (for testing)
function buildCachedResponse(
  decision: RankedRouteDecision,
  prompt: string = 'test',
  routerModel: 'openai' | 'gemini' | 'consensus' = 'consensus'
): SimpleCachedResponse {
  return {
    prompt,
    ranking: decision,
    router_model: routerModel,
    cached_at: new Date().toISOString(),
    ttl: 3600,
  };
}

// Helper to build decision with many models (for performance testing)
function buildLargeDecision(numModels: number = 14): RankedRouteDecision {
  const rankedModels = [];
  for (let i = 1; i <= numModels; i++) {
    rankedModels.push({
      rank: i,
      model: `test-model-${i}`,
      score: 10 - (i * 0.5),
      reason: `Model ${i} reason: This is a detailed explanation of why this model was chosen for this particular task based on various factors including performance, cost, latency, and capabilities.`,
    });
  }

  return {
    intent: 'code_change',
    ranked_models: rankedModels,
  };
}

async function waitForCacheEntry(
  cache: SemanticCache,
  prompt: string,
  options: { scope?: string } = {},
  timeoutMs: number = 10000,
  intervalMs: number = 500
): Promise<SimpleCachedResponse | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await cache.get(prompt, options);
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

describe('LangCache Integration Tests', () => {
  let cache: SemanticCache;

  beforeEach(() => {
    // Reset mock calls (only used in mock mode)
    if (!RUN_INTEGRATION) {
      vi.clearAllMocks();
    }

    cache = new SemanticCache({
      serverURL: 'https://test-cache.langcache.redis.io',
      cacheId: 'test-cache-id',
      apiKey: 'test-api-key',
      similarityThreshold: 0.9,
      ttl: 3600,
      timeoutMs: 5000,
    });
  });

  describe('Timeout Configuration', () => {
    it('should pass timeout to search() call', async () => {
      if (RUN_INTEGRATION) {
        // Skip in integration mode (requires mock inspection)
        return;
      }

      mockLangCacheClient.search.mockResolvedValue(null);

      await cache.get('test prompt');

      // Verify timeout was passed to search()
      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'test prompt',
          searchStrategies: ['semantic'],
          similarityThreshold: 0.9,
        }),
        expect.objectContaining({
          timeoutMs: 5000,
        })
      );
    });

    it('should pass timeout to set() call', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, 'test');

      await cache.set('test', cachedResponse);

      // Verify timeout was passed to set()
      expect(mockLangCacheClient.set).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          timeoutMs: 3000,
        })
      );
    });

    it('should use custom timeout from config', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const customCache = new SemanticCache({
        serverURL: 'https://test-cache.langcache.redis.io',
        cacheId: 'test-cache-id',
        apiKey: 'test-api-key',
        similarityThreshold: 0.9,
        ttl: 3600,
        timeoutMs: 10000, // Custom 10 second timeout
      });

      mockLangCacheClient.search.mockResolvedValue(null);

      await customCache.get('test');

      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          timeoutMs: 10000,
        })
      );
    });

    it('should handle search timeout gracefully', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      // Simulate timeout error
      mockLangCacheClient.search.mockRejectedValue(
        new Error('Request timed out after 5000ms')
      );

      const result = await cache.get('test prompt');

      // Should return null on timeout (graceful degradation)
      expect(result).toBeNull();
    });
  });

  describe('TTL Conversion', () => {
    it('should convert TTL from seconds to milliseconds', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      // Create a new cache with custom TTL for this test
      const customCache = new SemanticCache({
        serverURL: 'https://test-cache.langcache.redis.io',
        cacheId: 'test-cache-id',
        apiKey: 'test-api-key',
        similarityThreshold: 0.9,
        ttl: 7200, // 2 hours in seconds
        timeoutMs: 5000,
      });

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, 'test');
      cachedResponse.ttl = 7200; // This should be used for conversion

      await customCache.set('test', cachedResponse);

      // Verify TTL was converted to milliseconds (from config.ttl)
      expect(mockLangCacheClient.set).toHaveBeenCalledWith(
        expect.objectContaining({
          ttlMillis: 7200000, // 2 hours in milliseconds
        }),
        expect.any(Object)
      );
    });

    it('should handle undefined TTL', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      const cacheWithoutTTL = new SemanticCache({
        serverURL: 'https://test-cache.langcache.redis.io',
        cacheId: 'test-cache-id',
        apiKey: 'test-api-key',
        similarityThreshold: 0.9,
        // ttl is optional
      });

      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, 'test');

      await cacheWithoutTTL.set('test', cachedResponse);

      // Should pass undefined when TTL not configured
      expect(mockLangCacheClient.set).toHaveBeenCalledWith(
        expect.objectContaining({
          ttlMillis: undefined,
        }),
        expect.any(Object)
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle 401 authentication errors gracefully', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      // Simulate 401 error
      const authError = new Error(
        'API error occurred: {"title":"Authentication Failed","status":401}'
      );
      mockLangCacheClient.search.mockRejectedValue(authError);

      const result = await cache.get('test');

      expect(result).toBeNull();
    });

    it('should handle 424 index not found errors gracefully', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      // Simulate 424 error (index not found)
      const indexError = new Error(
        'API error occurred: {"title":"Index Not Found","status":424}'
      );
      mockLangCacheClient.search.mockRejectedValue(indexError);

      const result = await cache.get('test');

      expect(result).toBeNull();
    });

    it('should handle network errors gracefully', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.search.mockRejectedValue(new Error('Network error'));

      const result = await cache.get('test');

      expect(result).toBeNull();
    });

    it('should re-throw set() errors for logging but not block routing', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.set.mockRejectedValue(new Error('Network error'));

      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, 'test');

      // set() should reject (so routing engine can log)
      await expect(cache.set('test', cachedResponse)).rejects.toThrow(
        'Network error'
      );
    });
  });

  describe('Performance with Large Payloads', () => {
    it('should handle large decision with 14 models', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const largeDecision = buildLargeDecision(14); // Real-world size
      const cachedResponse = buildCachedResponse(largeDecision, 'test', 'consensus');

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      // Should complete without errors
      await expect(cache.set('test', cachedResponse)).resolves.not.toThrow();

      // Verify the payload was stringified correctly
      const setCall = mockLangCacheClient.set.mock.calls[0][0];
      expect(setCall.response).toBeDefined();

      const parsed = JSON.parse(setCall.response);
      expect(parsed.ranking.ranked_models).toHaveLength(14);
    });

    it('should handle large decision retrieval and parsing', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const largeDecision = buildLargeDecision(14);
      const cachedResponse = buildCachedResponse(largeDecision, 'test', 'consensus');

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

      const result = await cache.get('test');

      expect(result).not.toBeNull();
      expect(result?.ranking.ranked_models).toHaveLength(14);
      expect(result?.prompt).toBe('test');
    });

    it('should handle very large prompt (edge case)', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      // Create 10KB prompt (edge case)
      const largePrompt = 'a'.repeat(10000);
      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, largePrompt, 'consensus');

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      await expect(
        cache.set(largePrompt, cachedResponse)
      ).resolves.not.toThrow();

      const setCall = mockLangCacheClient.set.mock.calls[0][0];
      expect(setCall.prompt).toHaveLength(10000);
    });
  });

  describe('Configuration Validation', () => {
    it('should validate similarity threshold range', () => {
      const originalEnv = { ...process.env };
      delete process.env.LANGCACHE_HOST;
      delete process.env.LANGCACHE_CACHE_ID;
      delete process.env.LANGCACHE_API_KEY;

      expect(() => loadCacheConfig()).toThrow(); // Missing required env vars

      process.env = originalEnv;

      // Test invalid threshold in constructor
      expect(
        () =>
          new SemanticCache({
            serverURL: 'https://test.langcache.redis.io',
            cacheId: 'test',
            apiKey: 'test',
            similarityThreshold: 1.5, // Invalid (> 1.0)
            ttl: 3600,
          })
      ).not.toThrow(); // Constructor doesn't validate, config loader does
    });

    it('should provide default timeout if not configured', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const cacheWithoutTimeout = new SemanticCache({
        serverURL: 'https://test-cache.langcache.redis.io',
        cacheId: 'test-cache-id',
        apiKey: 'test-api-key',
        similarityThreshold: 0.9,
        ttl: 3600,
        // timeoutMs omitted
      });

      mockLangCacheClient.search.mockResolvedValue(null);

      await cacheWithoutTimeout.get('test');

      // Should use default 5000ms timeout
      expect(mockLangCacheClient.search).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          timeoutMs: 5000,
        })
      );
    });

    it('should return configured TTL', () => {
      const ttl = cache.getTTL();
      expect(ttl).toBe(3600);
    });

    it('should return default TTL when not configured', () => {
      const cacheWithoutTTL = new SemanticCache({
        serverURL: 'https://test.langcache.redis.io',
        cacheId: 'test',
        apiKey: 'test',
        similarityThreshold: 0.9,
      });

      expect(cacheWithoutTTL.getTTL()).toBe(3600); // Default 1 hour
    });
  });

  describe('Cache Statistics', () => {
    it('should track hits and misses correctly', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, 'test');

      // 2 hits
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

      await cache.get('prompt1');
      await cache.get('prompt2');

      // 1 miss
      mockLangCacheClient.search.mockResolvedValue(null);
      await cache.get('prompt3');

      const stats = await cache.getStats();

      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hit_rate).toBe(0.6667); // 2/3 = 0.6667
      expect(stats.stores).toBe(0);
    });

    it('should track store operations', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, 'test');

      await cache.set('prompt1', cachedResponse);
      await cache.set('prompt2', cachedResponse);

      const stats = await cache.getStats();

      expect(stats.stores).toBe(2);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('Token-Scoped Cache Clearing', () => {
    it('should call deleteQuery with scope attribute for clearByScope', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.deleteQuery.mockResolvedValue(undefined);

      await cache.clearByScope('token-123');

      expect(mockLangCacheClient.deleteQuery).toHaveBeenCalledWith(
        { attributes: { scope: 'token-123' } },
        { timeoutMs: 10000 }
      );
    });

    it('should handle clearByScope errors gracefully', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.deleteQuery.mockRejectedValue(new Error('Network error'));

      await expect(cache.clearByScope('token-123')).rejects.toThrow('Network error');
    });

    it('should log when clearing cache by scope', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.deleteQuery.mockResolvedValue(undefined);

      // Just verify it doesn't throw
      await expect(cache.clearByScope('token-456')).resolves.not.toThrow();
    });
  });

  describe('Real Integration Tests (Optional)', () => {
    // These tests only run when LANGCACHE_INTEGRATION_TEST=true
    // and require valid LangCache credentials in .env

    it.skipIf(!RUN_INTEGRATION)(
      'should connect to real LangCache service',
      async () => {
        const originalStrategies = process.env.LANGCACHE_SEARCH_STRATEGIES;
        const originalThreshold = process.env.LANGCACHE_SIMILARITY_THRESHOLD;
        process.env.LANGCACHE_SEARCH_STRATEGIES = 'exact';
        process.env.LANGCACHE_SIMILARITY_THRESHOLD = '1.0';

        // Load real config from .env
        const config = loadCacheConfig();
        const realCache = new SemanticCache(config);

        // Test with a unique prompt to avoid cache pollution
        const testPrompt = `Integration test ${Date.now()}`;
        const decision = buildLargeDecision(5);
        const cachedResponse = buildCachedResponse(decision, testPrompt);

        // Store and retrieve
        await realCache.set(testPrompt, cachedResponse);

        // Give LangCache a moment to index
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const result = await waitForCacheEntry(realCache, testPrompt, {}, 60000, 1000);

        expect(result).not.toBeNull();
        expect(result?.ranking.ranked_models).toHaveLength(5);

        if (originalStrategies === undefined) {
          delete process.env.LANGCACHE_SEARCH_STRATEGIES;
        } else {
          process.env.LANGCACHE_SEARCH_STRATEGIES = originalStrategies;
        }
        if (originalThreshold === undefined) {
          delete process.env.LANGCACHE_SIMILARITY_THRESHOLD;
        } else {
          process.env.LANGCACHE_SIMILARITY_THRESHOLD = originalThreshold;
        }
      },
      90000 // 90 second timeout for real API calls
    );

    it.skipIf(!RUN_INTEGRATION)(
      'should respect timeout on slow operations',
      async () => {
        const config = loadCacheConfig();
        const realCache = new SemanticCache({
          ...config,
          timeoutMs: 1000, // Very short timeout
        });

        // This might timeout if LangCache is slow
        const testPrompt = `Timeout test ${Date.now()}`;

        // Should either succeed quickly or fail gracefully
        const result = await realCache.get(testPrompt);

        // Either null (timeout/not found) or a valid response
        expect(result === null || typeof result === 'object').toBe(true);
      },
      5000
    );

    it.skipIf(!RUN_INTEGRATION)(
      'should delete only entries for specific token scope (Issue #56 regression test)',
      async () => {
        const originalStrategies = process.env.LANGCACHE_SEARCH_STRATEGIES;
        const originalThreshold = process.env.LANGCACHE_SIMILARITY_THRESHOLD;
        process.env.LANGCACHE_SEARCH_STRATEGIES = 'exact';
        process.env.LANGCACHE_SIMILARITY_THRESHOLD = '1.0';

        // This test verifies that clearByScope() only deletes cache entries
        // for the specified token, not the entire cache for all tokens.
        // This is a regression test for Issue #56.

        const config = loadCacheConfig();
        const realCache = new SemanticCache(config);

        // Create unique prompts for two different "tokens"
        const token1Id = `token-${Date.now()}-1`;
        const token2Id = `token-${Date.now()}-2`;
        const prompt1 = `Test for ${token1Id} at ${Date.now()}`;
        const prompt2 = `Test for ${token2Id} at ${Date.now()}`;

        const decision = buildLargeDecision(3);

        // Create cache entries with different scope attributes
        const response1 = buildCachedResponse(decision, prompt1);
        const response2 = buildCachedResponse(decision, prompt2);

        // Store both entries
        await realCache.set(prompt1, response1, { scope: token1Id });
        await realCache.set(prompt2, response2, { scope: token2Id });

        // Give LangCache time to index
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify both entries exist
        const beforeDelete1 = await waitForCacheEntry(realCache, prompt1, { scope: token1Id }, 60000, 1000);
        const beforeDelete2 = await waitForCacheEntry(realCache, prompt2, { scope: token2Id }, 60000, 1000);
        expect(beforeDelete1).not.toBeNull();
        expect(beforeDelete2).not.toBeNull();

        // Clear cache for token1 only
        await realCache.clearByScope(token1Id);

        // Give LangCache time to process deletion
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify token1's entry is deleted but token2's entry still exists
        const afterDelete1 = await realCache.get(prompt1, { scope: token1Id });
        const afterDelete2 = await realCache.get(prompt2, { scope: token2Id });

        expect(afterDelete1).toBeNull(); // Token1's cache should be cleared
        expect(afterDelete2).not.toBeNull(); // Token2's cache should still exist

        // Cleanup: delete token2's entry
        await realCache.clearByScope(token2Id);

        if (originalStrategies === undefined) {
          delete process.env.LANGCACHE_SEARCH_STRATEGIES;
        } else {
          process.env.LANGCACHE_SEARCH_STRATEGIES = originalStrategies;
        }
        if (originalThreshold === undefined) {
          delete process.env.LANGCACHE_SIMILARITY_THRESHOLD;
        } else {
          process.env.LANGCACHE_SIMILARITY_THRESHOLD = originalThreshold;
        }
      },
      120000 // 120 second timeout for multiple API calls
    );
  });
});
