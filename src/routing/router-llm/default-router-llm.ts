/**
 * Default Router LLM Implementation
 *
 * This is the production implementation of RouterLLM that invokes
 * a real LLM provider to make routing decisions.
 *
 * Features:
 * - Configurable provider (OpenAI, Anthropic)
 * - Retry logic with exponential backoff
 * - Comprehensive error handling
 * - Request/response logging
 * - Schema validation
 */

import type { RouterLLM } from '../engine';
import type { TokenConfig } from '../../types/index';
import type { ProviderClient } from './providers/types';
import { createProviderClient } from './providers/index';
import { loadRouterLLMConfig, type RouterLLMConfig } from '../config';
import { buildRoutingPrompt } from './prompt-builder';
import { validateRankedRouteDecision } from '../ranked-routing';
import { recordLlmCall, recordLlmError } from '../../observability/metrics';
import {
  RouterLLMError,
  RouterLLMParseError,
  RouterLLMRetryExhaustedError,
  RouterLLMTimeoutError,
  RouterLLMPolicyBypassError,
  RouterLLMProviderError,
  RouterLLMConfigError,
} from './errors';

/**
 * Default Router LLM implementation
 */
export class DefaultRouterLLM implements RouterLLM {
  private readonly config: RouterLLMConfig;
  private readonly client: ProviderClient;
  private readonly providerName: 'openai' | 'gemini';
  private readonly model: string;
  private readonly logger?: Console;

  /**
   * Creates a new DefaultRouterLLM instance
   *
   * @param config - Optional configuration (defaults to loading from environment)
   * @param logger - Optional logger (defaults to console)
   */
  constructor(config?: RouterLLMConfig, logger?: Console) {
    this.config = config ?? loadRouterLLMConfig();
    const { providerName, providerConfig } = this.selectProvider(this.config);

    if (!providerConfig.apiKey) {
      throw new RouterLLMConfigError(`Missing API key for ${providerName} provider`);
    }

    this.providerName = providerName;
    this.model = providerConfig.model;
    this.client = createProviderClient(providerName, providerConfig.apiKey);
    this.logger = logger;
  }

