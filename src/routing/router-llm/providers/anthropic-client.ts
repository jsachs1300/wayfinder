/**
 * Anthropic Provider Client
 *
 * Implements the ProviderClient interface for Anthropic's Messages API.
 * Uses native fetch API without external SDKs.
 */

import type { ProviderClient, ProviderRequest, ProviderResponse } from './types';
import {
  RouterLLMProviderError,
  RouterLLMTimeoutError,
} from '../errors';

/**
 * Anthropic API request body structure
 */
interface AnthropicRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  temperature: number;
  max_tokens: number;
  system?: string;
}

/**
 * Anthropic API response structure
 */
interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Anthropic error response structure
 */
interface AnthropicErrorResponse {
  type: string;
  error: {
    type: string;
    message: string;
  };
}

/**
 * System prompt for Anthropic to enforce JSON output
 */
const JSON_SYSTEM_PROMPT = `You must respond with valid JSON only. Do not include any text outside the JSON structure. The JSON should conform to the specified schema.`;

export class AnthropicClient implements ProviderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(
    apiKey: string,
    baseUrl = 'https://api.anthropic.com/v1',
    apiVersion = '2023-06-01'
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.apiVersion = apiVersion;
  }

  getProviderName(): string {
    return 'anthropic';
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeout);

    try {
      // Build Anthropic request
      const body: AnthropicRequest = {
        model: request.model,
        messages: [
          {
            role: 'user',
            content: request.prompt,
          },
        ],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        system: JSON_SYSTEM_PROMPT,
      };

      // Make API request
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle error responses
      if (!response.ok) {
        const errorData = (await response.json()) as AnthropicErrorResponse;
        throw new RouterLLMProviderError(
          `Anthropic API error: ${errorData.error.message}`,
          'anthropic',
          response.status
        );
      }

      // Parse successful response
      const data = (await response.json()) as AnthropicResponse;

      // Extract text from first content block
      const content = data.content[0]?.text;
      if (!content) {
        throw new RouterLLMProviderError(
          'Anthropic API returned empty response',
          'anthropic',
          response.status
        );
      }

      const latencyMs = Date.now() - startTime;

      return {
        content,
        metadata: {
          model: data.model,
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          latencyMs,
          provider: 'anthropic',
          responseId: data.id,
          stopReason: data.stop_reason,
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RouterLLMTimeoutError(
          `Anthropic request timed out after ${request.timeout}ms`,
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
        `Anthropic invocation failed: ${error instanceof Error ? error.message : String(error)}`,
        'anthropic',
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }
}
