/**
 * Tier-based Rate Limiting Middleware
 *
 * Enforces different rate limits based on user tier:
 * - free: 10/hour, 50/day, 5 burst
 * - paid_system: 100/hour, 1000/day, 20 burst
 * - paid_byollm: 1000/hour, unlimited/day, 100 burst
 * - admin: unlimited
 *
 * Uses Redis for distributed rate limiting, falls back to in-memory.
 */

import type { Request, Response, NextFunction } from 'express';
import type Redis from 'ioredis';
import { getTierRateLimits, type UserTier } from './rate-limit-config';
import type { TokenConfig } from '../types';
import type { User } from '../users/types';

// Extend Express Request type
declare module 'express' {
  interface Request {
    tokenConfig?: TokenConfig;
    user?: User;
    userTier?: UserTier;
  }
}

/**
 * Rate limit window identifiers
 */
type RateLimitWindow = 'hour' | 'day' | 'burst';

/**
 * Get Redis key for rate limit tracking
 */
function getRateLimitKey(userId: string, window: RateLimitWindow): string {
  return `wayfinder:ratelimit:${window}:${userId}`;
}

/**
 * Get TTL for rate limit window
 */
function getWindowTTL(window: RateLimitWindow): number {
  switch (window) {
    case 'hour':
      return 3600; // 1 hour in seconds
    case 'day':
      return 86400; // 24 hours in seconds
    case 'burst':
      return 60; // 1 minute in seconds
  }
}

/**
 * Check rate limit using Redis
 */
async function checkRedisRateLimit(
  redis: Redis,
  userId: string,
  window: RateLimitWindow,
  limit: number
): Promise<{ count: number; exceeded: boolean; ttl: number }> {
  const key = getRateLimitKey(userId, window);

  // Increment counter
  const count = await redis.incr(key);

  // Set TTL on first request
  if (count === 1) {
    await redis.expire(key, getWindowTTL(window));
  }

  // Get remaining TTL
  const ttl = await redis.ttl(key);

  return {
    count,
    exceeded: limit !== -1 && count > limit,
    ttl: ttl > 0 ? ttl : 0,
  };
}

/**
 * In-memory rate limit tracking (fallback)
 */
class InMemoryRateLimitTracker {
  private counters: Map<string, { count: number; resetAt: number }> = new Map();

  check(
    userId: string,
    window: RateLimitWindow,
    limit: number
  ): { count: number; exceeded: boolean; ttl: number } {
    const key = `${userId}:${window}`;
    const now = Date.now();
    const windowMs = getWindowTTL(window) * 1000;

    let entry = this.counters.get(key);

    // Reset if expired
    if (!entry || entry.resetAt <= now) {
      entry = {
        count: 1,
        resetAt: now + windowMs,
      };
      this.counters.set(key, entry);
    } else {
      entry.count += 1;
    }

    const ttl = Math.ceil((entry.resetAt - now) / 1000);

    return {
      count: entry.count,
      exceeded: limit !== -1 && entry.count > limit,
      ttl: ttl > 0 ? ttl : 0,
    };
  }

  // Cleanup expired entries periodically
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    this.counters.forEach((entry, key) => {
      if (entry.resetAt <= now) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => this.counters.delete(key));
  }
}

// Global in-memory tracker
const inMemoryTracker = new InMemoryRateLimitTracker();

// Cleanup every 5 minutes
setInterval(() => inMemoryTracker.cleanup(), 5 * 60 * 1000);

/**
 * Create tier-aware rate limiting middleware
 *
 * @param redis - Optional Redis instance for distributed rate limiting
 * @returns Express middleware
 */
export function createTierRateLimiter(redis?: Redis) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Get user tier from request (set by auth middleware)
      // Default to 'free' if not set
      const tier: UserTier = req.userTier || 'free';

      // Get user/token identifier for rate limiting
      // Priority: user ID > token ID > IP address
      const userId =
        req.user?.id ||
        req.tokenConfig?.id ||
        req.ip ||
        'unknown';

      // Get rate limits for this tier
      const limits = getTierRateLimits(tier);

      // Skip rate limiting for admin tier (unlimited)
      if (
        limits.requests_per_hour === -1 &&
        limits.requests_per_day === -1 &&
        limits.burst_limit === -1
      ) {
        return next();
      }

      // Check burst limit (1 minute window)
      if (limits.burst_limit !== -1) {
        const burstResult = redis
          ? await checkRedisRateLimit(redis, userId, 'burst', limits.burst_limit)
          : inMemoryTracker.check(userId, 'burst', limits.burst_limit);

        if (burstResult.exceeded) {
          res.status(429).json({
            error: 'TooManyRequests',
            message: `Burst limit exceeded. ${limits.burst_limit} requests per minute allowed for ${tier} tier.`,
            retry_after_seconds: burstResult.ttl,
            tier,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      // Check hourly limit
      if (limits.requests_per_hour !== -1) {
        const hourlyResult = redis
          ? await checkRedisRateLimit(redis, userId, 'hour', limits.requests_per_hour)
          : inMemoryTracker.check(userId, 'hour', limits.requests_per_hour);

        if (hourlyResult.exceeded) {
          res.status(429).json({
            error: 'TooManyRequests',
            message: `Hourly rate limit exceeded. ${limits.requests_per_hour} requests per hour allowed for ${tier} tier.`,
            retry_after_seconds: hourlyResult.ttl,
            tier,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Add rate limit headers for hourly limits
        res.setHeader('X-RateLimit-Limit-Hour', limits.requests_per_hour.toString());
        res.setHeader(
          'X-RateLimit-Remaining-Hour',
          Math.max(0, limits.requests_per_hour - hourlyResult.count).toString()
        );
        res.setHeader('X-RateLimit-Reset-Hour', new Date(Date.now() + hourlyResult.ttl * 1000).toISOString());
      }

      // Check daily limit (if not unlimited)
      if (limits.requests_per_day !== -1) {
        const dailyResult = redis
          ? await checkRedisRateLimit(redis, userId, 'day', limits.requests_per_day)
          : inMemoryTracker.check(userId, 'day', limits.requests_per_day);

        if (dailyResult.exceeded) {
          res.status(429).json({
            error: 'TooManyRequests',
            message: `Daily rate limit exceeded. ${limits.requests_per_day} requests per day allowed for ${tier} tier.`,
            retry_after_seconds: dailyResult.ttl,
            tier,
            upgrade_url: '/api/users/upgrade',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Add rate limit headers for daily limits
        res.setHeader('X-RateLimit-Limit-Day', limits.requests_per_day.toString());
        res.setHeader(
          'X-RateLimit-Remaining-Day',
          Math.max(0, limits.requests_per_day - dailyResult.count).toString()
        );
        res.setHeader('X-RateLimit-Reset-Day', new Date(Date.now() + dailyResult.ttl * 1000).toISOString());
      }

      // Add tier header
      res.setHeader('X-User-Tier', tier);

      // Rate limit check passed
      next();
    } catch (error) {
      console.error('Rate limit middleware error:', error);
      // On error, allow request to proceed (fail open)
      next();
    }
  };
}
