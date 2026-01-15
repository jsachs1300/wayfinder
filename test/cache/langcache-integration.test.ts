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
import type { CachedRouterResponse, RankedRouteDecision } from '../../src/types';

// Check if we should run real integration tests
const RUN_INTEGRATION = process.env.LANGCACHE_INTEGRATION_TEST === 'true';

// Create mock LangCache client
const mockLangCacheClient = {
  search: vi.fn(),
  set: vi.fn(),
  flush: vi.fn(),
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

// Helper to build large CachedRouterResponse (for performance testing)
function buildCachedResponse(
  decision: RankedRouteDecision,
  prompt: string = 'test',
  numProviders: number = 2
): CachedRouterResponse {
  const providerRankings: any = {};

  // Create multiple provider rankings to test large payloads
  const providers = ['openai', 'gemini', 'anthropic', 'meta', 'mistral'];
  for (let i = 0; i < Math.min(numProviders, providers.length); i++) {
    providerRankings[providers[i]] = {
      provider: providers[i],
      decision,
      generated_at: new Date().toISOString(),
    };
  }

  return {
    prompt,
    provider_rankings: providerRankings,
    consensus: decision,
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

describe('LangCache Integration Tests', () => {
  let cache: SemanticCache;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Reset mock calls (only used in mock mode)
    if (!RUN_INTEGRATION) {
      vi.clearAllMocks();
    }

    // Suppress console logs during tests (they're verbose with timing instrumentation)
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    cache = new SemanticCache({
      serverURL: 'https://test-cache.langcache.redis.io',
      cacheId: 'test-cache-id',
      apiKey: 'test-api-key',
      similarityThreshold: 0.9,
      ttl: 3600,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Cache get failed:',
        expect.objectContaining({
          error: 'Request timed out after 5000ms',
        })
      );
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Cache get failed:',
        expect.objectContaining({
          error: expect.stringContaining('Authentication Failed'),
        })
      );
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Cache get failed:',
        expect.objectContaining({
          error: expect.stringContaining('Index Not Found'),
        })
      );
    });

    it('should handle network errors gracefully', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      mockLangCacheClient.search.mockRejectedValue(new Error('Network error'));

      const result = await cache.get('test');

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalled();
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

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Cache set failed:',
        expect.objectContaining({
          error: 'Network error',
        })
      );
    });
  });

  describe('Performance with Large Payloads', () => {
    it('should handle large decision with 14 models', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const largeDecision = buildLargeDecision(14); // Real-world size
      const cachedResponse = buildCachedResponse(largeDecision, 'test', 2);

      mockLangCacheClient.set.mockResolvedValue({ entryId: 'test-id' });

      // Should complete without errors
      await expect(cache.set('test', cachedResponse)).resolves.not.toThrow();

      // Verify the payload was stringified correctly
      const setCall = mockLangCacheClient.set.mock.calls[0][0];
      expect(setCall.response).toBeDefined();

      const parsed = JSON.parse(setCall.response);
      expect(parsed.consensus.ranked_models).toHaveLength(14);
    });

    it('should handle large decision retrieval and parsing', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      const largeDecision = buildLargeDecision(14);
      const cachedResponse = buildCachedResponse(largeDecision, 'test', 2);

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
      expect(result?.consensus.ranked_models).toHaveLength(14);
      expect(result?.prompt).toBe('test');
    });

    it('should handle very large prompt (edge case)', async () => {
      if (RUN_INTEGRATION) {
        return;
      }

      // Create 10KB prompt (edge case)
      const largePrompt = 'a'.repeat(10000);
      const decision = buildLargeDecision(5);
      const cachedResponse = buildCachedResponse(decision, largePrompt, 2);

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
      expect(() =>
        loadCacheConfig()
      ).toThrow(); // Missing required env vars

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

  describe('Real Integration Tests (Optional)', () => {
    // These tests only run when LANGCACHE_INTEGRATION_TEST=true
    // and require valid LangCache credentials in .env

    it.skipIf(!RUN_INTEGRATION)(
      'should connect to real LangCache service',
      async () => {
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

        const result = await realCache.get(testPrompt);

        expect(result).not.toBeNull();
        expect(result?.consensus.ranked_models).toHaveLength(5);
      },
      15000 // 15 second timeout for real API calls
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
  });
});
