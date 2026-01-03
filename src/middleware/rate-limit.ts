/**
 * Rate Limiting Middleware
 *
 * Protects against abuse, DDoS attacks, and cost overruns from excessive LLM API calls.
 *
 * Features:
 * - Configurable limits per endpoint
 * - Redis-backed storage for distributed systems (optional)
 * - In-memory storage for single-instance deployments
 * - Standard rate limit headers (RateLimit-*)
 * - Token-based limiting for /route endpoint
 * - IP-based limiting for admin endpoints
 */

import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request } from 'express';
import type Redis from 'ioredis';

/**
 * Rate limit configuration from environment variables
 */
interface RateLimitConfig {
  // Global API rate limit (applies to all endpoints unless overridden)
  globalWindowMs: number;
  globalMaxRequests: number;

  // Routing endpoint (/route) - most critical to limit due to LLM costs
  routingWindowMs: number;
  routingMaxRequests: number;

  // Admin endpoints (/admin/*)
  adminWindowMs: number;
  adminMaxRequests: number;

  // Feedback endpoint
  feedbackWindowMs: number;
  feedbackMaxRequests: number;
}

/**
 * Validate and parse a positive integer from environment variable
 * @param value - The environment variable value
 * @param defaultValue - Default value if invalid or not provided
 * @param min - Minimum allowed value (default: 1)
 * @param max - Maximum allowed value (default: 1 billion)
 * @returns Validated positive integer
 */
function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
  min = 1,
  max = 1_000_000_000
): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  // Check for NaN, negative, zero, or out of bounds
  if (isNaN(parsed) || parsed < min || parsed > max) {
    console.warn(
      `Invalid rate limit configuration: "${value}" is not a valid positive integer between ${min} and ${max}. Using default: ${defaultValue}`
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * Load rate limit configuration from environment variables
 */
function loadRateLimitConfig(): RateLimitConfig {
  return {
    // Global: 100 requests per 15 minutes (default)
    globalWindowMs: parsePositiveInt(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, 900000, 1000, 86400000),
    globalMaxRequests: parsePositiveInt(process.env.RATE_LIMIT_GLOBAL_MAX, 100, 1, 10000),

    // Routing: 20 requests per minute (default) - CONSERVATIVE due to LLM costs
    routingWindowMs: parsePositiveInt(process.env.RATE_LIMIT_ROUTING_WINDOW_MS, 60000, 1000, 86400000),
    routingMaxRequests: parsePositiveInt(process.env.RATE_LIMIT_ROUTING_MAX, 20, 1, 10000),

    // Admin: 50 requests per 15 minutes (default)
    adminWindowMs: parsePositiveInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS, 900000, 1000, 86400000),
    adminMaxRequests: parsePositiveInt(process.env.RATE_LIMIT_ADMIN_MAX, 50, 1, 10000),

    // Feedback: 100 requests per 15 minutes (default)
    feedbackWindowMs: parsePositiveInt(process.env.RATE_LIMIT_FEEDBACK_WINDOW_MS, 900000, 1000, 86400000),
    feedbackMaxRequests: parsePositiveInt(process.env.RATE_LIMIT_FEEDBACK_MAX, 100, 1, 10000),
  };
}

/**
 * Create rate limiter options with optional Redis store
 */
function createRateLimiterOptions(
  windowMs: number,
  max: number,
  redis?: Redis,
  keyGenerator?: (req: Request) => string,
  endpointName?: string
): Partial<Options> {
  const options: Partial<Options> = {
    windowMs,
    max,
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    handler: (req, res) => {
      // Log rate limit violations for monitoring and alerting
      console.warn('Rate limit exceeded', {
        endpoint: endpointName || req.path,
        ip: req.ip,
        token: req.headers['x-wayfinder-token'] ? '[REDACTED]' : undefined,
        limit: max,
        window_seconds: windowMs / 1000,
      });

      res.status(429).json({
        error: 'TooManyRequests',
        message: 'Too many requests, please try again later',
        retryAfter: Math.ceil(windowMs / 1000),
        timestamp: new Date().toISOString(), // Consistent with other error responses
      });
    },
  };

  // Use Redis store if available (for distributed systems)
  if (redis) {
    options.store = new RedisStore({
      // RedisStore expects sendCommand to match ioredis.call signature
      // The type mismatch is due to rate-limit-redis expecting generic Redis client
      sendCommand: (...args: Parameters<typeof redis.call>) => redis.call(...args),
      prefix: 'wayfinder:ratelimit:',
    }) as any; // Cast needed due to rate-limit-redis@4.x type incompatibility with ioredis
  }

  // Custom key generator if provided
  if (keyGenerator) {
    options.keyGenerator = keyGenerator;
  }

  return options;
}

/**
 * Create rate limiting middleware for different endpoints
 */
export function createRateLimiters(redis?: Redis) {
  const config = loadRateLimitConfig();

  return {
    /**
     * Global rate limiter - applies to all endpoints unless overridden
     */
    global: rateLimit(
      createRateLimiterOptions(config.globalWindowMs, config.globalMaxRequests, redis, undefined, 'global')
    ),

    /**
     * Routing endpoint rate limiter - uses token as key for per-token limiting
     * Most critical limiter since routing calls the router LLM (expensive!)
     */
    routing: rateLimit(
      createRateLimiterOptions(
        config.routingWindowMs,
        config.routingMaxRequests,
        redis,
        (req: Request) => {
          // Use Wayfinder token as key for per-token rate limiting
          const token = req.headers['x-wayfinder-token'] as string;
          if (token) {
            return `token:${token}`;
          }
          // Fallback to IP if no token (use proper IPv6-compatible key generator)
          return ipKeyGenerator(req);
        },
        '/route'
      )
    ),

    /**
     * Admin endpoints rate limiter - uses IP as key
     */
    admin: rateLimit(
      createRateLimiterOptions(config.adminWindowMs, config.adminMaxRequests, redis, undefined, '/admin')
    ),

    /**
     * Feedback endpoint rate limiter - uses token as key
     */
    feedback: rateLimit(
      createRateLimiterOptions(
        config.feedbackWindowMs,
        config.feedbackMaxRequests,
        redis,
        (req: Request) => {
          const token = req.headers['x-wayfinder-token'] as string;
          if (token) {
            return `token:${token}`;
          }
          // Fallback to IP (use proper IPv6-compatible key generator)
          return ipKeyGenerator(req);
        },
        '/feedback'
      )
    ),
  };
}

/**
 * Get rate limit configuration summary for logging
 */
export function getRateLimitConfigSummary(): Record<string, unknown> {
  const config = loadRateLimitConfig();
  return {
    global: {
      window_seconds: config.globalWindowMs / 1000,
      max_requests: config.globalMaxRequests,
    },
    routing: {
      window_seconds: config.routingWindowMs / 1000,
      max_requests: config.routingMaxRequests,
      note: 'Per token (conservative due to LLM costs)',
    },
    admin: {
      window_seconds: config.adminWindowMs / 1000,
      max_requests: config.adminMaxRequests,
    },
    feedback: {
      window_seconds: config.feedbackWindowMs / 1000,
      max_requests: config.feedbackMaxRequests,
    },
  };
}
