export interface DefaultTokenLike {
  is_default?: boolean;
  name?: string | null;
  user_id?: string | null;
  eligible_models?: string[] | null;
}

export interface DefaultEligibleModelCandidate {
  id: string;
  provider: string;
  cost_tier?: 'low' | 'medium' | 'high';
  speed_tier?: 'fast' | 'medium' | 'slow';
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
  availableModelIds: readonly string[],
  defaultEligibleModelIds: readonly string[] = availableModelIds
): readonly string[] {
  if (isDefaultToken(config)) {
    return defaultEligibleModelIds;
  }
  return config.eligible_models ?? availableModelIds;
}

function getLightweightModelScore(model: DefaultEligibleModelCandidate): number {
  const id = model.id.toLowerCase();
  let score = 0;

  if (/(^|[-_])(mini|lite|nano|haiku|small)([-_]|$)/.test(id)) {
    score += 120;
  }
  if (/(^|[-_])flash([-_]|$)/.test(id)) {
    score += 60;
  }
  if (/(^|[-_])(pro|opus|ultra|large|max|reasoning)([-_]|$)/.test(id)) {
    score -= 30;
  }

  if (model.cost_tier === 'low') score += 30;
  if (model.cost_tier === 'medium') score += 10;
  if (model.cost_tier === 'high') score -= 10;

  if (model.speed_tier === 'fast') score += 20;
  if (model.speed_tier === 'medium') score += 5;

  // Prefer concise canonical IDs if other signals tie.
  score += Math.max(0, 40 - id.length);

  return score;
}

/**
 * Select compact default eligible models: one lightweight candidate per provider.
 *
 * This keeps default-token routing prompts small while preserving provider diversity.
 */
export function selectDefaultEligibleModelIds(
  availableModels: readonly DefaultEligibleModelCandidate[]
): string[] {
  if (availableModels.length === 0) {
    return [];
  }

  const winnerByProvider = new Map<string, DefaultEligibleModelCandidate>();
  const scoreByProvider = new Map<string, number>();

  for (const model of availableModels) {
    const provider = model.provider.toLowerCase();
    const score = getLightweightModelScore(model);
    const current = scoreByProvider.get(provider);
    const existing = winnerByProvider.get(provider);

    if (
      current === undefined ||
      score > current ||
      (score === current && existing && model.id.length < existing.id.length) ||
      (score === current && existing && model.id.length === existing.id.length && model.id < existing.id)
    ) {
      winnerByProvider.set(provider, model);
      scoreByProvider.set(provider, score);
    }
  }

  const selected = Array.from(winnerByProvider.values())
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
    .map((model) => model.id);

  return selected.length > 0 ? selected : availableModels.map((model) => model.id);
}
