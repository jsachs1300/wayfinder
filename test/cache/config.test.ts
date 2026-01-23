/**
 * Cache Configuration Tests
 *
 * Tests cache configuration loading and validation including:
 * - Required environment variables
 * - Optional environment variables and defaults
 * - Validation of similarity threshold
 * - Validation of TTL
 * - Validation of timeout
 * - Server URL normalization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadCacheConfig } from '../../src/cache/config';

describe('Cache Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Required Environment Variables', () => {
    it('should throw if LANGCACHE_HOST is missing', () => {
      delete process.env.LANGCACHE_HOST;
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_HOST environment variable is required'
      );
    });

    it('should throw if LANGCACHE_CACHE_ID is missing', () => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      delete process.env.LANGCACHE_CACHE_ID;
      process.env.LANGCACHE_API_KEY = 'test-api-key';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_CACHE_ID environment variable is required'
      );
    });

    it('should throw if LANGCACHE_API_KEY is missing', () => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      delete process.env.LANGCACHE_API_KEY;

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_API_KEY environment variable is required'
      );
    });
  });

  describe('Optional Environment Variables and Defaults', () => {
    beforeEach(() => {
      // Set required variables
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';
    });

    it('should use default similarity threshold (0.9)', () => {
      delete process.env.LANGCACHE_SIMILARITY_THRESHOLD;

      const config = loadCacheConfig();

      expect(config.similarityThreshold).toBe(0.9);
    });

    it('should use custom similarity threshold from env', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '0.85';

      const config = loadCacheConfig();

      expect(config.similarityThreshold).toBe(0.85);
    });

    it('should use default TTL (3600 seconds)', () => {
      delete process.env.LANGCACHE_TTL;

      const config = loadCacheConfig();

      expect(config.ttl).toBe(3600);
    });

    it('should use custom TTL from env', () => {
      process.env.LANGCACHE_TTL = '7200';

      const config = loadCacheConfig();

      expect(config.ttl).toBe(7200);
    });

    it('should use default timeout (5000ms)', () => {
      delete process.env.LANGCACHE_TIMEOUT_MS;

      const config = loadCacheConfig();

      expect(config.timeoutMs).toBe(5000);
    });

    it('should use custom timeout from env', () => {
      process.env.LANGCACHE_TIMEOUT_MS = '10000';

      const config = loadCacheConfig();

      expect(config.timeoutMs).toBe(10000);
    });
  });

  describe('Similarity Threshold Validation', () => {
    beforeEach(() => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';
    });

    it('should reject similarity threshold < 0', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '-0.1';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_SIMILARITY_THRESHOLD must be a number between 0 and 1'
      );
    });

    it('should reject similarity threshold > 1', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '1.5';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_SIMILARITY_THRESHOLD must be a number between 0 and 1'
      );
    });

    it('should accept similarity threshold = 0', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '0';

      const config = loadCacheConfig();

      expect(config.similarityThreshold).toBe(0);
    });

    it('should accept similarity threshold = 1', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '1';

      const config = loadCacheConfig();

      expect(config.similarityThreshold).toBe(1);
    });

    it('should accept valid similarity threshold in range', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '0.75';

      const config = loadCacheConfig();

      expect(config.similarityThreshold).toBe(0.75);
    });
  });

  describe('TTL Validation', () => {
    beforeEach(() => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';
    });

    it('should reject TTL = 0', () => {
      process.env.LANGCACHE_TTL = '0';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_TTL must be a positive integer'
      );
    });

    it('should reject negative TTL', () => {
      process.env.LANGCACHE_TTL = '-100';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_TTL must be a positive integer'
      );
    });

    it('should accept positive TTL', () => {
      process.env.LANGCACHE_TTL = '86400';

      const config = loadCacheConfig();

      expect(config.ttl).toBe(86400);
    });

    it('should reject TTL exceeding maximum (31556951 seconds)', () => {
      process.env.LANGCACHE_TTL = '31556952'; // One second over the limit

      expect(() => loadCacheConfig()).toThrow(
        /LANGCACHE_TTL must not exceed 31556951 seconds/
      );
    });

    it('should accept TTL at maximum (31556951 seconds)', () => {
      process.env.LANGCACHE_TTL = '31556951'; // Exactly at the limit

      const config = loadCacheConfig();

      expect(config.ttl).toBe(31556951);
    });

    it('should reject very large TTL values', () => {
      process.env.LANGCACHE_TTL = '100000000'; // Far exceeds limit

      expect(() => loadCacheConfig()).toThrow(
        /LANGCACHE_TTL must not exceed 31556951 seconds/
      );
    });
  });

  describe('Timeout Validation', () => {
    beforeEach(() => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';
    });

    it('should reject read timeout = 0', () => {
      process.env.LANGCACHE_TIMEOUT_MS = '0';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_TIMEOUT_MS must be a positive integer'
      );
    });

    it('should reject negative read timeout', () => {
      process.env.LANGCACHE_TIMEOUT_MS = '-1000';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_TIMEOUT_MS must be a positive integer'
      );
    });

    it('should accept positive read timeout', () => {
      process.env.LANGCACHE_TIMEOUT_MS = '15000';

      const config = loadCacheConfig();

      expect(config.timeoutMs).toBe(15000);
    });

    it('should use default write timeout (3000ms)', () => {
      delete process.env.LANGCACHE_WRITE_TIMEOUT_MS;

      const config = loadCacheConfig();

      expect(config.writeTimeoutMs).toBe(3000);
    });

    it('should use custom write timeout from env', () => {
      process.env.LANGCACHE_WRITE_TIMEOUT_MS = '5000';

      const config = loadCacheConfig();

      expect(config.writeTimeoutMs).toBe(5000);
    });

    it('should reject write timeout = 0', () => {
      process.env.LANGCACHE_WRITE_TIMEOUT_MS = '0';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_WRITE_TIMEOUT_MS must be a positive integer'
      );
    });

    it('should use default flush timeout (10000ms)', () => {
      delete process.env.LANGCACHE_FLUSH_TIMEOUT_MS;

      const config = loadCacheConfig();

      expect(config.flushTimeoutMs).toBe(10000);
    });

    it('should use custom flush timeout from env', () => {
      process.env.LANGCACHE_FLUSH_TIMEOUT_MS = '15000';

      const config = loadCacheConfig();

      expect(config.flushTimeoutMs).toBe(15000);
    });

    it('should reject flush timeout = 0', () => {
      process.env.LANGCACHE_FLUSH_TIMEOUT_MS = '0';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_FLUSH_TIMEOUT_MS must be a positive integer'
      );
    });

    it('should reject invalid (NaN) read timeout', () => {
      process.env.LANGCACHE_TIMEOUT_MS = 'not-a-number';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_TIMEOUT_MS must be a positive integer'
      );
    });

    it('should reject invalid (NaN) write timeout', () => {
      process.env.LANGCACHE_WRITE_TIMEOUT_MS = 'invalid';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_WRITE_TIMEOUT_MS must be a positive integer'
      );
    });

    it('should reject invalid (NaN) flush timeout', () => {
      process.env.LANGCACHE_FLUSH_TIMEOUT_MS = 'abc';

      expect(() => loadCacheConfig()).toThrow(
        'LANGCACHE_FLUSH_TIMEOUT_MS must be a positive integer'
      );
    });
  });

  describe('Server URL Normalization', () => {
    beforeEach(() => {
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';
    });

    it('should add https:// prefix if missing', () => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';

      const config = loadCacheConfig();

      expect(config.serverURL).toBe('https://test.langcache.redis.io');
    });

    it('should preserve https:// prefix if present', () => {
      process.env.LANGCACHE_HOST = 'https://test.langcache.redis.io';

      const config = loadCacheConfig();

      expect(config.serverURL).toBe('https://test.langcache.redis.io');
    });

    it('should preserve http:// prefix if present (for local dev)', () => {
      process.env.LANGCACHE_HOST = 'http://localhost:8080';

      const config = loadCacheConfig();

      expect(config.serverURL).toBe('http://localhost:8080');
    });
  });

  describe('Complete Configuration', () => {
    beforeEach(() => {
      delete process.env.LANGCACHE_SEARCH_STRATEGIES;
    });

    it('should return complete config with all fields', () => {
      process.env.LANGCACHE_HOST = 'aws-us-east-1.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = '1234567890abcdef';
      process.env.LANGCACHE_API_KEY = 'test-api-key-abc123';
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '0.85';
      process.env.LANGCACHE_TTL = '7200';
      process.env.LANGCACHE_TIMEOUT_MS = '8000';

      const config = loadCacheConfig();

      expect(config).toEqual({
        serverURL: 'https://aws-us-east-1.langcache.redis.io',
        cacheId: '1234567890abcdef',
        apiKey: 'test-api-key-abc123',
        similarityThreshold: 0.85,
        ttl: 7200,
        timeoutMs: 8000,
        writeTimeoutMs: 3000, // Default
        flushTimeoutMs: 10000, // Default
        searchStrategies: ['semantic'],
      });
    });

    it('should return config with defaults when optionals omitted', () => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-id';
      process.env.LANGCACHE_API_KEY = 'test-key';
      delete process.env.LANGCACHE_SIMILARITY_THRESHOLD;
      delete process.env.LANGCACHE_TTL;
      delete process.env.LANGCACHE_TIMEOUT_MS;

      const config = loadCacheConfig();

      expect(config).toEqual({
        serverURL: 'https://test.langcache.redis.io',
        cacheId: 'test-id',
        apiKey: 'test-key',
        similarityThreshold: 0.9, // Default
        ttl: 3600, // Default
        timeoutMs: 5000, // Default
        writeTimeoutMs: 3000, // Default
        flushTimeoutMs: 10000, // Default
        searchStrategies: ['semantic'],
      });
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      process.env.LANGCACHE_HOST = 'test.langcache.redis.io';
      process.env.LANGCACHE_CACHE_ID = 'test-cache-id';
      process.env.LANGCACHE_API_KEY = 'test-api-key';
    });

    it('should handle whitespace in API key (real-world issue)', () => {
      // This was the actual bug we encountered
      process.env.LANGCACHE_API_KEY = 'key-with       spaces';

      const config = loadCacheConfig();

      // Config loads successfully with spaces (LangCache SDK will reject it)
      expect(config.apiKey).toBe('key-with       spaces');
    });

    it('should handle very long cache ID', () => {
      process.env.LANGCACHE_CACHE_ID = 'a'.repeat(100);

      const config = loadCacheConfig();

      expect(config.cacheId).toHaveLength(100);
    });

    it('should handle fractional similarity threshold', () => {
      process.env.LANGCACHE_SIMILARITY_THRESHOLD = '0.888888';

      const config = loadCacheConfig();

      expect(config.similarityThreshold).toBeCloseTo(0.888888);
    });

    it('should handle very large TTL', () => {
      process.env.LANGCACHE_TTL = '31536000'; // 1 year

      const config = loadCacheConfig();

      expect(config.ttl).toBe(31536000);
    });

    it('should handle very large timeout', () => {
      process.env.LANGCACHE_TIMEOUT_MS = '60000'; // 1 minute

      const config = loadCacheConfig();

      expect(config.timeoutMs).toBe(60000);
    });
  });
});
