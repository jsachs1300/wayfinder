/**
 * Cache type definitions
 */

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** LangCache API base URL */
  serverURL: string;
  /** Cache ID for the cache instance */
  cacheId: string;
  /** LangCache API authentication token */
  apiKey: string;
  /** Semantic similarity threshold (0.0 - 1.0) */
  similarityThreshold: number;
  /** TTL for cache entries in seconds (optional) */
  ttl?: number;
  /** Timeout for cache read operations in milliseconds (optional, default: 5000ms) */
  timeoutMs?: number;
  /** Timeout for cache write operations in milliseconds (optional, default: 3000ms) */
  writeTimeoutMs?: number;
  /** Timeout for cache flush operations in milliseconds (optional, default: 10000ms) */
  flushTimeoutMs?: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total number of cache hits */
  hits: number;
  /** Total number of cache misses */
  misses: number;
  /** Total number of successful cache store operations */
  stores: number;
  /** Cache hit rate (hits / (hits + misses)) */
  hit_rate: number;
  /** Last updated timestamp */
  last_updated: string;
}

/**
 * Cache attributes for scoping and filtering
 */
export interface CacheAttributes extends Record<string, string> {
  /** Token ID for cache isolation */
  scope: string;
  /** Router model variant (openai, gemini, or consensus) */
  router_model: 'openai' | 'gemini' | 'consensus';
}

/**
 * Cached route decision
 * Extends the core RouteDecision with cache metadata
 */
export interface CachedRouteDecision {
  /** The cached routing decision */
  decision: any; // Will be typed as RouteDecision from types/index.ts
  /** When this entry was cached */
  cached_at: string;
  /** Cache entry ID for tracking */
  entry_id?: string;
}
