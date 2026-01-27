import type { TokenConfigExtended } from './types';

/**
 * Sanitize token for API response (remove token_hash and sensitive fields).
 */
export function sanitizeToken(token: TokenConfigExtended) {
  return {
    id: token.id,
    name: token.name || null,
    environment: token.environment,
    eligible_models: token.eligible_models,
    created_at: token.created_at,
    updated_at: token.updated_at,
    rotated_at: token.rotated_at,
  };
}
