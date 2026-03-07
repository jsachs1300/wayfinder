/**
 * Multi-Provider Router LLM Implementation
 *
 * Queries multiple LLM providers (OpenAI and Gemini) in parallel and aggregates
 * their responses by averaging rankings. This provides more robust routing decisions
 * through LLM consensus.
 *
 * Features:
 * - Parallel invocation of multiple providers
 * - Ranking aggregation via score averaging
 * - Retry logic per provider
 * - Comprehensive error handling
 */

import type { RouterLLM } from '../engine';
import type { TokenConfig, RankedRouteDecision, RankedModel, ProviderRanking } from '../../types/index';
import type { ProviderClient } from './providers/types';
import { OpenAIClient, GeminiClient } from './providers/index';
import { loadRouterLLMConfig, type RouterLLMConfig, type RouterLLMProvider } from '../config';
import { buildRoutingPrompt } from './prompt-builder';
import { validateRankedRouteDecision } from '../ranked-routing';
import {
  RouterLLMError,
  RouterLLMParseError,
  RouterLLMTimeoutError,
  RouterLLMPolicyBypassError,
  RouterLLMProviderError,
} from './errors';
import {
  recordLlmCall,
  recordLlmError,
  recordLlmCircuitBreakerBlock,
  recordLlmCircuitBreakerTransition,
  type RoutingMetricAttributes,
} from '../../observability/metrics';
import { dumpRawRouterResponse } from './raw-response-dump';
import { ProviderCircuitBreaker } from './circuit-breaker';
import type {
  RouterProviderHealthStore,
  ProviderHealthState,
  PreflightStatus,
  CircuitBreakerState,
} from './provider-health';

/**
 * Result from querying all router LLM providers
 * Contains individual provider results plus aggregated consensus
 */
export interface MultiProviderResult {
  /** Individual provider rankings (undefined if provider failed/disabled) */
  provider_rankings: {
    openai?: ProviderRanking;
    gemini?: ProviderRanking;
  };
  /** Aggregated consensus from all available providers */
  consensus: RankedRouteDecision;
}

/**
 * Multi-Provider Router LLM implementation
 *
 * Queries both OpenAI and Gemini, then averages their rankings to produce
 * a consensus routing decision.
 */
export class MultiProviderRouterLLM implements RouterLLM {
  private readonly config: RouterLLMConfig;
  private readonly openaiClient?: ProviderClient;
  private readonly geminiClient?: ProviderClient;
  private readonly logger?: Console;
  private readonly circuitBreaker: ProviderCircuitBreaker;
  private readonly providerHealthStore?: RouterProviderHealthStore;
  private readonly providerOrder: ReadonlyArray<RouterLLMProvider> = ['openai', 'gemini'];

  /**
   * Creates a new MultiProviderRouterLLM instance
   *
   * @param config - Optional configuration (defaults to loading from environment)
   * @param logger - Optional logger (defaults to console)
   */
  constructor(config?: RouterLLMConfig, logger?: Console, providerHealthStore?: RouterProviderHealthStore) {
    this.config = config ?? loadRouterLLMConfig();
    this.circuitBreaker = new ProviderCircuitBreaker({
      errorThreshold: this.config.reliability.circuitBreakerErrorThreshold,
      windowMs: this.config.reliability.circuitBreakerWindowMs,
      openMs: this.config.reliability.circuitBreakerOpenMs,
    });

    // Only initialize clients for enabled providers
    if (this.config.openai.enabled && this.config.openai.apiKey) {
      this.openaiClient = new OpenAIClient(this.config.openai.apiKey);
    }
    if (this.config.gemini.enabled && this.config.gemini.apiKey) {
      this.geminiClient = new GeminiClient(this.config.gemini.apiKey);
    }

    this.logger = logger;
    this.providerHealthStore = providerHealthStore;
  }

