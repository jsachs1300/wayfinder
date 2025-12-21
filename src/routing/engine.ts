/**
 * Routing Engine - Orchestrates LLM-driven routing decisions
 *
 * This engine is responsible for:
 * 1. Determining eligible models via policy evaluation
 * 2. Invoking the router LLM with the canonical contract
 * 3. Validating the router LLM response (fail hard on invalid schema)
 * 4. Returning the validated RouteDecision
 *
 * Intent is inferred by the router LLM and stored for analysis only.
 * It MUST NOT influence routing logic, scoring, or model eligibility.
 */

import type { RouteRequest, TokenConfig, RouteDecision } from '../types/index.js';
import { validateRouteDecision } from './validation.js';

/**
 * Router LLM interface
 * Implementations must invoke an LLM and return a response conforming to RouteDecision schema
 *
 * Example implementation using the v1.0 router prompt:
 *
 * ```typescript
 * import { buildRouterPrompt, getRouteDecisionSchema, getCanonicalIntentList } from './prompts';
 *
 * class ProductionRouterLLM implements RouterLLM {
 *   async invoke(userPrompt: string, eligibleModels: string[], context) {
 *     const routerPrompt = buildRouterPrompt({
 *       schema: getRouteDecisionSchema(),
 *       intentList: getCanonicalIntentList(),
 *       modelList: eligibleModels,
 *       userPrompt: userPrompt,
 *     });
 *
 *     const response = await this.llmClient.complete(routerPrompt);
 *     return JSON.parse(response);
 *   }
 * }
 * ```
 */
export interface RouterLLM {
  /**
   * Invokes the router LLM to make a routing decision
   *
   * @param prompt - User's prompt
   * @param eligibleModels - Models eligible for selection (after policy constraints)
   * @param context - Additional context (token config, preferences, etc.)
   * @returns Raw LLM response (will be validated against RouteDecision schema)
   */
  invoke(
    prompt: string,
    eligibleModels: string[],
    context: {
      tokenConfig: TokenConfig;
      preferModel?: string;
      requestMetadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

export interface RoutingEngine {
  route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string,
  ): Promise<RouteDecision>;
}

export interface RoutingEngineDependencies {
  routerLLM: RouterLLM;
}

export class DefaultRoutingEngine implements RoutingEngine {
  constructor(private readonly deps: RoutingEngineDependencies) {}

  async route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string,
  ): Promise<RouteDecision> {
    // TODO: Implement policy evaluation to determine eligible models
    // For now, use a placeholder - this will be replaced with actual policy engine
    const eligibleModels = ['gpt-4', 'claude-3-opus', 'claude-3-sonnet'];

    // Invoke router LLM
    const rawResponse = await this.deps.routerLLM.invoke(request.prompt, eligibleModels, {
      tokenConfig,
      preferModel: request.prefer_model,
      requestMetadata: request.metadata,
    });

    // Validate response against canonical schema (fail hard on invalid)
    const decision = validateRouteDecision(rawResponse);

    // Intent is now captured but not used for routing logic
    // It will be logged for internal analysis only

    return decision;
  }
}

export function createRoutingEngine(deps: RoutingEngineDependencies): RoutingEngine {
  return new DefaultRoutingEngine(deps);
}

// StubRouterLLM has been moved to src/routing/router-llm/stub-router-llm.ts
// Import it from there if needed for testing
