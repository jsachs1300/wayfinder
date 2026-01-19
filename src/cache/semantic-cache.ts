/**
 * Global Semantic Cache implementation using Redis LangCache
 *
 * Design principles:
 * - Global cache shared across all tokens (no token isolation at cache layer)
 * - Pure semantic matching on prompts only
 * - Cache is queried AFTER policy evaluation
 * - Cache is queried BEFORE router LLM invocation
 * - Cache operations never block routing (graceful degradation)
 * - App handles token-specific behavior at route lookup time, not in cache
 *
 * Rationale:
 * - Routing decisions are often universal (same prompt → same model for all users)
 * - Token-specific policies handled by policy layer, not cache layer
 * - Higher cache hit rates = better cost savings
 * - Simpler implementation = fewer bugs
 */

import { LangCache } from '@redis-ai/langcache';
import { createHash } from 'crypto';
import type { CacheConfig, CacheStats, CacheAttributes } from './types';
import type { CachedRouterResponse } from '../types/index';
import { logger } from '../logging';

// LangCache types (from @redis-ai/langcache/models)
// Defining locally to avoid module resolution issues with older TypeScript moduleResolution: "node"
type SearchStrategy = 'exact' | 'semantic';
const SearchStrategy = {
  Exact: 'exact' as const,
  Semantic: 'semantic' as const,
};

interface CacheEntry {
  response: string;
  similarity?: number;
  searchStrategy?: string;
}

interface SearchResponse {
  data: CacheEntry[];
}

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
   * Get a cached routing decision using semantic matching with attributes
   *
   * @param prompt - User's prompt
   * @param attributes - Optional cache attributes for scoping (scope, router_model)
   * @returns Cached CachedRouterResponse or null if not found
   */
  async get(prompt: string, attributes?: CacheAttributes): Promise<CachedRouterResponse | null> {
    try {
      logger.debug('LangCache search started', {
        prompt_hash: this.hashPrompt(prompt),
        prompt_length: prompt.length,
        similarityThreshold: this.config.similarityThreshold,
        attributes,
      });

      const result: SearchResponse = await this.client.search({
        prompt,
        searchStrategies: [SearchStrategy.Semantic],
        similarityThreshold: this.config.similarityThreshold,
        ...(attributes && { attributes }),
      }, {
        timeoutMs: this.config.timeoutMs ?? 5000, // Configurable timeout to prevent cache from blocking routing
      });

      // LangCache returns { data: [{ response, similarity, ... }] } structure
      // Check if we have data array with at least one result
      if (!result?.data || result.data.length === 0 || !result.data[0]?.response) {
        logger.debug('LangCache cache miss', {
          prompt_hash: this.hashPrompt(prompt),
        });
        this.stats.misses++;
        return null;
      }

      // Parse cached response from first result (stored as JSON string)
      const cachedResponse = JSON.parse(result.data[0].response) as CachedRouterResponse;

      logger.debug('LangCache cache hit', {
        prompt_hash: this.hashPrompt(prompt),
        similarity: result.data[0].similarity,
        searchStrategy: result.data[0].searchStrategy,
        consensus_top_model: cachedResponse.consensus.ranked_models[0]?.model,
      });
      this.stats.hits++;

      return cachedResponse;
    } catch (error) {
      // Graceful degradation: log error and return null
      // Cache failures should never block routing
      logger.error('Cache get failed', {
        error: error instanceof Error ? error.message : String(error),
        prompt_hash: this.hashPrompt(prompt),
      });
      this.stats.misses++;
      return null;
    }
  }

  /**
   * Store a routing decision in cache with optional attributes
   *
   * @param prompt - User's prompt
   * @param response - CachedRouterResponse to cache (all provider rankings + consensus)
   * @param attributes - Optional cache attributes for scoping (scope, router_model)
   */
  async set(prompt: string, response: CachedRouterResponse, attributes?: CacheAttributes): Promise<void> {
    try {
      logger.debug('LangCache set started', {
        prompt_hash: this.hashPrompt(prompt),
        prompt_length: prompt.length,
        ttl: this.config.ttl,
        attributes,
      });

      // Store response with attributes for token-scoped caching
      await this.client.set({
        prompt,
        response: JSON.stringify(response),
        ttlMillis: this.config.ttl ? this.config.ttl * 1000 : undefined, // Convert seconds to milliseconds
        ...(attributes && { attributes }),
      }, {
        timeoutMs: this.config.writeTimeoutMs ?? 3000, // Configurable timeout for cache writes
      });

      logger.debug('LangCache set completed', {
        prompt_hash: this.hashPrompt(prompt),
      });

      this.stats.stores++;
    } catch (error) {
      logger.error('Cache set failed', {
        error: error instanceof Error ? error.message : String(error),
        prompt_hash: this.hashPrompt(prompt),
      });
      // Re-throw so routing engine can log via logger.warn
      // The routing engine's .catch() handler prevents this from blocking routing
      throw error;
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
      stores: this.stats.stores,
      hit_rate: parseFloat(hitRate.toFixed(4)),
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Clear cache for a specific token scope
   *
   * @param tokenId - Token ID to clear cache for
   */
  async clearByScope(tokenId: string): Promise<void> {
    try {
      logger.debug('Clearing cache for token scope', {
        token_id: tokenId,
      });

      // Use deleteQuery to delete only entries with matching scope attribute
      // Note: flush() deletes the ENTIRE cache - deleteQuery() filters by attributes
      await this.client.deleteQuery({
        attributes: {
          scope: tokenId,
        },
      }, {
        timeoutMs: this.config.flushTimeoutMs ?? 10000,
      });

      logger.info('Cache cleared for token scope', {
        token_id: tokenId,
      });
    } catch (error) {
      logger.error('Cache clear by scope failed', {
        error: error instanceof Error ? error.message : String(error),
        token_id: tokenId,
      });
      throw error;
    }
  }

  /**
   * Clear entire cache
   *
   * Note: Clears all cached routing decisions across all tokens
   */
  async clear(): Promise<void> {
    try {
      await this.client.flush(undefined, {
        timeoutMs: this.config.flushTimeoutMs ?? 10000, // Configurable timeout for flush operation
      });
    } catch (error) {
      // Log error and re-throw for admin endpoint to handle
      logger.error('Cache clear failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the configured TTL (time-to-live) for cache entries
   *
   * @returns TTL in seconds
   */
  getTTL(): number {
    return this.config.ttl ?? 3600; // Default 1 hour if not configured
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
 * Create SHA256 hash of prompt for privacy-safe logging
 *
 * @param prompt - User's prompt
 * @returns SHA256 hash of prompt (truncated to 16 chars)
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}
