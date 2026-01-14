/**
 * Rate Limit Configuration for Tier-based Limiting
 *
 * Defines rate limit configurations per user tier:
 * - free: Limited requests, system pays LLM costs
 * - paid_system: Higher limits, system pays LLM costs
 * - paid_byollm: Highest limits, user pays LLM costs via own keys
 * - admin: Unlimited access (legacy admin tokens)
 */

/**
 * Rate limit configuration per tier
 */
export interface RateLimitConfig {
  /** Requests allowed per hour */
  requests_per_hour: number;

  /** Requests allowed per day */
  requests_per_day: number;

  /** Burst limit (max requests in 1 minute) */
  burst_limit: number;
}

/**
 * User tier levels
 */
export type UserTier = 'free' | 'paid_system' | 'paid_byollm' | 'admin';

/**
 * Complete rate limit configuration for all tiers
 */
export interface TierRateLimits {
  free: RateLimitConfig;
  paid_system: RateLimitConfig;
  paid_byollm: RateLimitConfig;
  admin: RateLimitConfig;
}

/**
 * Default rate limit configuration
 * Values from design document section 4.4
 */
export const DEFAULT_RATE_LIMITS: TierRateLimits = {
  free: {
    requests_per_hour: 10,
    requests_per_day: 50,
    burst_limit: 5,
  },
  paid_system: {
    requests_per_hour: 100,
    requests_per_day: 1000,
    burst_limit: 20,
  },
  paid_byollm: {
    requests_per_hour: 1000,
    requests_per_day: -1, // -1 = unlimited
    burst_limit: 100,
  },
  admin: {
    requests_per_hour: -1,
    requests_per_day: -1,
    burst_limit: -1,
  },
};

/**
 * Parse integer from environment variable, allowing -1 for unlimited
 * @param value - Environment variable value
 * @param defaultValue - Default value if not provided or invalid
 * @returns Parsed integer or default
 */
function parseRateLimitInt(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  // Allow -1 for unlimited, or positive integers
  if (isNaN(parsed) || (parsed < -1 || parsed === 0)) {
    console.warn(
      `Invalid rate limit value: "${value}". Must be -1 (unlimited) or positive integer. Using default: ${defaultValue}`
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * Get rate limits for a specific tier
 * @param tier - User tier
 * @returns Rate limit configuration for the tier
 */
export function getTierRateLimits(tier: UserTier): RateLimitConfig {
  const config = loadRateLimitConfig();
  return config[tier];
}

/**
 * Load rate limit configuration from environment variables with defaults
 * Environment variable format: RATE_LIMIT_{TIER}_{PERIOD}
 * Examples:
 *   RATE_LIMIT_FREE_HOUR=10
 *   RATE_LIMIT_PAID_SYSTEM_DAY=1000
 *   RATE_LIMIT_BYOLLM_DAY=-1 (unlimited)
 */
export function loadRateLimitConfig(): TierRateLimits {
  return {
    free: {
      requests_per_hour: parseRateLimitInt(
        process.env.RATE_LIMIT_FREE_HOUR,
        DEFAULT_RATE_LIMITS.free.requests_per_hour
      ),
      requests_per_day: parseRateLimitInt(
        process.env.RATE_LIMIT_FREE_DAY,
        DEFAULT_RATE_LIMITS.free.requests_per_day
      ),
      burst_limit: parseRateLimitInt(
        process.env.RATE_LIMIT_FREE_BURST,
        DEFAULT_RATE_LIMITS.free.burst_limit
      ),
    },
    paid_system: {
      requests_per_hour: parseRateLimitInt(
        process.env.RATE_LIMIT_PAID_SYSTEM_HOUR,
        DEFAULT_RATE_LIMITS.paid_system.requests_per_hour
      ),
      requests_per_day: parseRateLimitInt(
        process.env.RATE_LIMIT_PAID_SYSTEM_DAY,
        DEFAULT_RATE_LIMITS.paid_system.requests_per_day
      ),
      burst_limit: parseRateLimitInt(
        process.env.RATE_LIMIT_PAID_SYSTEM_BURST,
        DEFAULT_RATE_LIMITS.paid_system.burst_limit
      ),
    },
    paid_byollm: {
      requests_per_hour: parseRateLimitInt(
        process.env.RATE_LIMIT_BYOLLM_HOUR,
        DEFAULT_RATE_LIMITS.paid_byollm.requests_per_hour
      ),
      requests_per_day: parseRateLimitInt(
        process.env.RATE_LIMIT_BYOLLM_DAY,
        DEFAULT_RATE_LIMITS.paid_byollm.requests_per_day
      ),
      burst_limit: parseRateLimitInt(
        process.env.RATE_LIMIT_BYOLLM_BURST,
        DEFAULT_RATE_LIMITS.paid_byollm.burst_limit
      ),
    },
    admin: {
      requests_per_hour: -1,
      requests_per_day: -1,
      burst_limit: -1,
    },
  };
}
