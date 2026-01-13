/**
 * Application configuration
 * Centralized configuration management for Wayfinder
 */

/**
 * Feature flags configuration
 * Controls which features are enabled/disabled
 */
export const FEATURE_FLAGS = {
  /**
   * Enable user self-service features (registration, login, token management, BYOLLM)
   * Set FEATURE_USER_SELF_SERVICE=true in environment to enable
   */
  USER_SELF_SERVICE: process.env.FEATURE_USER_SELF_SERVICE === 'true',
};

/**
 * Rate limit configuration defaults
 * Can be overridden via environment variables
 */
export const RATE_LIMIT_CONFIG = {
  free: {
    requests_per_hour: parseInt(process.env.RATE_LIMIT_FREE_HOUR || '10', 10),
    requests_per_day: parseInt(process.env.RATE_LIMIT_FREE_DAY || '50', 10),
    burst_limit: parseInt(process.env.RATE_LIMIT_FREE_BURST || '5', 10),
  },
  paid_system: {
    requests_per_hour: parseInt(process.env.RATE_LIMIT_PAID_SYSTEM_HOUR || '100', 10),
    requests_per_day: parseInt(process.env.RATE_LIMIT_PAID_SYSTEM_DAY || '1000', 10),
    burst_limit: parseInt(process.env.RATE_LIMIT_PAID_SYSTEM_BURST || '20', 10),
  },
  paid_byollm: {
    requests_per_hour: parseInt(process.env.RATE_LIMIT_BYOLLM_HOUR || '1000', 10),
    requests_per_day: parseInt(process.env.RATE_LIMIT_BYOLLM_DAY || '-1', 10),
    burst_limit: parseInt(process.env.RATE_LIMIT_BYOLLM_BURST || '100', 10),
  },
  admin: {
    requests_per_hour: -1, // Unlimited
    requests_per_day: -1,  // Unlimited
    burst_limit: -1,       // Unlimited
  },
};

/**
 * User limits configuration
 */
export const USER_LIMITS = {
  MAX_TOKENS_PER_USER: parseInt(process.env.MAX_TOKENS_PER_USER || '10', 10),
  ANONYMOUS_SESSION_TTL_DAYS: parseInt(process.env.ANONYMOUS_SESSION_TTL_DAYS || '7', 10),
};