  /**
   * Invokes both router LLMs and aggregates their decisions
   *
   * Steps:
   * 1. Build routing prompt (same for both providers)
   * 2. Invoke both OpenAI and Gemini in parallel
   * 3. Parse and validate both responses
   * 4. Aggregate rankings by averaging scores
   * 5. Return aggregated RouteDecision
   *
   * @param prompt - User's prompt
   * @param eligibleModels - Models eligible for selection
   * @param context - Additional context
   * @returns Aggregated RankedRouteDecision
   * @throws RouterLLMError on failure
   */
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
    // Input validation
    if (!prompt || prompt.trim().length === 0) {
      throw new RouterLLMError('Prompt cannot be empty');
    }

    if (prompt.length > 100000) {
      throw new RouterLLMError(
        `Prompt exceeds maximum length of 100,000 characters (got ${prompt.length}). ` +
        'This limit prevents prompt injection attacks and excessive API costs.'
      );
    }

    if (!eligibleModels || eligibleModels.length === 0) {
      throw new RouterLLMError(
        'At least one eligible model is required for routing decisions. ' +
        'Check that policy evaluation returned eligible models.'
      );
    }

    // Build the routing prompt (same for both providers)
    const routingPrompt = buildRoutingPrompt({
      prompt,
      eligibleModels,
      tokenConfig: context.tokenConfig,
      preferModel: context.preferModel,
      requestMetadata: context.requestMetadata,
      eligibleModelRegistry: context.eligibleModelRegistry,
    });

    // Determine which providers are enabled
    const enabledProviders: Array<{ client: ProviderClient; model: string; name: RouterLLMProvider }> = [];
    const metricAttributes = this.toRoutingMetricAttributes(context.requestMetadata);

    if (this.config.openai.enabled && this.openaiClient) {
      enabledProviders.push({
        client: this.openaiClient,
        model: this.config.openai.model,
        name: 'openai',
      });
    }

    if (this.config.gemini.enabled && this.geminiClient) {
      enabledProviders.push({
        client: this.geminiClient,
        model: this.config.gemini.model,
        name: 'gemini',
      });
    }

    // Validate at least one provider is enabled at runtime
    if (enabledProviders.length === 0) {
      throw new RouterLLMError(
        'No router LLM providers are enabled. ' +
        'Enable at least one provider via ROUTER_LLM_OPENAI_ENABLED or ROUTER_LLM_GEMINI_ENABLED.'
      );
    }

    const invocableProviders: Array<{ client: ProviderClient; model: string; name: RouterLLMProvider }> = [];
    const breakerBlockedProviders: Array<{ name: string; model: string; state: string }> = [];
    for (const provider of enabledProviders) {
      const preDecisionState = this.circuitBreaker.getState(provider.name, provider.model);
      const decision = this.circuitBreaker.shouldAllowRequest(provider.name, provider.model);
      const postDecisionState = this.circuitBreaker.getState(provider.name, provider.model);
      this.recordCircuitBreakerTransitionIfNeeded(
        provider.name,
        preDecisionState,
        postDecisionState,
        metricAttributes
      );
      if (!decision.allowed) {
        breakerBlockedProviders.push({
          name: provider.name,
          model: provider.model,
          state: decision.state,
        });
        this.updateProviderHealth(provider.name, provider.model, {
          circuitBreakerState: decision.state,
          healthState: this.healthStateFromCircuitBreaker(decision.state),
        });
        recordLlmCircuitBreakerBlock(provider.name, metricAttributes);
        continue;
      }
      invocableProviders.push(provider);
    }

    if (invocableProviders.length === 0) {
      throw new RouterLLMError(
        `All router LLM providers blocked by circuit breaker: ` +
        `${breakerBlockedProviders.map((p) => `${p.name}(${p.state})`).join(', ')}`
      );
    }

    // Log invocation
    const providerNames = invocableProviders.map(p => p.name).join(' + ');
    this.logger?.log(`[MultiProviderRouterLLM] Invoking ${providerNames}`, {
      providers: invocableProviders.map(p => ({ name: p.name, model: p.model })),
      blockedByCircuitBreaker: breakerBlockedProviders,
      eligibleModels,
      preferModel: context.preferModel,
    });

