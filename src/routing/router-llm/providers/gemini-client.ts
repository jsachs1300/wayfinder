/**
 * Gemini Provider Client
 *
 * Implements the ProviderClient interface for Google's Gemini API.
 * Uses native fetch API without external SDKs.
 */

import type { ProviderClient, ProviderRequest, ProviderResponse } from './types';
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

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeout);

    try {
      // Build Gemini request
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
          responseMimeType: 'application/json', // Request JSON response
        },
      };

      // Make API request
      // Use header-based authentication (x-goog-api-key) instead of query parameter
      // to avoid exposing API key in URLs, server logs, and browser history
      const url = `${this.baseUrl}/models/${request.model}:generateContent`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle error responses
      if (!response.ok) {
        const errorData = (await response.json()) as GeminiErrorResponse;
        throw new RouterLLMProviderError(
          `Gemini API error: ${errorData.error.message}`,
          'gemini',
          response.status,
          errorData.error.code !== undefined ? new Error(String(errorData.error.code)) : undefined
        );
      }

      // Parse successful response
      const data = (await response.json()) as GeminiResponse;

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

      // Wrap unexpected errors
      throw new RouterLLMProviderError(
        `Gemini provider error: ${error instanceof Error ? error.message : String(error)}`,
        'gemini'
      );
    }
  }
}
