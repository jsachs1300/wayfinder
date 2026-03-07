/**
 * OpenAI Provider Client
 *
 * Implements the ProviderClient interface for OpenAI's Chat Completions API.
 * Uses native fetch API without external SDKs.
 */

import type { ProviderClient, ProviderRequest, ProviderResponse } from './types';
import { buildProviderInvocationPlan } from '../provider-adapter';
import type { TokenLimitParameter } from '../capabilities';
import {
  RouterLLMProviderError,
  RouterLLMTimeoutError,
} from '../errors';
import { recordLlmCompatibilityRetry } from '../../../observability/metrics';

/**
 * OpenAI API request body structure
 */
interface OpenAIRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: { type: 'json_object' };
}

/**
 * OpenAI API response structure
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI error response structure
 */
interface OpenAIErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export class OpenAIClient implements ProviderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  getProviderName(): string {
    return 'openai';
  }

  private shouldRetryForTokenParameterCompatibility(message: string, status: number): boolean {
    if (status !== 400) {
      return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('unsupported parameter') &&
      (lower.includes('max_tokens') || lower.includes('max_completion_tokens'));
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();
    const compatRetryEnabled = process.env.ROUTER_COMPAT_RETRY_ENABLED !== 'false';
    const plan = buildProviderInvocationPlan('openai', request);

    // Use a single timeout budget across compatibility retries for this invocation.
    // This enforces per-operation timeout instead of per-attempt timeout.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeout);

    try {
      const tokenParameterAttempts: [TokenLimitParameter, ...TokenLimitParameter[]] = [plan.tokenLimitParameter];
      if (compatRetryEnabled) {
        tokenParameterAttempts.push(
          plan.tokenLimitParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
        );
      }

      let data: OpenAIResponse | undefined;
      let responseStatus: number | undefined;
      let lastProviderError: RouterLLMProviderError | undefined;

      for (let index = 0; index < tokenParameterAttempts.length; index += 1) {
        const tokenParam = tokenParameterAttempts[index];
        const body: OpenAIRequest = {
          model: request.model,
          messages: [
            {
              role: 'user',
              content: request.prompt,
            },
          ],
          temperature: request.temperature,
          ...(tokenParam === 'max_completion_tokens'
            ? { max_completion_tokens: request.maxTokens }
            : { max_tokens: request.maxTokens }),
          // Intentionally conditional: future capability profiles may disable
          // provider-native JSON mode for specific OpenAI model families.
          ...(plan.jsonResponseMode === 'native_json' ? { response_format: { type: 'json_object' as const } } : {}),
        };

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        responseStatus = response.status;

        if (!response.ok) {
          const errorData = (await response.json()) as OpenAIErrorResponse;
          const message = errorData.error?.message ?? `OpenAI API status ${response.status}`;
          const retryableCompatibilityError =
            index === 0 &&
            compatRetryEnabled &&
            this.shouldRetryForTokenParameterCompatibility(message, response.status);
          if (retryableCompatibilityError) {
            recordLlmCompatibilityRetry('openai', 'token_parameter', request.model);
            continue;
          }
          lastProviderError = new RouterLLMProviderError(
            `OpenAI API error: ${message}`,
            'openai',
            response.status
          );
          break;
        }

        data = (await response.json()) as OpenAIResponse;
        break;
      }

      clearTimeout(timeoutId);

      if (!data) {
        if (lastProviderError) {
          throw lastProviderError;
        }
        throw new RouterLLMProviderError(
          'OpenAI client invariant violated: compatibility attempts completed without response or provider error',
          'openai'
        );
      }

      // Extract content from first choice
      const choice = data.choices[0];
      if (!choice) {
        throw new RouterLLMProviderError(
          'OpenAI API returned empty choices array',
          'openai',
          responseStatus
        );
      }

      const content = choice.message?.content;
      if (!content) {
        throw new RouterLLMProviderError(
          'OpenAI API returned empty response',
          'openai',
          responseStatus
        );
      }

      const latencyMs = Date.now() - startTime;

      return {
        content,
        metadata: {
          model: data.model,
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          latencyMs,
          provider: 'openai',
          responseId: data.id,
          finishReason: choice.finish_reason,
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RouterLLMTimeoutError(
          `OpenAI request timed out after ${request.timeout}ms`,
          request.timeout
        );
      }

      // Re-throw RouterLLM errors
      if (
        error instanceof RouterLLMProviderError ||
        error instanceof RouterLLMTimeoutError
      ) {
        throw error;
      }

      // Wrap other errors
      throw new RouterLLMProviderError(
        `OpenAI invocation failed: ${error instanceof Error ? error.message : String(error)}`,
        'openai',
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }
}