    if (this.config.reliability.consensusMode === 'fast' && invocableProviders.length > 1) {
      const requestedProvider = this.extractRequestedProvider(context.requestMetadata);
      return this.invokeFastConsensus(
        invocableProviders,
        routingPrompt,
        eligibleModels,
        metricAttributes,
        requestedProvider
      );
    } else if (this.config.reliability.consensusMode === 'fast' && invocableProviders.length <= 1) {
      this.logger?.log('[MultiProviderRouterLLM] Fast consensus fallback to standard flow (single invocable provider)', {
        invocable_count: invocableProviders.length,
      });
    }

    // Invoke all enabled providers in parallel using Promise.allSettled for resilience
    const startTime = Date.now();
    const results = await Promise.allSettled(
      invocableProviders.map(provider =>
        this.invokeProvider(
          provider.client,
          provider.model,
          provider.name,
          routingPrompt,
          eligibleModels,
          metricAttributes
        )
      )
    );
    const totalLatencyMs = Date.now() - startTime;

    // Separate successful and failed results
    const decisions: RankedRouteDecision[] = [];
    const failedProviders: Array<{ name: string; error: Error }> = [];

    results.forEach((result, index) => {
      const provider = invocableProviders[index];
      if (!provider) {
        return;
      }

      if (result.status === 'fulfilled') {
        const previousState = this.circuitBreaker.getState(provider.name, provider.model);
        this.circuitBreaker.recordSuccess(provider.name, provider.model);
        const currentState = this.circuitBreaker.getState(provider.name, provider.model);
        this.recordCircuitBreakerTransitionIfNeeded(
          provider.name,
          previousState,
          currentState,
          metricAttributes
        );
        this.updateProviderHealth(provider.name, provider.model, {
          circuitBreakerState: currentState,
          healthState: 'healthy',
          consecutiveFailures: 0,
          lastSuccessAt: new Date().toISOString(),
          lastError: undefined,
        });
        decisions.push(result.value);
      } else {
        const previousState = this.circuitBreaker.getState(provider.name, provider.model);
        this.circuitBreaker.recordFailure(provider.name, provider.model);
        const circuitBreakerState = this.circuitBreaker.getState(provider.name, provider.model);
        this.recordCircuitBreakerTransitionIfNeeded(
          provider.name,
          previousState,
          circuitBreakerState,
          metricAttributes
        );
        failedProviders.push({
          name: provider.name,
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        });
        this.updateProviderHealth(provider.name, provider.model, {
          circuitBreakerState,
          healthState: this.healthStateFromCircuitBreaker(circuitBreakerState),
          consecutiveFailuresIncrement: 1,
          lastFailureAt: new Date().toISOString(),
          lastError: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });

    // If all providers failed, throw the first error
    if (decisions.length === 0) {
      const errorMessages = failedProviders.map(f => `${f.name}: ${f.error.message}`).join('; ');
      const fallbackError = failedProviders[0]?.error ?? new Error('All router LLM providers failed');
      throw new RouterLLMError(
        `All router LLM providers failed: ${errorMessages}`,
        fallbackError
      );
    }

    // If some providers failed, log warnings but continue with successful ones
    if (failedProviders.length > 0) {
      this.logger?.warn('[MultiProviderRouterLLM] Some providers failed, using successful providers only', {
        failed: failedProviders.map(f => ({ name: f.name, error: f.error.message })),
        successful: decisions.length,
      });
    }

    // Build provider rankings from successful decisions
    const now = new Date().toISOString();
    const providerRankings: MultiProviderResult['provider_rankings'] = {};

    // Map decisions to their provider names
    results.forEach((result, index) => {
      const provider = invocableProviders[index];
      if (!provider || result.status !== 'fulfilled') {
        return;
      }
      const providerName = provider.name as 'openai' | 'gemini';
      providerRankings[providerName] = {
        provider: providerName,
        decision: result.value,
        generated_at: now,
      };
    });

    // Get list of successful providers for logging
    const successfulProviders = results
      .map((result, index) => result.status === 'fulfilled' ? invocableProviders[index] : null)
      .filter((p): p is { client: ProviderClient; model: string; name: RouterLLMProvider } => p !== null);

    // If only one provider succeeded, use its decision as consensus
    if (decisions.length === 1) {
      const provider = successfulProviders[0];
      const decision = decisions[0];
      if (!provider || !decision) {
        throw new RouterLLMError('Router LLM consensus unavailable due to missing provider result');
      }
      this.logger?.log(`[MultiProviderRouterLLM] Single provider response`, {
        provider: provider.name,
        latencyMs: totalLatencyMs,
        top_model: decision.ranked_models[0]?.model,
        top_score: decision.ranked_models[0]?.score,
      });

      return {
        provider_rankings: providerRankings,
        consensus: decision,
      };
    }

    // Multiple providers - aggregate rankings
    const decisionsWithProviders = successfulProviders.map((provider, index) => ({
      decision: decisions[index]!,
      providerName: provider.name,
    }));

    this.logger?.log(`[MultiProviderRouterLLM] ${decisions.length} providers responded`, {
      totalLatencyMs,
      providers: decisionsWithProviders.map(({ providerName, decision }) => ({
        name: providerName,
        top_model: decision.ranked_models[0]?.model,
      })),
    });

    // Aggregate rankings by averaging scores
    const aggregatedDecision = this.aggregateRankings(decisionsWithProviders, eligibleModels);

    this.logger?.log('[MultiProviderRouterLLM] Aggregated ranking decision', {
      intent: aggregatedDecision.intent,
      ranked_models_count: aggregatedDecision.ranked_models.length,
      top_model: aggregatedDecision.ranked_models[0]?.model,
      top_score: aggregatedDecision.ranked_models[0]?.score,
      provider_agreements: decisionsWithProviders.map(({ providerName, decision }) => ({
        provider: providerName,
        agrees_with_aggregated: decision.ranked_models[0]?.model === aggregatedDecision.ranked_models[0]?.model,
      })),
    });

    return {
      provider_rankings: providerRankings,
      consensus: aggregatedDecision,
    };
  }

  private async invokeFastConsensus(
    invocableProviders: Array<{ client: ProviderClient; model: string; name: RouterLLMProvider }>,
    routingPrompt: string,
    eligibleModels: string[],
    metricAttributes: RoutingMetricAttributes,
    requestedProvider?: RouterLLMProvider
  ): Promise<MultiProviderResult> {
    const startTime = Date.now();
    const failedProviders: Array<{ name: string; error: Error }> = [];

    const providerTasks = invocableProviders.map(async (provider) => {
      try {
        const decision = await this.invokeProvider(
          provider.client,
          provider.model,
          provider.name,
          routingPrompt,
          eligibleModels,
          metricAttributes
        );

        const previousState = this.circuitBreaker.getState(provider.name, provider.model);
        this.circuitBreaker.recordSuccess(provider.name, provider.model);
        const currentState = this.circuitBreaker.getState(provider.name, provider.model);
        this.recordCircuitBreakerTransitionIfNeeded(
          provider.name,
          previousState,
          currentState,
          metricAttributes
        );
        this.updateProviderHealth(provider.name, provider.model, {
          circuitBreakerState: currentState,
          healthState: 'healthy',
          consecutiveFailures: 0,
          lastSuccessAt: new Date().toISOString(),
          lastError: undefined,
        });

        return { provider, decision };
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const previousState = this.circuitBreaker.getState(provider.name, provider.model);
        this.circuitBreaker.recordFailure(provider.name, provider.model);
        const circuitBreakerState = this.circuitBreaker.getState(provider.name, provider.model);
        this.recordCircuitBreakerTransitionIfNeeded(
          provider.name,
          previousState,
          circuitBreakerState,
          metricAttributes
        );
        this.updateProviderHealth(provider.name, provider.model, {
          circuitBreakerState,
          healthState: this.healthStateFromCircuitBreaker(circuitBreakerState),
          consecutiveFailuresIncrement: 1,
          lastFailureAt: new Date().toISOString(),
          lastError: error.message,
        });
        failedProviders.push({ name: provider.name, error });
        throw error;
      }
    });
    const providersByName = new Map(invocableProviders.map((provider, index) => [provider.name, providerTasks[index]]));

    let firstSuccess: {
      provider: { client: ProviderClient; model: string; name: RouterLLMProvider };
      decision: RankedRouteDecision;
    };
    try {
      const requestedTask = requestedProvider ? providersByName.get(requestedProvider) : undefined;
      if (requestedTask) {
        try {
          firstSuccess = await requestedTask;
        } catch {
          firstSuccess = await Promise.any(providerTasks);
        }
      } else {
        firstSuccess = await Promise.any(providerTasks);
      }
    } catch (error) {
      const errorMessages = failedProviders.map((failed) => `${failed.name}: ${failed.error.message}`).join('; ');
      const fallbackError = failedProviders[0]?.error ?? (
        error instanceof Error ? error : new Error('All router LLM providers failed')
      );
      throw new RouterLLMError(
        `All router LLM providers failed: ${errorMessages}`,
        fallbackError
      );
    }

    const latencyMs = Date.now() - startTime;
    const generatedAt = new Date().toISOString();
    const providerName = firstSuccess.provider.name as 'openai' | 'gemini';
    const providerRankings: MultiProviderResult['provider_rankings'] = {
      [providerName]: {
        provider: providerName,
        decision: firstSuccess.decision,
        generated_at: generatedAt,
      },
    };

    if (failedProviders.length > 0) {
      this.logger?.warn('[MultiProviderRouterLLM] Fast consensus observed provider failures before response', {
        failed: failedProviders.map((failed) => ({ name: failed.name, error: failed.error.message })),
        note: 'Additional provider failures may be logged after background completion.',
      });
    }

    this.logger?.log('[MultiProviderRouterLLM] Fast consensus selected first successful provider', {
      provider: firstSuccess.provider.name,
      requested_provider: requestedProvider,
      latencyMs,
      top_model: firstSuccess.decision.ranked_models[0]?.model,
      top_score: firstSuccess.decision.ranked_models[0]?.score,
    });

    // Keep other in-flight provider calls running for async health/telemetry updates.
    void Promise.allSettled(providerTasks).then((settledResults) => {
      const backgroundFailures = settledResults
        .map((settled, index) => ({ settled, provider: invocableProviders[index] }))
        .filter((item): item is {
          settled: PromiseRejectedResult;
          provider: { client: ProviderClient; model: string; name: RouterLLMProvider };
        } => item.provider !== undefined && item.settled.status === 'rejected')
        .map((item) => ({
          name: item.provider.name,
          error: item.settled.reason instanceof Error ? item.settled.reason.message : String(item.settled.reason),
        }));

      if (backgroundFailures.length > 0) {
        this.logger?.warn('[MultiProviderRouterLLM] Fast consensus background provider failures', {
          failed: backgroundFailures,
        });
      }
    });

    return {
      provider_rankings: providerRankings,
      consensus: firstSuccess.decision,
    };
  }

  private extractRequestedProvider(requestMetadata?: Record<string, unknown>): RouterLLMProvider | undefined {
    const requested = requestMetadata?.router_model_requested;
    if (typeof requested !== 'string') {
      return undefined;
    }
    return this.providerOrder.includes(requested as RouterLLMProvider)
      ? (requested as RouterLLMProvider)
      : undefined;
  }

  /**
   * Invokes a single provider with retry logic
   *
   * @param client - Provider client
   * @param model - Model identifier
   * @param providerName - Provider name for logging
   * @param routingPrompt - Routing prompt
   * @param eligibleModels - Eligible models for validation
   * @returns Validated RankedRouteDecision
   * @throws RouterLLMError on failure
   */
  private async invokeProvider(
    client: ProviderClient,
    model: string,
    providerName: RouterLLMProvider,
    routingPrompt: string,
    eligibleModels: string[],
    metricAttributes: RoutingMetricAttributes
  ): Promise<RankedRouteDecision> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Calculate backoff delay
        if (attempt > 0) {
          const delayMs = Math.pow(2, attempt - 1) * 1000;
          this.logger?.log(`[${providerName}] Retry attempt ${attempt} after ${delayMs}ms delay`);
          await this.sleep(delayMs);
        }

        // Invoke the provider
        const response = await client.invoke({
          prompt: routingPrompt,
          model,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          timeout: this.config.timeout,
        });

        this.logger?.log(`[${providerName}] Received response`, {
          model: response.metadata.model,
          latencyMs: response.metadata.latencyMs,
          inputTokens: response.metadata.inputTokens,
          outputTokens: response.metadata.outputTokens,
          finishReason: response.metadata.finishReason,
        });
        recordLlmCall(providerName, response.metadata.latencyMs, metricAttributes);

        // Parse response as JSON
        let parsed: any;
        try {
          parsed = JSON.parse(response.content);
        } catch (error) {
          let dumpPath: string | undefined;
          try {
            dumpPath = await dumpRawRouterResponse({
              provider: providerName,
              model: response.metadata.model,
              rawResponse: response.content,
              parseError: error instanceof Error ? error.message : String(error),
              inputTokens: response.metadata.inputTokens,
              outputTokens: response.metadata.outputTokens,
            });
          } catch (dumpError) {
            this.logger?.warn(`[${providerName}] Failed to dump raw parse response`, {
              error: dumpError instanceof Error ? dumpError.message : String(dumpError),
            });
          }

          // Log the raw response for diagnosis of intermittent parse failures
          this.logger?.error(`[${providerName}] Failed to parse response as JSON`, {
            error: error instanceof Error ? error.message : String(error),
            rawResponse: response.content,
            responseLength: response.content.length,
            model: response.metadata.model,
            outputTokens: response.metadata.outputTokens,
            inputTokens: response.metadata.inputTokens,
            finishReason: response.metadata.finishReason,
            dumpPath,
          });

          throw new RouterLLMParseError(
            `Failed to parse ${providerName} response as JSON: ${error instanceof Error ? error.message : String(error)}`,
            response.content,
            error instanceof Error ? error : undefined
          );
        }

        // Validate as ranked route decision
        const rankedDecision = validateRankedRouteDecision(parsed, eligibleModels);

        return rankedDecision;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        recordLlmError(providerName, metricAttributes);

        // Don't retry on certain error types
        if (
          error instanceof RouterLLMTimeoutError ||
          error instanceof RouterLLMParseError ||
          error instanceof RouterLLMPolicyBypassError ||
          (error instanceof RouterLLMError && error.name === 'RouterLLMValidationError')
        ) {
          throw error;
        }

        // Don't retry on non-retryable HTTP errors
        if (error instanceof RouterLLMProviderError && error.statusCode) {
          const nonRetryableStatuses = [400, 401, 403, 404, 422];
          if (nonRetryableStatuses.includes(error.statusCode)) {
            throw error;
          }
        }

        this.logger?.warn(`[${providerName}] Invocation failed, will retry if attempts remain`, {
          attempt,
          maxRetries: this.config.maxRetries,
          error: lastError.message,
        });
      }
    }

