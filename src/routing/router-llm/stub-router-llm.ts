/**
 * Stub Router LLM Implementation
 *
 * A testing/fallback implementation that returns valid RouteDecisions
 * without invoking any external LLM API.
 *
 * This is moved from engine.ts to keep it separate from the production implementation.
 */

import type { RouterLLM } from '../engine.js';
import type { TokenConfig } from '../../types/index.js';

/**
 * Stub RouterLLM implementation for testing
 * Returns a valid RouteDecision with placeholder data
 */
export class StubRouterLLM implements RouterLLM {
  async invoke(
    prompt: string,
    eligibleModels: string[],
    context: {
      tokenConfig: TokenConfig;
      preferModel?: string;
      requestMetadata?: Record<string, unknown>;
    }
  ): Promise<unknown> {
    // If preferModel is specified and eligible, use it as primary
    const primaryModel =
      context.preferModel && eligibleModels.includes(context.preferModel)
        ? context.preferModel
        : eligibleModels[0] || 'gpt-4';

    // Select alternate (different from primary)
    const alternateModel =
      eligibleModels.find((m) => m !== primaryModel) || eligibleModels[1] || 'claude-3-sonnet';

    // Return a valid RouteDecision structure
    return {
      intent: 'code_change',
      primary: {
        model: primaryModel,
        score: 8,
        reason: 'Best suited for this task based on prompt analysis',
      },
      alternate: {
        model: alternateModel,
        score: 6,
        reason: 'Viable alternative with different strengths',
      },
    };
  }
}
