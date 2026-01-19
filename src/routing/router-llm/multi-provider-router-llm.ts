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
import { loadRouterLLMConfig, type RouterLLMConfig } from '../config';
import { buildRoutingPrompt } from './prompt-builder';
import { validateRankedRouteDecision } from '../ranked-routing';
import {
  RouterLLMError,
  RouterLLMParseError,
  RouterLLMTimeoutError,
  RouterLLMPolicyBypassError,
  RouterLLMProviderError,
} from './errors';

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

  /**
   * Creates a new MultiProviderRouterLLM instance
   *
   * @param config - Optional configuration (defaults to loading from environment)
   * @param logger - Optional logger (defaults to console)
   */
  constructor(config?: RouterLLMConfig, logger?: Console) {
    this.config = config ?? loadRouterLLMConfig();

    // Only initialize clients for enabled providers
    if (this.config.openai.enabled && this.config.openai.apiKey) {
      this.openaiClient = new OpenAIClient(this.config.openai.apiKey);
    }
    if (this.config.gemini.enabled && this.config.gemini.apiKey) {
      this.geminiClient = new GeminiClient(this.config.gemini.apiKey);
    }

    this.logger = logger;
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
    });

    // Determine which providers are enabled
    const enabledProviders: Array<{ client: ProviderClient; model: string; name: string }> = [];

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

    // Log invocation
    const providerNames = enabledProviders.map(p => p.name).join(' + ');
    this.logger?.log(`[MultiProviderRouterLLM] Invoking ${providerNames}`, {
      providers: enabledProviders.map(p => ({ name: p.name, model: p.model })),
      eligibleModels,
      preferModel: context.preferModel,
    });

    // Invoke all enabled providers in parallel using Promise.allSettled for resilience
    const startTime = Date.now();
    const results = await Promise.allSettled(
      enabledProviders.map(provider =>
        this.invokeProvider(provider.client, provider.model, provider.name, routingPrompt, eligibleModels)
      )
    );
    const totalLatencyMs = Date.now() - startTime;

    // Separate successful and failed results
    const decisions: RankedRouteDecision[] = [];
    const failedProviders: Array<{ name: string; error: Error }> = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        decisions.push(result.value);
      } else {
        failedProviders.push({
          name: enabledProviders[index].name,
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        });
      }
    });

    // If all providers failed, throw the first error
    if (decisions.length === 0) {
      const errorMessages = failedProviders.map(f => `${f.name}: ${f.error.message}`).join('; ');
      throw new RouterLLMError(
        `All router LLM providers failed: ${errorMessages}`,
        failedProviders[0].error
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
      if (result.status === 'fulfilled') {
        const providerName = enabledProviders[index].name as 'openai' | 'gemini';
        providerRankings[providerName] = {
          provider: providerName,
          decision: result.value,
          generated_at: now,
        };
      }
    });

    // Get list of successful providers for logging
    const successfulProviders = results
      .map((result, index) => result.status === 'fulfilled' ? enabledProviders[index] : null)
      .filter((p): p is { client: ProviderClient; model: string; name: string } => p !== null);

    // If only one provider succeeded, use its decision as consensus
    if (decisions.length === 1) {
      this.logger?.log(`[MultiProviderRouterLLM] Single provider response`, {
        provider: successfulProviders[0].name,
        latencyMs: totalLatencyMs,
        top_model: decisions[0].ranked_models[0]?.model,
        top_score: decisions[0].ranked_models[0]?.score,
      });

      return {
        provider_rankings: providerRankings,
        consensus: decisions[0],
      };
    }

    // Multiple providers - aggregate rankings
    this.logger?.log(`[MultiProviderRouterLLM] ${decisions.length} providers responded`, {
      totalLatencyMs,
      providers: successfulProviders.map((p, i) => ({
        name: p.name,
        top_model: decisions[i].ranked_models[0]?.model,
      })),
    });

    // Pair decisions with provider names for aggregation
    const decisionsWithProviders = decisions.map((decision, i) => ({
      decision,
      providerName: successfulProviders[i].name,
    }));

    // Aggregate rankings by averaging scores
    const aggregatedDecision = this.aggregateRankings(decisionsWithProviders, eligibleModels);

    this.logger?.log('[MultiProviderRouterLLM] Aggregated ranking decision', {
      intent: aggregatedDecision.intent,
      ranked_models_count: aggregatedDecision.ranked_models.length,
      top_model: aggregatedDecision.ranked_models[0]?.model,
      top_score: aggregatedDecision.ranked_models[0]?.score,
      provider_agreements: successfulProviders.map((p, i) => ({
        provider: p.name,
        agrees_with_aggregated: decisions[i].ranked_models[0]?.model === aggregatedDecision.ranked_models[0]?.model,
      })),
    });

    return {
      provider_rankings: providerRankings,
      consensus: aggregatedDecision,
    };
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
    providerName: string,
    routingPrompt: string,
    eligibleModels: string[]
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
        });

        // Parse response as JSON
        let parsed: any;
        try {
          parsed = JSON.parse(response.content);
        } catch (error) {
          // Log the raw response for diagnosis of intermittent parse failures
          this.logger?.error(`[${providerName}] Failed to parse response as JSON`, {
            error: error instanceof Error ? error.message : String(error),
            rawResponse: response.content,
            responseLength: response.content.length,
            model: response.metadata.model,
            outputTokens: response.metadata.outputTokens,
            inputTokens: response.metadata.inputTokens,
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
      rankedModels[i].rank = i + 1;
    }

    // Use consensus intent (prefer first provider if different)
    const intent = decisionsWithProviders[0].decision.intent;

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
}
