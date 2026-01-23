/**
 * Cache configuration loader
 * Loads and validates LangCache configuration from environment variables
 */

import { CacheConfig } from './types';

/**
 * Load cache configuration from environment variables
 *
 * Required environment variables (unless NODE_ENV=test or development):
 * - LANGCACHE_ENABLED: Must be set to 'true' to enable caching (required for production)
 * - LANGCACHE_HOST: LangCache API hostname (e.g., "your-cache.langcache.redis.io")
 * - LANGCACHE_CACHE_ID: Cache ID from LangCache console
 * - LANGCACHE_API_KEY: LangCache API authentication key
 *
 * Optional environment variables:
 * - LANGCACHE_SIMILARITY_THRESHOLD: Semantic similarity threshold (default: 0.9)
 * - LANGCACHE_TTL: Cache entry TTL in seconds (default: 3600)
 * - LANGCACHE_TIMEOUT_MS: Cache read timeout in milliseconds (default: 5000)
 * - LANGCACHE_WRITE_TIMEOUT_MS: Cache write timeout in milliseconds (default: 3000)
 * - LANGCACHE_FLUSH_TIMEOUT_MS: Cache flush timeout in milliseconds (default: 10000)
 * - NODE_ENV: Set to 'test' or 'development' to bypass cache requirement for testing
 *
 * @throws Error if required environment variables are missing (unless in test/dev mode)
 */
export function loadCacheConfig(): CacheConfig {
  const host = process.env.LANGCACHE_HOST;
  const cacheId = process.env.LANGCACHE_CACHE_ID;
  const apiKey = process.env.LANGCACHE_API_KEY;

  // Validate required variables
  if (!host) {
    throw new Error(
      'LANGCACHE_HOST environment variable is required for semantic caching.\n' +
      'Set LANGCACHE_HOST in your .env file (e.g., your-cache-id.langcache.redis.io)\n' +
      'Get your LangCache credentials at: https://redis.io/langcache/'
    );
  }

  if (!cacheId) {
    throw new Error(
      'LANGCACHE_CACHE_ID environment variable is required for semantic caching.\n' +
      'Set LANGCACHE_CACHE_ID in your .env file.\n' +
      'Get your LangCache credentials at: https://redis.io/langcache/'
    );
  }

  if (!apiKey) {
    throw new Error(
      'LANGCACHE_API_KEY environment variable is required for semantic caching.\n' +
      'Set LANGCACHE_API_KEY in your .env file.\n' +
      'Get your LangCache credentials at: https://redis.io/langcache/'
    );
  }

  // Parse optional variables with defaults
  const similarityThreshold = process.env.LANGCACHE_SIMILARITY_THRESHOLD
    ? parseFloat(process.env.LANGCACHE_SIMILARITY_THRESHOLD)
    : 0.9;

  // LangCache maximum TTL is 31,556,952,000 milliseconds (~365.25 days)
  // The API requires ttlMillis < 31556952000 (exclusive), so we cap at 31556951 seconds
  // to ensure ttlMillis = 31556951000 < 31556952000
  const MAX_TTL_SECONDS = 31556951;
  const ttl = process.env.LANGCACHE_TTL
    ? parseInt(process.env.LANGCACHE_TTL, 10)
    : 3600;

  const timeoutMs = process.env.LANGCACHE_TIMEOUT_MS
    ? parseInt(process.env.LANGCACHE_TIMEOUT_MS, 10)
    : 5000; // Default 5 second timeout for reads

  const searchStrategiesEnv = process.env.LANGCACHE_SEARCH_STRATEGIES;
  const searchStrategies: Array<'exact' | 'semantic'> = searchStrategiesEnv
    ? searchStrategiesEnv
      .split(',')
      .map((strategy) => strategy.trim().toLowerCase())
      .filter((strategy): strategy is 'exact' | 'semantic' =>
        strategy === 'exact' || strategy === 'semantic'
      )
    : ['semantic'];

  if (searchStrategiesEnv && searchStrategies.length === 0) {
    throw new Error(
      `LANGCACHE_SEARCH_STRATEGIES must be a comma-separated list of "exact" and/or "semantic". Got: ${searchStrategiesEnv}`
    );
  }

  const writeTimeoutMs = process.env.LANGCACHE_WRITE_TIMEOUT_MS
    ? parseInt(process.env.LANGCACHE_WRITE_TIMEOUT_MS, 10)
    : 3000; // Default 3 second timeout for writes

  const flushTimeoutMs = process.env.LANGCACHE_FLUSH_TIMEOUT_MS
    ? parseInt(process.env.LANGCACHE_FLUSH_TIMEOUT_MS, 10)
    : 10000; // Default 10 second timeout for flush

  // Validate similarity threshold range
  if (isNaN(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 1) {
    throw new Error(
      `LANGCACHE_SIMILARITY_THRESHOLD must be a number between 0 and 1, got: ${process.env.LANGCACHE_SIMILARITY_THRESHOLD}. Please set a valid decimal value (e.g., 0.9).`
    );
  }

  // Validate TTL is positive
  if (isNaN(ttl) || ttl <= 0) {
    throw new Error(
      `LANGCACHE_TTL must be a positive integer, got: ${process.env.LANGCACHE_TTL}. Please set a valid number of seconds (e.g., 3600 for 1 hour).`
    );
  }

  // Validate TTL does not exceed LangCache maximum
  if (ttl > MAX_TTL_SECONDS) {
    throw new Error(
      `LANGCACHE_TTL must not exceed ${MAX_TTL_SECONDS} seconds (~365 days), got: ${ttl}. LangCache has a maximum TTL of ${MAX_TTL_SECONDS} seconds (approximately 1 year).`
    );
  }

  // Validate read timeout is positive
  if (isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `LANGCACHE_TIMEOUT_MS must be a positive integer, got: ${process.env.LANGCACHE_TIMEOUT_MS}. Please set a valid number of milliseconds (e.g., 5000 for 5 seconds).`
    );
  }

  // Validate write timeout is positive
  if (isNaN(writeTimeoutMs) || writeTimeoutMs <= 0) {
    throw new Error(
      `LANGCACHE_WRITE_TIMEOUT_MS must be a positive integer, got: ${process.env.LANGCACHE_WRITE_TIMEOUT_MS}. Please set a valid number of milliseconds (e.g., 3000 for 3 seconds).`
    );
  }

  // Validate flush timeout is positive
  if (isNaN(flushTimeoutMs) || flushTimeoutMs <= 0) {
    throw new Error(
      `LANGCACHE_FLUSH_TIMEOUT_MS must be a positive integer, got: ${process.env.LANGCACHE_FLUSH_TIMEOUT_MS}. Please set a valid number of milliseconds (e.g., 10000 for 10 seconds).`
    );
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
    writeTimeoutMs,
    flushTimeoutMs,
    searchStrategies,
  };
}
