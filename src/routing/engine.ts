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
import type { PolicyEngine } from '../policy/engine.js';
import type { ModelRegistry } from '../models/registry.js';
import type { Logger } from '../logging/logger.js';

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
  policyEngine: PolicyEngine;
  modelRegistry: ModelRegistry;
  logger: Logger;
}

export class DefaultRoutingEngine implements RoutingEngine {
  private warnedTokens = new Set<string>(); // Track tokens we've warned about intent-based rules

  constructor(private readonly deps: RoutingEngineDependencies) {}

  async route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string,
  ): Promise<RouteDecision> {
    // Get all available models from registry
    const availableModels = this.deps.modelRegistry.getAvailableModels();
    const availableModelIds = availableModels.map((m) => m.id);

    // Warn if intent-based policy rules are configured (only once per token to avoid spam)
    const hasIntentBasedRules = tokenConfig.policy_rules?.some(
      rule => rule.type === 'ForceModelByIntent' || rule.type === 'RestrictModelsByIntent'
    );
    if (hasIntentBasedRules && !this.warnedTokens.has(tokenConfig.id)) {
      this.warnedTokens.add(tokenConfig.id);
      this.deps.logger.warn('Intent-based policy rules present with placeholder intent', {
        tokenId: tokenConfig.id,
        message: 'All requests use placeholder intent "other". Intent-based rules only match if configured for "other".',
        tracking: 'Intent timing architectural decision tracked as P1',
      });
    }

    // Apply policy evaluation to determine eligible models
    // NOTE: Intent-based policy rules present a timing challenge:
    //   - Intent is inferred by the router LLM (not available yet)
    //   - But policy evaluation happens before calling the router LLM
    //   - Solution: Use "other" as placeholder intent for initial filtering
    //   - This applies global allow/deny rules correctly
    //   - Intent-based rules (ForceModelByIntent, RestrictModelsByIntent)
    //     will use "other" until architectural decision is made (see P1)
    const policyResult = this.deps.policyEngine.evaluate(
      'other',
      availableModelIds,
      tokenConfig
    );

    // If policy forces a model, terminate routing immediately per REQUIREMENTS.md §7.2
    // Skip router LLM invocation to ensure deterministic behavior and avoid failures
    if (policyResult.forced_model) {
      // Validate that forced model exists in registry
      if (!availableModelIds.includes(policyResult.forced_model)) {
        throw new Error(
          `Policy forced model '${policyResult.forced_model}' not found in model registry. ` +
          `Available models: ${availableModelIds.join(', ')}`
        );
      }

      return {
        intent: 'other', // Placeholder intent since policy-forced routing doesn't use LLM
        primary: {
          model: policyResult.forced_model,
          score: 10,
          reason: 'Model forced by policy rule (routing terminated per REQUIREMENTS.md §7.2)',
        },
        alternate: {
          model: policyResult.forced_model,
          score: 10,
          reason: 'No alternate available when model is forced by policy',
        },
      };
    }

    // Use policy-filtered eligible models for router LLM
    const eligibleModels = policyResult.eligible_models;

    // Validate that policy evaluation resulted in at least one eligible model
    if (eligibleModels.length === 0) {
      throw new Error(
        'No eligible models available after policy evaluation. ' +
        'Please check your token configuration (allowed_models, denied_models, policy_rules). ' +
        'At least one model must be eligible for routing.'
      );
    }

    // Invoke router LLM with policy-filtered eligible models
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
