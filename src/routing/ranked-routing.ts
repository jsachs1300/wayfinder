/**
 * Ranked Routing Utilities
 *
 * Utilities for working with ranked routing decisions including:
 * - Conversion from ranked list to legacy primary/alternate format
 * - Validation of ranked route decisions
 */

import type { RouteDecision, RankedRouteDecision, RankedModel } from '../types/index';

/**
 * Score multiplier applied when only one model is available and we need to create
 * a fallback alternate. The penalty reflects reduced confidence when no true alternative exists.
 */
const FALLBACK_SCORE_PENALTY = 0.8;

/**
 * Convert ranked route decision to legacy primary/alternate format
 *
 * This enables backward compatibility while storing full ranked lists internally.
 * External API continues to return primary/alternate format.
 *
 * @param ranked - Ranked route decision with full model list
 * @returns Legacy route decision with primary and alternate
 * @throws Error if ranked list is empty
 */
export function toLegacyRouteDecision(ranked: RankedRouteDecision): RouteDecision {
  if (!ranked.ranked_models || ranked.ranked_models.length === 0) {
    throw new Error('Ranked list must contain at least one model');
  }

  // Sort by rank to ensure correct ordering (should already be sorted, but be defensive)
  const sorted = [...ranked.ranked_models].sort((a, b) => a.rank - b.rank);

  const first = sorted[0];
  const second = sorted[1];

  return {
    intent: ranked.intent,
    primary: {
      model: first.model,
      score: first.score,
      reason: first.reason,
    },
    alternate: second
      ? {
          model: second.model,
          score: second.score,
          reason: second.reason,
        }
      : {
          // Fallback if only one model available
          model: first.model,
          score: Math.max(0, first.score * FALLBACK_SCORE_PENALTY),
          reason: 'Fallback to primary (only available option)',
        },
  };
}

/**
 * Validate ranked route decision from router LLM
 *
 * Validates:
 * - Intent is present and non-empty
 * - ranked_models is non-empty array
 * - Each ranked model has valid rank, model, score, and reason
 * - Ranks are sequential (1, 2, 3, ...)
 * - No duplicate ranks
 * - Scores are in valid range (0-10)
 *
 * @param raw - Raw response from router LLM
 * @param eligibleModels - List of eligible models (for validation)
 * @returns Validated RankedRouteDecision
 * @throws Error if validation fails
 */
export function validateRankedRouteDecision(
  raw: any,
  eligibleModels: string[]
): RankedRouteDecision {
  // Validate intent
  if (!raw.intent || typeof raw.intent !== 'string' || raw.intent.trim().length === 0) {
    throw new Error('Invalid response: missing or invalid intent');
  }

  // Validate ranked_models exists and is array
  if (!Array.isArray(raw.ranked_models) || raw.ranked_models.length === 0) {
    throw new Error('Invalid response: ranked_models must be non-empty array');
  }

  // Validate each ranked model
  const validated: RankedModel[] = raw.ranked_models.map((rm: any, idx: number) => {
    // Validate rank
    if (typeof rm.rank !== 'number' || rm.rank < 1 || !Number.isInteger(rm.rank)) {
      throw new Error(`Invalid rank at position ${idx}: must be positive integer, got ${rm.rank}`);
    }

    // Validate model
    if (typeof rm.model !== 'string' || !rm.model.trim()) {
      throw new Error(`Invalid model at position ${idx}: must be non-empty string`);
    }

    // Security: Validate model is in eligible list (prevent policy bypass)
    if (!eligibleModels.includes(rm.model)) {
      throw new Error(
        `Invalid model at position ${idx}: "${rm.model}" is not in eligible models list. ` +
          `This indicates a policy bypass attempt or router LLM hallucination. ` +
          `Eligible models: ${eligibleModels.join(', ')}`
      );
    }

    // Validate score
    if (typeof rm.score !== 'number' || rm.score < 0 || rm.score > 10) {
      throw new Error(`Invalid score at position ${idx}: must be 0-10, got ${rm.score}`);
    }

    // Validate reason
    if (typeof rm.reason !== 'string' || !rm.reason.trim()) {
      throw new Error(`Invalid reason at position ${idx}: must be non-empty string`);
    }

    return {
      rank: rm.rank,
      model: rm.model,
      score: rm.score,
      reason: rm.reason.trim(),
    };
  });

  // Verify all eligible models are present
  const rankedModels = new Set(validated.map((rm) => rm.model));
  if (rankedModels.size !== eligibleModels.length) {
    throw new Error(
      `Invalid response: expected ${eligibleModels.length} models, got ${rankedModels.size}. ` +
        `All eligible models must be ranked.`
    );
  }

  // Verify no duplicate models
  if (validated.length !== rankedModels.size) {
    throw new Error('Invalid response: duplicate models found in ranked list');
  }

  // Verify ranks are sequential (1, 2, 3, ..., N)
  const sortedByRank = [...validated].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < sortedByRank.length; i++) {
    if (sortedByRank[i].rank !== i + 1) {
      throw new Error(
        `Invalid response: ranks must be sequential starting from 1. ` +
          `Expected rank ${i + 1}, got ${sortedByRank[i].rank}`
      );
    }
  }

  return {
    intent: raw.intent.trim(),
    ranked_models: sortedByRank, // Return sorted by rank
  };
}
