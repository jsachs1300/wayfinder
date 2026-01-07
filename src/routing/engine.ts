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

import type { RouteRequest, TokenConfig, RouteDecision, RankedRouteDecision, RouteResult, PolicyEvaluationLogEvent } from '../types/index';
import { toLegacyRouteDecision } from './ranked-routing';
import type { PolicyEngine } from '../policy/engine';
import type { ModelRegistry } from '../models/registry';
import type { Logger } from '../logging/logger';
import type { SemanticCache } from '../cache';
import { hashPrompt } from '../cache';

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
  ): Promise<RouteResult>;
}

export interface RoutingEngineDependencies {
  routerLLM: RouterLLM;
  policyEngine: PolicyEngine;
  modelRegistry: ModelRegistry;
  logger: Logger;
  cache?: SemanticCache;
}

export class DefaultRoutingEngine implements RoutingEngine {
  private warnedTokens = new Set<string>(); // Track tokens we've warned about intent-based rules

  constructor(private readonly deps: RoutingEngineDependencies) {}

  async route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string,
  ): Promise<RouteResult> {
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

    // Structured logging for policy evaluation
    const policyLogEvent: PolicyEvaluationLogEvent = {
      event_type: 'policy_evaluation',
      timestamp: new Date().toISOString(),
      request_id: requestId || 'unknown',
      token_id: tokenConfig.id,
      eligible_models: policyResult.eligible_models,
      forced_model: policyResult.forced_model,
      rules_applied: policyResult.audit_trail.length,
      has_intent_based_rules: hasIntentBasedRules,
      warned_about_intent_limitation: this.warnedTokens.has(tokenConfig.id),
    };

    this.deps.logger.debug('Policy evaluation completed', policyLogEvent);

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

      const decision: RouteDecision = {
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

      return {
        decision,
        policyMetadata: {
          forcedModel: policyResult.forced_model,
          eligibleModelsCount: policyResult.eligible_models.length,
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

    // Check global cache AFTER policy evaluation, BEFORE router LLM invocation (REQUIREMENTS.md §8 step 8)
    // Note: Cache is global (no token isolation). App handles token-specific behavior via policies.
    if (this.deps.cache) {
      const cachedRanked = await this.deps.cache.get(request.prompt);

      if (cachedRanked) {
        this.deps.logger.debug('Global cache hit', {
          token_id: tokenConfig.id,
          prompt_hash: hashPrompt(request.prompt),
          request_id: requestId,
        });

        // Convert ranked decision to legacy format for backward compatibility
        const decision = toLegacyRouteDecision(cachedRanked);

        return {
          decision,
          policyMetadata: {
            forcedModel: policyResult.forced_model,
            eligibleModelsCount: eligibleModels.length,
          },
          cache_hit: true,
        };
      }

      this.deps.logger.debug('Cache miss', {
        token_id: tokenConfig.id,
        prompt_hash: hashPrompt(request.prompt),
        request_id: requestId,
      });
    }

    // Cache miss - invoke router LLM with policy-filtered eligible models
    const rankedDecision = await this.deps.routerLLM.invoke(request.prompt, eligibleModels, {
      tokenConfig,
      preferModel: request.prefer_model,
      requestMetadata: request.metadata,
    }) as RankedRouteDecision;

    // Router LLM returns RankedRouteDecision (already validated by validateRankedRouteDecision)
    // Convert to legacy format for backward compatibility
    const decision = toLegacyRouteDecision(rankedDecision);

    // Store ranked decision in global cache (fire-and-forget to avoid adding latency)
    if (this.deps.cache) {
      this.deps.cache.set(request.prompt, rankedDecision).catch((err) =>
        this.deps.logger.warn('Cache store failed', {
          error: err instanceof Error ? err.message : String(err),
          token_id: tokenConfig.id,
          prompt_hash: hashPrompt(request.prompt),
          request_id: requestId,
        })
      );
    }

    // Intent is now captured but not used for routing logic
    // It will be logged for internal analysis only

    return {
      decision,
      policyMetadata: {
        forcedModel: policyResult.forced_model,
        eligibleModelsCount: eligibleModels.length,
      },
    };
  }
}

export function createRoutingEngine(deps: RoutingEngineDependencies): RoutingEngine {
  return new DefaultRoutingEngine(deps);
}

// StubRouterLLM has been moved to src/routing/router-llm/stub-router-llm.ts
// Import it from there if needed for testing
