/**
 * Cache configuration loader
 * Loads and validates LangCache configuration from environment variables
 */

import { CacheConfig } from './types';

/**
 * Load cache configuration from environment variables
 *
 * Required environment variables:
 * - LANGCACHE_HOST: LangCache API hostname (e.g., "your-cache.langcache.redis.io")
 * - LANGCACHE_CACHE_ID: Cache ID from LangCache console
 * - LANGCACHE_API_KEY: LangCache API authentication key
 *
 * Optional environment variables:
 * - LANGCACHE_SIMILARITY_THRESHOLD: Semantic similarity threshold (default: 0.9)
 * - LANGCACHE_TTL: Cache entry TTL in seconds (default: 3600)
 * - LANGCACHE_TIMEOUT_MS: Cache operation timeout in milliseconds (default: 5000)
 *
 * @throws Error if required environment variables are missing
 */
export function loadCacheConfig(): CacheConfig {
  const host = process.env.LANGCACHE_HOST;
  const cacheId = process.env.LANGCACHE_CACHE_ID;
  const apiKey = process.env.LANGCACHE_API_KEY;

  // Validate required variables
  if (!host) {
    throw new Error('LANGCACHE_HOST environment variable is required for semantic caching');
  }

  if (!cacheId) {
    throw new Error('LANGCACHE_CACHE_ID environment variable is required for semantic caching');
  }

  if (!apiKey) {
    throw new Error('LANGCACHE_API_KEY environment variable is required for semantic caching');
  }

  // Parse optional variables with defaults
  const similarityThreshold = process.env.LANGCACHE_SIMILARITY_THRESHOLD
    ? parseFloat(process.env.LANGCACHE_SIMILARITY_THRESHOLD)
    : 0.9;

  const ttl = process.env.LANGCACHE_TTL
    ? parseInt(process.env.LANGCACHE_TTL, 10)
    : 3600;

  const timeoutMs = process.env.LANGCACHE_TIMEOUT_MS
    ? parseInt(process.env.LANGCACHE_TIMEOUT_MS, 10)
    : 5000; // Default 5 second timeout

  // Validate similarity threshold range
  if (similarityThreshold < 0 || similarityThreshold > 1) {
    throw new Error(
      `LANGCACHE_SIMILARITY_THRESHOLD must be between 0 and 1, got: ${similarityThreshold}`
    );
  }

  // Validate TTL is positive
  if (ttl <= 0) {
    throw new Error(`LANGCACHE_TTL must be a positive number, got: ${ttl}`);
  }

  // Validate timeout is positive
  if (timeoutMs <= 0) {
    throw new Error(`LANGCACHE_TIMEOUT_MS must be a positive number, got: ${timeoutMs}`);
  }

  // Build server URL (ensure https://)
  const serverURL = host.startsWith('http') ? host : `https://${host}`;

  return {
    serverURL,
    cacheId,
    apiKey,
    similarityThreshold,
    ttl,
    timeoutMs,
  };
}
