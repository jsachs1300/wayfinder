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
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total number of cache hits */
  hits: number;
  /** Total number of cache misses */
  misses: number;
  /** Total number of cache entries stored */
  entries: number;
  /** Cache hit rate (hits / (hits + misses)) */
  hit_rate: number;
  /** Last updated timestamp */
  last_updated: string;
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
