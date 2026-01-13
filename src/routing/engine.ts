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

import type { RouteRequest, TokenConfig, RouteDecision, RankedRouteDecision, RouteResult, PolicyEvaluationLogEvent, RouterModelPreference, CachedRouterResponse, ProviderRanking } from '../types/index';
import { toLegacyRouteDecision, validateRankedRouteDecision } from './ranked-routing';
import type { PolicyEngine } from '../policy/engine';
import type { ModelRegistry } from '../models/registry';
import type { Logger } from '../logging/logger';
import type { SemanticCache } from '../cache';
import { hashPrompt } from '../cache';
import type { MultiProviderResult } from './router-llm';

/**
 * Type guard to check if a value is a MultiProviderResult
 */
function isMultiProviderResult(obj: unknown): obj is MultiProviderResult {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'provider_rankings' in obj &&
    'consensus' in obj &&
    typeof (obj as any).consensus === 'object' &&
    (obj as any).consensus !== null &&
    'ranked_models' in (obj as any).consensus
  );
}

/**
 * Type guard to check if a value is a legacy RankedRouteDecision
 */
function isRankedRouteDecision(obj: unknown): obj is RankedRouteDecision {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'intent' in obj &&
    'ranked_models' in obj &&
    Array.isArray((obj as any).ranked_models) &&
    (obj as any).ranked_models.length > 0
  );
}

/**
 * Wraps a legacy RankedRouteDecision into MultiProviderResult format
 *
 * For backward compatibility with routers that return the old format (e.g., StubRouterLLM).
 * Populates the requested provider's ranking to avoid unnecessary fallback to consensus.
 *
 * @param decision - Legacy RankedRouteDecision
 * @param requestedProvider - Which provider the user requested
 * @returns MultiProviderResult with consensus and optionally requested provider populated
 */
function wrapLegacyDecision(
  decision: RankedRouteDecision,
  requestedProvider: RouterModelPreference
): MultiProviderResult {
  const now = new Date().toISOString();
  const providerRankings: MultiProviderResult['provider_rankings'] = {};

  // If a specific provider was requested (not consensus), populate it
  // This prevents unnecessary fallback when using legacy routers like StubRouterLLM
  if (requestedProvider !== 'consensus') {
    providerRankings[requestedProvider] = {
      provider: requestedProvider,
      decision,
      generated_at: now,
    };
  }

  return {
    provider_rankings: providerRankings,
    consensus: decision,
  };
}

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
   * @param context - Additional context (token config, preferences, user keys, etc.)
   * @returns Raw LLM response (will be validated against RouteDecision schema)
   */
  invoke(
    prompt: string,
    eligibleModels: string[],
    context: {
      tokenConfig: TokenConfig;
      preferModel?: string;
      requestMetadata?: Record<string, unknown>;
      userLLMKeys?: any[]; // Optional: DecryptedLLMKey[] for BYOLLM users
    },
  ): Promise<unknown>;
}

export interface RoutingEngine {
  route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string,
    userContext?: {
      user?: any; // User object from users/types (if authenticated)
      userTier?: any; // UserTier from users/types
    },
  ): Promise<RouteResult>;
}

export interface RoutingEngineDependencies {
  routerLLM: RouterLLM;
  policyEngine: PolicyEngine;
  modelRegistry: ModelRegistry;
  logger: Logger;
  cache?: SemanticCache;
  userLLMKeyStore?: any; // Optional: UserLLMKeyStore from users/llm-keys (if BYOLLM enabled)
}

export class DefaultRoutingEngine implements RoutingEngine {
  private warnedTokens = new Set<string>(); // Track tokens we've warned about intent-based rules

  constructor(private readonly deps: RoutingEngineDependencies) {}

  async route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string,
    userContext?: {
      user?: any;
      userTier?: any;
    },
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

    // Resolve effective router preference (request > token > consensus)
    const effectiveRouter = this.resolveEffectiveRouter(request.router_model, tokenConfig);

