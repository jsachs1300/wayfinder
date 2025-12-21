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

import type { RouterLLM } from '../engine.js';
import type { TokenConfig } from '../../types/index.js';
import type { ProviderClient } from './providers/types.js';
import { createProviderClient } from './providers/index.js';
import { loadRouterLLMConfig, type RouterLLMConfig } from '../config.js';
import { buildRoutingPrompt } from './prompt-builder.js';
import { parseRouteDecisionLenient } from './response-parser.js';
import {
  RouterLLMError,
  RouterLLMRetryExhaustedError,
  RouterLLMTimeoutError,
} from './errors.js';

/**
 * Default Router LLM implementation
 */
export class DefaultRouterLLM implements RouterLLM {
  private readonly config: RouterLLMConfig;
  private readonly client: ProviderClient;
  private readonly logger?: Console;

  /**
   * Creates a new DefaultRouterLLM instance
   *
   * @param config - Optional configuration (defaults to loading from environment)
   * @param logger - Optional logger (defaults to console)
   */
  constructor(config?: RouterLLMConfig, logger?: Console) {
    this.config = config ?? loadRouterLLMConfig();
    this.client = createProviderClient(this.config.provider, this.config.apiKey);
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
    }
  ): Promise<unknown> {
    // Build the routing prompt
    const routingPrompt = buildRoutingPrompt({
      prompt,
      eligibleModels,
      tokenConfig: context.tokenConfig,
      preferModel: context.preferModel,
      requestMetadata: context.requestMetadata,
    });

    // Log invocation
    this.logger?.log('[RouterLLM] Invoking router LLM', {
      provider: this.config.provider,
      model: this.config.model,
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
          model: this.config.model,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          timeout: this.config.timeout,
        });

        const latencyMs = Date.now() - startTime;

        // Log response metadata
        this.logger?.log('[RouterLLM] Received response', {
          provider: response.metadata.provider,
          model: response.metadata.model,
          latencyMs,
          inputTokens: response.metadata.inputTokens,
          outputTokens: response.metadata.outputTokens,
        });

        // Parse and validate response
        const decision = parseRouteDecisionLenient(response.content);

        // Log decision
        this.logger?.log('[RouterLLM] Routing decision', {
          intent: decision.intent,
          primary: decision.primary.model,
          primaryScore: decision.primary.score,
          alternate: decision.alternate.model,
          alternateScore: decision.alternate.score,
        });

        return decision;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on timeout errors (they already took the full timeout duration)
        if (error instanceof RouterLLMTimeoutError) {
          this.logger?.error('[RouterLLM] Request timed out, not retrying', {
            timeoutMs: error.timeoutMs,
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
