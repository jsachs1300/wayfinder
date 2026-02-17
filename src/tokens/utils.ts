export interface DefaultTokenLike {
  is_default?: boolean;
  name?: string | null;
  user_id?: string | null;
  eligible_models?: string[] | null;
}

/**
 * Detects default user tokens.
 *
 * Default token behavior:
 * - global cache scope
 * - dynamic eligible_models from registry
 *
 * Detection:
 * 1) Explicit marker: is_default === true
 * 2) Legacy fallback: user_id exists and name === "Default Token"
 *
 * The legacy fallback is intentionally permissive for backward compatibility.
 */
export function isDefaultToken(config: DefaultTokenLike): boolean {
  if (config.is_default === true) {
    return true;
  }
  // Backward compatibility for legacy default tokens.
  return typeof config.user_id === 'string' && config.name === 'Default Token';
}

/**
 * Resolve effective eligible models for a token.
 *
 * Default tokens are always dynamic and use the current available registry models,
 * ignoring persisted eligible_models for backward compatibility with older records.
 */
export function resolveEligibleModels(
  config: DefaultTokenLike,
  availableModelIds: readonly string[]
): readonly string[] {
  if (isDefaultToken(config)) {
    return availableModelIds;
  }
  return config.eligible_models ?? availableModelIds;
}
