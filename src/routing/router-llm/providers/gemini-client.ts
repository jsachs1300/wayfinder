/**
 * Gemini Provider Client
 *
 * Implements the ProviderClient interface for Google's Gemini API.
 * Uses native fetch API without external SDKs.
 */

import type { ProviderClient, ProviderRequest, ProviderResponse } from './types';
import { buildProviderInvocationPlan } from '../provider-adapter';
import {
  RouterLLMProviderError,
  RouterLLMTimeoutError,
} from '../errors';

/**
 * Gemini API request body structure
 */
interface GeminiRequest {
  contents: Array<{
    parts: Array<{
      text: string;
    }>;
  }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
  };
}

/**
 * Gemini API response structure
 */
interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
      role: string;
    };
    finishReason: string;
    index: number;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion: string;
}

const ROUTER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['intent', 'ranked_models'],
  properties: {
    intent: { type: 'string' },
    ranked_models: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rank', 'model', 'score', 'reason'],
        properties: {
          rank: { type: 'number' },
          model: { type: 'string' },
          score: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Gemini error response structure
 */
interface GeminiErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
}

export class GeminiClient implements ProviderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://generativelanguage.googleapis.com/v1beta') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  getProviderName(): string {
    return 'gemini';
  }

  private shouldRetryWithoutSchema(message: string, status: number): boolean {
    if (status !== 400) {
      return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('additionalproperties') ||
      lower.includes('response_schema') ||
      lower.includes('responseschema');
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();
    const debugEnabled = process.env.ROUTER_LLM_DEBUG === 'true';
    const compatRetryEnabled = process.env.ROUTER_COMPAT_RETRY_ENABLED !== 'false';
    const plan = buildProviderInvocationPlan('gemini', request);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeout);

    try {
      const url = `${this.baseUrl}/models/${request.model}:generateContent`;
      const canRetryWithoutSchema = compatRetryEnabled && plan.jsonSchemaMode === 'provider_schema';
      const schemaAttempts: [true] | [true, false] = canRetryWithoutSchema ? [true, false] : [true];
      let data: GeminiResponse | undefined;
      let lastProviderError: RouterLLMProviderError | undefined;

      for (let index = 0; index < schemaAttempts.length; index += 1) {
        const includeSchema = schemaAttempts[index];
        const body: GeminiRequest = {
          contents: [
            {
              parts: [
                {
                  text: request.prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxTokens,
            ...(plan.jsonResponseMode === 'native_json'
              ? { responseMimeType: 'application/json' }
              : {}),
            ...(plan.jsonSchemaMode === 'provider_schema' && includeSchema
              ? { responseSchema: ROUTER_RESPONSE_SCHEMA }
              : {}),
          },
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorData = (await response.json()) as GeminiErrorResponse;
          if (debugEnabled) {
            console.error('[gemini] Provider request failed', {
              status: response.status,
              model: request.model,
              generationConfig: body.generationConfig,
              error: {
                code: errorData.error?.code,
                status: errorData.error?.status,
                message: errorData.error?.message,
                details: errorData.error?.details,
              },
            });
          }
          const message = errorData.error?.message ?? `Gemini API status ${response.status}`;
          const retryableCompatibilityError =
            index === 0 &&
            canRetryWithoutSchema &&
            this.shouldRetryWithoutSchema(message, response.status);
          if (retryableCompatibilityError) {
            continue;
          }
          lastProviderError = new RouterLLMProviderError(
            `Gemini API error: ${message}`,
            'gemini',
            response.status,
            errorData.error?.code !== undefined ? new Error(String(errorData.error.code)) : undefined
          );
          break;
        }

        data = (await response.json()) as GeminiResponse;
        break;
      }

      clearTimeout(timeoutId);

      if (!data) {
        if (lastProviderError) {
          throw lastProviderError;
        }
        throw new RouterLLMProviderError(
          'Gemini client invariant violated: compatibility attempts completed without response or provider error',
          'gemini'
        );
      }

      // Extract response text
      if (!data.candidates || data.candidates.length === 0) {
        throw new RouterLLMProviderError(
          'Gemini API returned no candidates',
          'gemini'
        );
      }

      const candidate = data.candidates[0]!;
      if (!candidate.content?.parts || candidate.content.parts.length === 0) {
        throw new RouterLLMProviderError(
          'Gemini API candidate has no content parts',
          'gemini'
        );
      }

      const content = candidate.content.parts.map(part => part.text).join('');
      const latencyMs = Date.now() - startTime;

      return {
        content,
        metadata: {
          model: request.model,
          inputTokens: data.usageMetadata?.promptTokenCount,
          outputTokens: data.usageMetadata?.candidatesTokenCount,
          latencyMs,
          provider: 'gemini',
          finishReason: candidate.finishReason,
          modelVersion: data.modelVersion,
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RouterLLMTimeoutError(
          `Gemini request timed out after ${request.timeout}ms`,
          request.timeout
        );
      }

      // Re-throw provider errors as-is
      if (error instanceof RouterLLMProviderError || error instanceof RouterLLMTimeoutError) {
        throw error;
      }

      if (debugEnabled) {
        console.error('[gemini] Unexpected provider error', {
          model: request.model,
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxTokens,
            responseMimeType: 'application/json',
          },
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        });
      }

      // Wrap unexpected errors
      throw new RouterLLMProviderError(
        `Gemini provider error: ${error instanceof Error ? error.message : String(error)}`,
        'gemini'
      );
    }
  }
}