    // Check global cache AFTER policy evaluation, BEFORE router LLM invocation (REQUIREMENTS.md §8 step 8)
    // Note: Cache is global (no token isolation). App handles token-specific behavior via policies.
    let routerModelUsed = effectiveRouter;
    if (this.deps.cache) {
      const cachedResponse = await this.deps.cache.get(request.prompt);

      if (cachedResponse) {
        // Extract the requested provider's ranking
        let rankedDecision = this.extractProviderRanking(cachedResponse, effectiveRouter);

        // If requested provider not available, fall back to consensus
        if (!rankedDecision) {
          this.deps.logger.warn('Requested router provider not in cache, falling back to consensus', {
            requested_router: effectiveRouter,
            token_id: tokenConfig.id,
            prompt_hash: hashPrompt(request.prompt),
            request_id: requestId,
          });
          rankedDecision = cachedResponse.consensus;
          routerModelUsed = 'consensus';
        }

        this.deps.logger.info('Global cache hit - returning cached decision', {
          token_id: tokenConfig.id,
          prompt_hash: hashPrompt(request.prompt),
          request_id: requestId,
          router_model_used: routerModelUsed,
          router_model_requested: effectiveRouter,
          top_model: rankedDecision.ranked_models[0]?.model,
        });

        // Convert ranked decision to legacy format for backward compatibility
        const decision = toLegacyRouteDecision(rankedDecision);

        return {
          decision,
          policyMetadata: {
            forcedModel: policyResult.forced_model,
            eligibleModelsCount: eligibleModels.length,
          },
          cache_hit: true,
          router_model_used: routerModelUsed,
        };
      }

      this.deps.logger.info('Cache miss - invoking router LLM', {
        token_id: tokenConfig.id,
        prompt_hash: hashPrompt(request.prompt),
        request_id: requestId,
        router_model_requested: effectiveRouter,
      });
    }