    // All retries exhausted
    throw new RouterLLMError(
      `${providerName} invocation failed after ${this.config.maxRetries + 1} attempts: ${lastError?.message}`,
      lastError
    );
  }

  /**
   * Aggregates rankings from multiple providers by averaging scores
   *
   * Algorithm:
   * 1. For each model, collect its scores from all providers
   * 2. Calculate average score
   * 3. Sort models by average score (descending)
   * 4. Assign new ranks based on sorted order
   * 5. Use combined reasons from all providers
   *
   * @param decisionsWithProviders - Array of decisions paired with provider names
   * @param eligibleModels - All eligible models
   * @returns Aggregated RankedRouteDecision
   */
  private aggregateRankings(
    decisionsWithProviders: Array<{ decision: RankedRouteDecision; providerName: string }>,
    eligibleModels: string[]
  ): RankedRouteDecision {
    // Build a map of model -> scores from all providers
    const modelScores = new Map<string, { scores: number[]; reasons: string[] }>();

    // Initialize all eligible models
    for (const model of eligibleModels) {
      modelScores.set(model, { scores: [], reasons: [] });
    }

    // Collect scores from all providers
    for (const { decision, providerName } of decisionsWithProviders) {
      for (const rankedModel of decision.ranked_models) {
        const entry = modelScores.get(rankedModel.model);
        if (entry) {
          entry.scores.push(rankedModel.score);
          entry.reasons.push(`${providerName}: ${rankedModel.reason}`);
        }
      }
    }

    // Calculate average scores and build ranked models
    const rankedModels: RankedModel[] = [];
    for (const [model, data] of modelScores.entries()) {
      if (data.scores.length === 0) {
        // Model not ranked by any provider - skip it or assign default low score
        continue;
      }

      const avgScore = data.scores.reduce((sum, score) => sum + score, 0) / data.scores.length;

      rankedModels.push({
        rank: 0, // Will be assigned after sorting
        model,
        score: Math.round(avgScore * 10) / 10, // Round to 1 decimal place
        reason: data.reasons.join(' | '),
      });
    }

    // Sort by average score (descending)
    rankedModels.sort((a, b) => b.score - a.score);

    // Assign ranks
    for (let i = 0; i < rankedModels.length; i++) {
      const rankedModel = rankedModels[i];
      if (rankedModel) {
        rankedModel.rank = i + 1;
      }
    }

    // Use consensus intent (prefer first provider if different)
    const intent = decisionsWithProviders[0]?.decision.intent;
    if (!intent) {
      throw new RouterLLMError('Missing consensus intent from provider results');
    }

    return {
      intent,
      ranked_models: rankedModels,
    };
  }

  /**
   * Sleep helper for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns the current configuration
   */
  getConfig(): RouterLLMConfig {
    return { ...this.config };
  }

  private healthStateFromCircuitBreaker(state: CircuitBreakerState): ProviderHealthState {
    if (state === 'open') {
      return 'unhealthy';
    }
    if (state === 'half_open') {
      return 'degraded';
    }
    return 'healthy';
  }

  private updateProviderHealth(
    provider: RouterLLMProvider,
    model: string,
    update: {
      circuitBreakerState: CircuitBreakerState;
      healthState: ProviderHealthState;
      consecutiveFailures?: number;
      consecutiveFailuresIncrement?: number;
      lastSuccessAt?: string;
      lastFailureAt?: string;
      lastError?: string;
      preflightStatus?: PreflightStatus;
    }
  ): void {
    if (!this.providerHealthStore) {
      return;
    }

    const now = new Date().toISOString();
    const existing = this.providerHealthStore.get(provider, model);
    const existingConsecutiveFailures = existing?.consecutiveFailures ?? 0;
    const resolvedConsecutiveFailures = update.consecutiveFailures ?? (
      existingConsecutiveFailures + (update.consecutiveFailuresIncrement ?? 0)
    );
    const hasLastError = Object.prototype.hasOwnProperty.call(update, 'lastError');
    const nextLastError = hasLastError ? update.lastError : existing?.lastError;

    this.providerHealthStore.set({
      provider,
      model,
      healthState: update.healthState,
      circuitBreakerState: update.circuitBreakerState,
      preflightStatus: update.preflightStatus ?? existing?.preflightStatus ?? 'unknown',
      consecutiveFailures: resolvedConsecutiveFailures,
      lastSuccessAt: update.lastSuccessAt ?? existing?.lastSuccessAt,
      lastFailureAt: update.lastFailureAt ?? existing?.lastFailureAt,
      lastError: nextLastError,
      updatedAt: now,
    });
  }

  private toRoutingMetricAttributes(requestMetadata?: Record<string, unknown>): RoutingMetricAttributes {
    if (!requestMetadata) {
      return {};
    }

    const attributes: RoutingMetricAttributes = {};
    if (typeof requestMetadata.token_tier === 'string') {
      attributes.token_tier = requestMetadata.token_tier;
    }
    if (typeof requestMetadata.router_model_requested === 'string') {
      attributes.router_model_requested = requestMetadata.router_model_requested;
    }
    if (typeof requestMetadata.router_model_used === 'string') {
      attributes.router_model_used = requestMetadata.router_model_used;
    }
    return attributes;
  }

  private recordCircuitBreakerTransitionIfNeeded(
    provider: RouterLLMProvider,
    fromState: CircuitBreakerState,
    toState: CircuitBreakerState,
    attributes: RoutingMetricAttributes
  ): void {
    if (fromState === toState) {
      return;
    }
    recordLlmCircuitBreakerTransition(provider, fromState, toState, attributes);
  }
}
