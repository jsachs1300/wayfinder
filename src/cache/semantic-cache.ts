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
import type { CacheConfig, CacheStats } from './types';
import type { RankedRouteDecision } from '../types/index';

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
   * Get a cached routing decision using global semantic matching
   *
   * @param prompt - User's prompt
   * @returns Cached RankedRouteDecision or null if not found
   */
  async get(prompt: string): Promise<RankedRouteDecision | null> {
    try {
      // Search for cached entries using semantic matching
      // Semantic match finds similar prompts (e.g., "analyze csv" ≈ "process csv")
      // No token isolation - cache is shared across all tokens
      const result = await this.client.search({
        prompt,
        searchStrategies: ['semantic' as any], // LangCache SearchStrategy enum
        similarityThreshold: this.config.similarityThreshold,
      });

      // Log full LangCache response to diagnose cache retrieval issues
      console.log('LangCache search() full response:', JSON.stringify(result, null, 2));
      console.log('LangCache search() input:', {
        prompt_hash: this.hashPrompt(prompt),
        prompt_length: prompt.length,
        similarityThreshold: this.config.similarityThreshold,
        config: {
          serverURL: this.config.serverURL,
          cacheId: this.config.cacheId,
        },
      });

      // LangCache returns null or undefined if no match found
      // The response field contains the cached data
      if (!result || !(result as any).response) {
        console.log('LangCache search() returned no match:', {
          result_is_null: result === null,
          result_is_undefined: result === undefined,
          result_has_response: result && !!(result as any).response,
          prompt_hash: this.hashPrompt(prompt),
        });
        this.stats.misses++;
        return null;
      }

      // Parse cached response (stored as JSON string)
      const cachedDecision = JSON.parse((result as any).response) as RankedRouteDecision;
      this.stats.hits++;

      return cachedDecision;
    } catch (error) {
      // Graceful degradation: log error and return null
      // Cache failures should never block routing
      console.error('Cache get failed:', {
        error: error instanceof Error ? error.message : String(error),
        prompt_hash: this.hashPrompt(prompt),
      });
      this.stats.misses++;
      return null;
    }
  }

  /**
   * Store a routing decision in global cache
   *
   * @param prompt - User's prompt
   * @param decision - RankedRouteDecision to cache (full ranked list)
   */
  async set(prompt: string, decision: RankedRouteDecision): Promise<void> {
    try {
      // Store decision as JSON string in global cache
      // No token scoping - any token can retrieve this cached decision
      const setResult = await this.client.set({
        prompt,
        response: JSON.stringify(decision),
        ttl: this.config.ttl,
      });

      // Log full LangCache response to diagnose cache save issues
      console.log('LangCache set() full response:', JSON.stringify(setResult, null, 2));
      console.log('LangCache set() input:', {
        prompt_hash: this.hashPrompt(prompt),
        prompt_length: prompt.length,
        response_length: JSON.stringify(decision).length,
        ttl: this.config.ttl,
        config: {
          serverURL: this.config.serverURL,
          cacheId: this.config.cacheId,
          similarityThreshold: this.config.similarityThreshold,
        },
      });

      this.stats.stores++;
    } catch (error) {
      // Log error for debugging (appears in console.error)
      console.error('Cache set failed:', {
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
   * Clear entire global cache
   *
   * Note: Since cache is global (no token isolation), this clears all cached routing decisions
   */
  async clear(): Promise<void> {
    try {
      await this.client.flush();
    } catch (error) {
      // Log error and re-throw for admin endpoint to handle
      console.error('Cache clear failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
 * Create SHA256 hash of prompt for privacy-safe logging
 *
 * @param prompt - User's prompt
 * @returns SHA256 hash of prompt (truncated to 16 chars)
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}
