import type { User } from './types';

/**
 * Sanitize user object for API response (remove password_hash).
 */
export function sanitizeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    tier: user.tier,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  };
}
