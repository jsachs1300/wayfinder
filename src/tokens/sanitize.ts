import type { TokenConfigExtended } from './types';

const EMPTY_ELIGIBLE_MODELS: readonly string[] = [];

/**
 * Sanitize token for API response (remove token_hash and sensitive fields).
 */
export function sanitizeToken(token: TokenConfigExtended, allModelIds?: readonly string[]) {
  const fallbackEligibleModels = token.eligible_models ?? allModelIds ?? EMPTY_ELIGIBLE_MODELS;
  return {
    id: token.id,
    name: token.name || null,
    environment: token.environment,
    eligible_models: fallbackEligibleModels,
    created_at: token.created_at,
    updated_at: token.updated_at,
    rotated_at: token.rotated_at,
  };
}
