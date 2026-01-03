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
 * Load rate limit configuration from environment variables
 */
function loadRateLimitConfig(): RateLimitConfig {
  return {
    // Global: 100 requests per 15 minutes (default)
    globalWindowMs: parseInt(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS || '900000', 10),
    globalMaxRequests: parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '100', 10),

    // Routing: 20 requests per minute (default) - CONSERVATIVE due to LLM costs
    routingWindowMs: parseInt(process.env.RATE_LIMIT_ROUTING_WINDOW_MS || '60000', 10),
    routingMaxRequests: parseInt(process.env.RATE_LIMIT_ROUTING_MAX || '20', 10),

    // Admin: 50 requests per 15 minutes (default)
    adminWindowMs: parseInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS || '900000', 10),
    adminMaxRequests: parseInt(process.env.RATE_LIMIT_ADMIN_MAX || '50', 10),

    // Feedback: 100 requests per 15 minutes (default)
    feedbackWindowMs: parseInt(process.env.RATE_LIMIT_FEEDBACK_WINDOW_MS || '900000', 10),
    feedbackMaxRequests: parseInt(process.env.RATE_LIMIT_FEEDBACK_MAX || '100', 10),
  };
}

/**
 * Create rate limiter options with optional Redis store
 */
function createRateLimiterOptions(
  windowMs: number,
  max: number,
  redis?: Redis,
  keyGenerator?: (req: Request) => string
): Partial<Options> {
  const options: Partial<Options> = {
    windowMs,
    max,
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    message: {
      error: 'TooManyRequests',
      message: 'Too many requests, please try again later',
      retryAfter: Math.ceil(windowMs / 1000),
    },
  };

  // Use Redis store if available (for distributed systems)
  if (redis) {
    options.store = new RedisStore({
      // @ts-expect-error - rate-limit-redis types are slightly off
      sendCommand: (...args: string[]) => redis.call(...args),
      prefix: 'wayfinder:ratelimit:',
    });
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
      createRateLimiterOptions(config.globalWindowMs, config.globalMaxRequests, redis)
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
        }
      )
    ),

    /**
     * Admin endpoints rate limiter - uses IP as key
     */
    admin: rateLimit(
      createRateLimiterOptions(config.adminWindowMs, config.adminMaxRequests, redis)
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
        }
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