  /**
   * Invokes the router LLM to make a routing decision
   *
   * Steps:
   * 1. Build routing prompt
   * 2. Invoke provider with retry logic
   * 3. Parse and validate response
   * 4. Return validated RouteDecision
   *
   * @param prompt - User's prompt
   * @param eligibleModels - Models eligible for selection
   * @param context - Additional context
   * @returns RouteDecision (validated against schema)
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

    // Build the routing prompt
    const routingPrompt = buildRoutingPrompt({
      prompt,
      eligibleModels,
      tokenConfig: context.tokenConfig,
      preferModel: context.preferModel,
      requestMetadata: context.requestMetadata,
      eligibleModelRegistry: context.eligibleModelRegistry,
    });

    // Log invocation
    this.logger?.log('[RouterLLM] Invoking router LLM', {
      provider: this.providerName,
      model: this.model,
      eligibleModels,
      preferModel: context.preferModel,
    });

    // Invoke provider with retry logic
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Calculate backoff delay (exponential: 0ms, 1s, 2s, 4s, etc.)
        if (attempt > 0) {
          const delayMs = Math.pow(2, attempt - 1) * 1000;
          this.logger?.log(`[RouterLLM] Retry attempt ${attempt} after ${delayMs}ms delay`);
          await this.sleep(delayMs);
        }

        // Invoke the provider
        const startTime = Date.now();
        const response = await this.client.invoke({
          prompt: routingPrompt,
          model: this.model,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          timeout: this.config.timeout,
        });

        const latencyMs = Date.now() - startTime;
        recordLlmCall(this.providerName, latencyMs, {});

        // Log response metadata
        this.logger?.log('[RouterLLM] Received response', {
          provider: response.metadata.provider,
          model: response.metadata.model,
          latencyMs,
          inputTokens: response.metadata.inputTokens,
          outputTokens: response.metadata.outputTokens,
        });

        // Parse response as JSON
        let parsed: any;
        try {
          parsed = JSON.parse(response.content);
        } catch (error) {
          // Log the raw response for diagnosis of intermittent parse failures
          this.logger?.error('[RouterLLM] Failed to parse response as JSON', {
            error: error instanceof Error ? error.message : String(error),
            rawResponse: response.content,
            responseLength: response.content.length,
            provider: response.metadata.provider,
            model: response.metadata.model,
            outputTokens: response.metadata.outputTokens,
            inputTokens: response.metadata.inputTokens,
          });

          throw new RouterLLMParseError(
            `Failed to parse router LLM response as JSON: ${error instanceof Error ? error.message : String(error)}`,
            response.content,
            error instanceof Error ? error : undefined
          );
        }

        // Validate as ranked route decision (includes security check for model eligibility)
        const rankedDecision = validateRankedRouteDecision(parsed, eligibleModels);

        // Log decision
        this.logger?.log('[RouterLLM] Ranked routing decision', {
          intent: rankedDecision.intent,
          ranked_models_count: rankedDecision.ranked_models.length,
          top_model: rankedDecision.ranked_models[0]?.model,
          top_score: rankedDecision.ranked_models[0]?.score,
        });

        return rankedDecision;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        recordLlmError(this.providerName, {});

        // Don't retry on timeout errors (they already took the full timeout duration)
        if (error instanceof RouterLLMTimeoutError) {
          this.logger?.error('[RouterLLM] Request timed out, not retrying', {
            timeoutMs: error.timeoutMs,
          });
          throw error;
        }

        // Don't retry on parse errors (retrying won't fix malformed JSON)
        if (error instanceof RouterLLMParseError) {
          this.logger?.error('[RouterLLM] Parse error, not retrying', {
            error: error.message,
            responseLength: error.rawResponse.length,
          });
          throw error;
        }

        // Don't retry on validation errors (retrying won't fix schema issues)
        if (error instanceof RouterLLMError && error.name === 'RouterLLMValidationError') {
          this.logger?.error('[RouterLLM] Validation error, not retrying', {
            error: error.message,
          });
          throw error;
        }

        // Don't retry on policy bypass errors (LLM selected ineligible model)
        if (error instanceof RouterLLMPolicyBypassError) {
          this.logger?.error('[RouterLLM] Policy bypass detected, not retrying', {
            field: error.field,
            selectedModel: error.selectedModel,
            eligibleModels: error.eligibleModels,
          });
          throw error;
        }

        // Don't retry on 4xx errors (except 429 rate limit which is retryable)
        // These errors indicate client-side issues that won't be resolved by retrying
        if (error instanceof RouterLLMProviderError && error.statusCode) {
          const nonRetryableStatuses = [400, 401, 403, 404, 422];
          if (nonRetryableStatuses.includes(error.statusCode)) {
            this.logger?.error('[RouterLLM] Non-retryable HTTP error, not retrying', {
              statusCode: error.statusCode,
              provider: error.provider,
              error: error.message,
            });
            throw error;
          }
        }

        // Log retry-eligible error
        this.logger?.warn('[RouterLLM] Invocation failed, will retry if attempts remain', {
          attempt,
          maxRetries: this.config.maxRetries,
          error: lastError.message,
        });
      }
    }

    // All retries exhausted
    throw new RouterLLMRetryExhaustedError(
      `Router LLM invocation failed after ${this.config.maxRetries + 1} attempts`,
      this.config.maxRetries + 1,
      lastError
    );
  }

  /**
   * Sleep helper for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private selectProvider(config: RouterLLMConfig): {
    providerName: 'openai' | 'gemini';
    providerConfig: { apiKey?: string; model: string };
  } {
    if (config.openai.enabled) {
      return { providerName: 'openai', providerConfig: config.openai };
    }
    if (config.gemini.enabled) {
      return { providerName: 'gemini', providerConfig: config.gemini };
    }
    throw new RouterLLMConfigError('No router LLM providers enabled');
  }

  /**
   * Returns the current configuration
   */
  getConfig(): RouterLLMConfig {
    return { ...this.config };
  }

  /**
   * Returns the provider client
   */
  getClient(): ProviderClient {
    return this.client;
  }
}
