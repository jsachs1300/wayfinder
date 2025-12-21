/**
 * OpenAI Provider Client
 *
 * Implements the ProviderClient interface for OpenAI's Chat Completions API.
 * Uses native fetch API without external SDKs.
 */

import type { ProviderClient, ProviderRequest, ProviderResponse } from './types.js';
import {
  RouterLLMProviderError,
  RouterLLMTimeoutError,
} from '../errors.js';

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
  max_tokens: number;
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
  error: {
    message: string;
    type: string;
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

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeout);

    try {
      // Build OpenAI request
      const body: OpenAIRequest = {
        model: request.model,
        messages: [
          {
            role: 'user',
            content: request.prompt,
          },
        ],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        response_format: { type: 'json_object' },
      };

      // Make API request
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle error responses
      if (!response.ok) {
        const errorData = (await response.json()) as OpenAIErrorResponse;
        throw new RouterLLMProviderError(
          `OpenAI API error: ${errorData.error.message}`,
          'openai',
          response.status
        );
      }

      // Parse successful response
      const data = (await response.json()) as OpenAIResponse;

      // Extract content from first choice
      const choice = data.choices[0];
      if (!choice) {
        throw new RouterLLMProviderError(
          'OpenAI API returned empty choices array',
          'openai',
          response.status
        );
      }

      const content = choice.message?.content;
      if (!content) {
        throw new RouterLLMProviderError(
          'OpenAI API returned empty response',
          'openai',
          response.status
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
