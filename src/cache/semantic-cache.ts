/**
 * Semantic Cache implementation using Redis LangCache
 *
 * Per REQUIREMENTS.md §8 step 8:
 * - Cache is queried AFTER policy evaluation
 * - Cache is queried BEFORE router LLM invocation
 * - Cache is scoped per token via token_id attribute (requires pre-configuration in Redis Cloud)
 * - Cache key includes eligible_models_hash for automatic invalidation
 * - Cache operations never block routing (graceful degradation)
 *
 * IMPORTANT: LangCache attributes must be pre-configured in Redis Cloud:
 * - token_id (string) - for token isolation
 * - eligible_models_hash (string) - for policy-aware caching
 */

import { LangCache } from '@redis-ai/langcache';
import { createHash } from 'crypto';
import type { CacheConfig, CacheStats } from './types';
import type { RouteDecision } from '../types/index';

/**
 * SemanticCache class
 * Provides semantic caching for routing decisions using LangCache
 */
export class SemanticCache {
  private client: LangCache;
  private config: CacheConfig;
  private stats: {
    hits: number;
    misses: number;
    stores: number;
  };

  constructor(config: CacheConfig) {
    this.config = config;
    this.client = new LangCache({
      serverURL: config.serverURL,
      cacheId: config.cacheId,
      apiKey: config.apiKey,
    });
    this.stats = {
      hits: 0,
      misses: 0,
      stores: 0,
    };
  }

  /**
   * Get a cached routing decision
   *
   * @param prompt - User's prompt
   * @param tokenId - Token ID for scoping
   * @param eligibleModelsHash - Hash of eligible models for cache invalidation
   * @returns Cached RouteDecision or null if not found
   */
  async get(
    prompt: string,
    tokenId: string,
    eligibleModelsHash: string
  ): Promise<RouteDecision | null> {
    try {
      // Search for semantically similar cached entries
      // Use attributes for exact-match filtering (token isolation + policy-aware)
      // Only the prompt field is used for semantic similarity matching
      const result = await this.client.search({
        prompt, // Pure prompt for semantic similarity
        attributes: {
          token_id: tokenId,
          eligible_models_hash: eligibleModelsHash,
        },
        searchStrategies: ['semantic' as any], // LangCache SearchStrategy enum
        similarityThreshold: this.config.similarityThreshold,
      });

      // LangCache returns null or undefined if no match found
      // The response field contains the cached data
      if (!result || !(result as any).response) {
        this.stats.misses++;
        return null;
      }

      // Parse cached response (stored as JSON string)
      const cachedDecision = JSON.parse((result as any).response) as RouteDecision;
      this.stats.hits++;

      return cachedDecision;
    } catch (error) {
      // Graceful degradation: log error and return null
      // Cache failures should never block routing
      console.error('Cache get failed:', {
        error: error instanceof Error ? error.message : String(error),
        token_id: tokenId,
        prompt_hash: this.hashPrompt(prompt),
      });
      this.stats.misses++;
      return null;
    }
  }

  /**
   * Store a routing decision in cache
   *
   * @param prompt - User's prompt
   * @param tokenId - Token ID for scoping
   * @param eligibleModelsHash - Hash of eligible models for cache invalidation
   * @param decision - RouteDecision to cache
   */
  async set(
    prompt: string,
    tokenId: string,
    eligibleModelsHash: string,
    decision: RouteDecision
  ): Promise<void> {
    try {
      // Store decision as JSON string with attributes for scoping
      // Pure prompt for semantic similarity, attributes for exact-match filtering
      await this.client.set({
        prompt, // Pure prompt for semantic similarity
        response: JSON.stringify(decision),
        attributes: {
          token_id: tokenId,
          eligible_models_hash: eligibleModelsHash,
        },
      });

      this.stats.stores++;
    } catch (error) {
      // Graceful degradation: log error but don't throw
      // Cache store failures should never block routing
      console.error('Cache set failed:', {
        error: error instanceof Error ? error.message : String(error),
        token_id: tokenId,
        prompt_hash: this.hashPrompt(prompt),
      });
    }
  }

  /**
   * Get cache statistics
   *
   * @returns Cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      entries: this.stats.stores,
      hit_rate: parseFloat(hitRate.toFixed(4)),
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Clear cache entries
   *
   * @param tokenId - Optional token ID to clear only that token's cache
   */
  async clear(tokenId?: string): Promise<void> {
    try {
      if (tokenId) {
        // Clear cache for specific token using attribute filtering
        await this.client.deleteQuery({
          attributes: {
            token_id: tokenId,
          },
        });
      } else {
        // Clear entire cache
        await this.client.flush();
      }
    } catch (error) {
      // Log error but don't throw (graceful degradation)
      console.error('Cache clear failed:', {
        error: error instanceof Error ? error.message : String(error),
        token_id: tokenId || 'all',
      });
      throw error; // Re-throw for admin endpoint to handle
    }
  }

  /**
   * Create SHA256 hash of prompt for privacy-safe logging
   *
   * @param prompt - User's prompt
   * @returns SHA256 hash of prompt
   */
  private hashPrompt(prompt: string): string {
    return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
  }
}

/**
 * Create deterministic hash of eligible models list
 * Used to invalidate cache when policy changes eligible models
 *
 * @param models - Array of eligible model IDs
 * @returns SHA256 hash of sorted model IDs
 */
export function hashEligibleModels(models: string[]): string {
  // Sort models for deterministic hash (order shouldn't matter)
  const sortedModels = [...models].sort();
  const modelsString = sortedModels.join(',');
  return createHash('sha256').update(modelsString).digest('hex').substring(0, 16);
}

/**
 * Create SHA256 hash of prompt for privacy-safe logging
 *
 * @param prompt - User's prompt
 * @returns SHA256 hash of prompt
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}