    // Load user LLM keys if BYOLLM tier (for BYOLLM feature)
    let userLLMKeys: any[] | undefined;
    if (userContext?.userTier === 'paid_byollm' && userContext?.user?.id && this.deps.userLLMKeyStore) {
      try {
        userLLMKeys = await this.deps.userLLMKeyStore.getDecryptedKeys(userContext.user.id);

        if (!userLLMKeys || userLLMKeys.length === 0) {
          this.deps.logger.warn('BYOLLM user has no configured LLM keys, falling back to system', {
            user_id: userContext.user.id,
            request_id: requestId,
          });
        }
      } catch (error) {
        this.deps.logger.error('Failed to load user LLM keys, falling back to system', {
          user_id: userContext.user.id,
          request_id: requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Cache miss - invoke router LLM with policy-filtered eligible models
    // Router LLM may return MultiProviderResult or legacy RankedRouteDecision (e.g., from StubRouterLLM)
    const rawDecision = await this.deps.routerLLM.invoke(request.prompt, eligibleModels, {
      tokenConfig,
      preferModel: request.prefer_model,
      requestMetadata: request.metadata,
      userLLMKeys, // Pass user's LLM keys if BYOLLM tier
    });

    // Handle both MultiProviderResult and legacy RankedRouteDecision formats
    let multiProviderResult: MultiProviderResult;

    if (isMultiProviderResult(rawDecision)) {
      // Modern multi-provider format
      multiProviderResult = rawDecision;
    } else if (isRankedRouteDecision(rawDecision)) {
      // Legacy format (e.g., StubRouterLLM) - wrap it for consistency
      this.deps.logger.warn('Router LLM returned legacy RankedRouteDecision format, wrapping in MultiProviderResult', {
        token_id: tokenConfig.id,
        request_id: requestId,
      });
      multiProviderResult = wrapLegacyDecision(rawDecision, effectiveRouter);
    } else {
      // Invalid format
      throw new Error(
        'Router LLM must return either MultiProviderResult or RankedRouteDecision format. ' +
        `Got: ${typeof rawDecision}`
      );
    }

    // Build CachedRouterResponse for storage
    const cachedResponse = this.buildCachedResponse(
      request.prompt,
      multiProviderResult,
      this.deps.cache?.getTTL() ?? 3600 // Default 1 hour if not configured
    );

    // Extract the requested provider's ranking
    let rankedDecision = this.extractProviderRanking(cachedResponse, effectiveRouter);

    // If requested provider not available, fall back to consensus
    if (!rankedDecision) {
      this.deps.logger.warn('Requested router provider not available, falling back to consensus', {
        requested_router: effectiveRouter,
        token_id: tokenConfig.id,
        prompt_hash: hashPrompt(request.prompt),
        request_id: requestId,
      });
      rankedDecision = multiProviderResult.consensus;
      routerModelUsed = 'consensus';
    }

    // Validate the extracted ranking
    validateRankedRouteDecision(rankedDecision, eligibleModels);

    // Convert to legacy format for backward compatibility
    const decision = toLegacyRouteDecision(rankedDecision);

    // Store full multi-provider response in global cache (fire-and-forget to avoid adding latency)
    if (this.deps.cache) {
      this.deps.cache.set(request.prompt, cachedResponse)
        .then(() => {
          this.deps.logger.info('Cached routing decision for future requests', {
            token_id: tokenConfig.id,
            prompt_hash: hashPrompt(request.prompt),
            request_id: requestId,
            has_openai: !!cachedResponse.provider_rankings.openai,
            has_gemini: !!cachedResponse.provider_rankings.gemini,
            top_model: rankedDecision!.ranked_models[0]?.model,
          });
        })
        .catch((err) => {
          this.deps.logger.warn('Cache store failed', {
            error: err instanceof Error ? err.message : String(err),
            token_id: tokenConfig.id,
            prompt_hash: hashPrompt(request.prompt),
            request_id: requestId,
          });
        });
    }

    // Intent is now captured but not used for routing logic
    // It will be logged for internal analysis only

    return {
      decision,
      policyMetadata: {
        forcedModel: policyResult.forced_model,
        eligibleModelsCount: eligibleModels.length,
      },
      router_model_used: routerModelUsed,
    };
  }

  /**
   * Resolves the effective router model preference
   *
   * Priority order:
   * 1. Request-level router_model parameter
   * 2. Token-level router_model_preference
   * 3. Default: "consensus"
   */
  private resolveEffectiveRouter(
    requestRouterModel: RouterModelPreference | undefined,
    tokenConfig: TokenConfig
  ): RouterModelPreference {
    if (requestRouterModel !== undefined) {
      return requestRouterModel;
    }

    if (tokenConfig.router_model_preference !== undefined) {
      return tokenConfig.router_model_preference;
    }

    return 'consensus';
  }

  /**
   * Extracts the ranking for a specific router model from cached response
   *
   * @param cachedResponse - Full cached response with all provider rankings
   * @param routerModel - Which provider's ranking to extract
   * @returns Extracted ranked decision, or null if provider not available
   */
  private extractProviderRanking(
    cachedResponse: CachedRouterResponse,
    routerModel: RouterModelPreference
  ): RankedRouteDecision | null {
    // Handle consensus request
    if (routerModel === 'consensus') {
      return cachedResponse.consensus;
    }

    // Get specific provider ranking
    const providerRanking = cachedResponse.provider_rankings[routerModel];

    if (!providerRanking) {
      return null;
    }

    return providerRanking.decision;
  }

  /**
   * Builds a CachedRouterResponse from MultiProviderResult
   *
   * Constructs a complete cache entry containing all provider rankings and consensus.
   * This allows future requests to retrieve rankings from any provider without re-invoking router LLMs.
   *
   * @param prompt - Original user prompt used as cache key
   * @param multiProviderResult - Router LLM response with all provider rankings and consensus
   * @param ttl - Time-to-live in seconds for this cache entry
   * @returns Complete CachedRouterResponse ready for storage
   */
  private buildCachedResponse(
    prompt: string,
    multiProviderResult: MultiProviderResult,
    ttl: number
  ): CachedRouterResponse {
    return {
      prompt,
      provider_rankings: multiProviderResult.provider_rankings,
      consensus: multiProviderResult.consensus,
      cached_at: new Date().toISOString(),
      ttl,
    };
  }
}

export function createRoutingEngine(deps: RoutingEngineDependencies): RoutingEngine {
  return new DefaultRoutingEngine(deps);
}

// StubRouterLLM has been moved to src/routing/router-llm/stub-router-llm.ts
// Import it from there if needed for testing
