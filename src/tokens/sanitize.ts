import type { TokenConfigExtended } from './types';

/**
 * Sanitize token for API response (remove token_hash and sensitive fields).
 */
export function sanitizeToken(token: TokenConfigExtended) {
  return {
    id: token.id,
    name: token.name || null,
    is_primary: token.is_primary || false,
    environment: token.environment,
    created_at: token.created_at,
    updated_at: token.updated_at,
  };
}
