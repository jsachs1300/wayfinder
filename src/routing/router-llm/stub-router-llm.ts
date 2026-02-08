/**
 * Stub Router LLM Implementation
 *
 * A testing/fallback implementation that returns valid RankedRouteDecisions
 * without invoking any external LLM API.
 *
 * This is moved from engine.ts to keep it separate from the production implementation.
 */

import type { RouterLLM } from '../engine';
import type { TokenConfig, RankedRouteDecision, RankedModel } from '../../types/index';

/**
 * Stub RouterLLM implementation for testing
 * Returns a valid RankedRouteDecision with placeholder data
 */
export class StubRouterLLM implements RouterLLM {
  async invoke(
    prompt: string,
    eligibleModels: string[],
    context: {
      tokenConfig: TokenConfig;
      preferModel?: string;
      requestMetadata?: Record<string, unknown>;
      eligibleModelRegistry?: Record<string, Record<string, unknown>>;
    }
  ): Promise<unknown> {
    // If preferModel is specified and eligible, make it rank 1
    let rankedModels: RankedModel[];

    if (context.preferModel && eligibleModels.includes(context.preferModel)) {
      // Put preferred model first
      const otherModels = eligibleModels.filter(m => m !== context.preferModel);
      rankedModels = [
        {
          rank: 1,
          model: context.preferModel,
          score: 9,
          reason: 'Excellent match for this task based on capabilities',
        },
        ...otherModels.map((model, idx) => ({
          rank: idx + 2,
          model,
          score: Math.max(3, 8 - idx),
          reason: 'Capable alternative with solid performance characteristics',
        })),
      ];
    } else {
      // Rank all eligible models in order
      rankedModels = eligibleModels.map((model, idx) => ({
        rank: idx + 1,
        model,
        score: Math.max(3, 9 - idx),
        reason: idx === 0
          ? 'Best suited for this task based on prompt analysis'
          : 'Viable alternative with different strengths',
      }));
    }

    // Return a valid RankedRouteDecision structure
    const decision: RankedRouteDecision = {
      intent: 'code_change',
      ranked_models: rankedModels,
    };

    return decision;
  }
}
