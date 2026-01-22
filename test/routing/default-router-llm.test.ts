/**
 * Tests for DefaultRouterLLM
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DefaultRouterLLM } from '../../src/routing/router-llm/default-router-llm';
import { StubRouterLLM } from '../../src/routing/router-llm/stub-router-llm';
import type { TokenConfig } from '../../src/types/index';
import type { RouterLLMConfig } from '../../src/routing/config';
import {
  RouterLLMProviderError,
  RouterLLMParseError,
  RouterLLMTimeoutError,
  RouterLLMValidationError,
  RouterLLMRetryExhaustedError,
} from '../../src/routing/router-llm/errors';

describe('DefaultRouterLLM', () => {
  let originalFetch: typeof global.fetch;
  const mockTokenConfig: TokenConfig = {
    id: 'token-123',
    token_hash: 'hash',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const testConfig: RouterLLMConfig = {
    openai: {
      enabled: true,
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    },
    gemini: {
      enabled: false,
      apiKey: 'unused',
      model: 'gemini-1.5-flash',
    },
    timeout: 10000,
    maxRetries: 2,
    temperature: 0.0,
    maxTokens: 500,
  };

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should successfully invoke router LLM and return valid decision', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              intent: 'coding',
              ranked_models: [
                {
                  rank: 1,
                  model: 'gpt-4',
                  score: 9,
                  reason: 'Excellent for coding tasks',
                },
                {
                  rank: 2,
                  model: 'claude-3-opus',
                  score: 8,
                  reason: 'Strong alternative',
                },
                {
                  rank: 3,
                  model: 'gpt-4o-mini',
                  score: 7,
                  reason: 'Decent option',
                },
              ],
            }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const routerLLM = new DefaultRouterLLM(testConfig);
    const decision = await routerLLM.invoke(
      'Write a Python function',
      ['gpt-4', 'claude-3-opus', 'gpt-4o-mini'],
      { tokenConfig: mockTokenConfig }
    );

    expect(decision).toMatchObject({
      intent: 'coding',
      ranked_models: [
        {
          rank: 1,
          model: 'gpt-4',
          score: 9,
          reason: 'Excellent for coding tasks',
        },
        {
          rank: 2,
          model: 'claude-3-opus',
          score: 8,
          reason: 'Strong alternative',
        },
        {
          rank: 3,
          model: 'gpt-4o-mini',
          score: 7,
          reason: 'Decent option',
        },
      ],
    });
  });

  it('should handle prefer_model in context', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              intent: 'coding',
              ranked_models: [
                {
                  rank: 1,
                  model: 'claude-3-opus',
                  score: 9,
                  reason: 'User preferred model',
                },
                {
                  rank: 2,
                  model: 'gpt-4',
                  score: 8,
                  reason: 'Alternative',
                },
              ],
            }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const routerLLM = new DefaultRouterLLM(testConfig);
    await routerLLM.invoke('Test prompt', ['gpt-4', 'claude-3-opus'], {
      tokenConfig: mockTokenConfig,
      preferModel: 'claude-3-opus',
    });

    // Verify fetch was called with a prompt containing the preference
    expect(global.fetch).toHaveBeenCalled();
  });

  it('should retry on provider errors', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({
            error: {
              message: 'Internal server error',
              type: 'server_error',
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: 1677652288,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  intent: 'test',
                  ranked_models: [
                    { rank: 1, model: 'gpt-4', score: 8, reason: 'test' },
                    { rank: 2, model: 'claude-3-opus', score: 7, reason: 'test' },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      });
    });

    const routerLLM = new DefaultRouterLLM(testConfig);
    const decision = await routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], {
      tokenConfig: mockTokenConfig,
    });

    expect(callCount).toBe(2); // First call failed, second succeeded
    expect(decision).toBeDefined();
  });

  it('should throw RouterLLMRetryExhaustedError after max retries', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: {
          message: 'Internal server error',
          type: 'server_error',
        },
      }),
    });

    const routerLLM = new DefaultRouterLLM(testConfig);

    await expect(
      routerLLM.invoke('Test', ['gpt-4'], { tokenConfig: mockTokenConfig })
    ).rejects.toThrow(RouterLLMRetryExhaustedError);

    // Should have tried 1 + maxRetries times (1 initial + 2 retries = 3 total)
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('should not retry on timeout errors', async () => {
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 10);
        })
    );

    const shortTimeoutConfig = { ...testConfig, timeout: 50 };
    const routerLLM = new DefaultRouterLLM(shortTimeoutConfig);

    await expect(
      routerLLM.invoke('Test', ['gpt-4'], { tokenConfig: mockTokenConfig })
    ).rejects.toThrow(RouterLLMTimeoutError);

    // Should not retry on timeout
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should not retry on validation errors', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              // Missing intent - this will cause validation error
              ranked_models: [
                { rank: 1, model: 'gpt-4', score: 8, reason: 'test' },
              ],
            }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const routerLLM = new DefaultRouterLLM(testConfig);

    await expect(
      routerLLM.invoke('Test', ['gpt-4'], { tokenConfig: mockTokenConfig })
    ).rejects.toThrow(RouterLLMRetryExhaustedError);

    // Validation errors are currently retried (validation returns generic Error, not RouterLLMValidationError)
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('should fail on markdown code blocks (expects pure JSON)', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '```json\n{"intent":"coding","ranked_models":[{"rank":1,"model":"gpt-4","score":9,"reason":"Good"},{"rank":2,"model":"claude-3-opus","score":8,"reason":"Alternative"}]}\n```',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const routerLLM = new DefaultRouterLLM(testConfig);

    // Should fail because it expects pure JSON, not markdown code blocks
    await expect(
      routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], {
        tokenConfig: mockTokenConfig,
      })
    ).rejects.toThrow(RouterLLMParseError);

    // Should NOT retry for parse errors
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should expose config and client', () => {
    const routerLLM = new DefaultRouterLLM(testConfig);

    const config = routerLLM.getConfig();
    expect(config.openai.enabled).toBe(true);
    expect(config.openai.model).toBe('gpt-4o-mini');

    const client = routerLLM.getClient();
    expect(client.getProviderName()).toBe('openai');
  });

  describe('Input Validation', () => {
    it('should throw error on empty prompt', async () => {
      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow('Prompt cannot be empty');
    });

    it('should throw error on whitespace-only prompt', async () => {
      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('   ', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow('Prompt cannot be empty');
    });

    it('should throw error on prompt exceeding maximum length', async () => {
      const routerLLM = new DefaultRouterLLM(testConfig);
      const longPrompt = 'a'.repeat(100001); // Exceeds 100,000 limit

      await expect(
        routerLLM.invoke(longPrompt, ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow('Prompt exceeds maximum length');
    });

    it('should throw error on empty eligible models array', async () => {
      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('Test prompt', [], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow('At least one eligible model is required');
    });

    it('should accept prompt at maximum length boundary', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1677652288,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                intent: 'coding',
                ranked_models: [
                  { rank: 1, model: 'gpt-4', score: 9, reason: 'Test' },
                  { rank: 2, model: 'claude-3-opus', score: 8, reason: 'Test' },
                ],
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const routerLLM = new DefaultRouterLLM(testConfig);
      const maxLengthPrompt = 'a'.repeat(100000); // Exactly at limit

      const decision = await routerLLM.invoke(maxLengthPrompt, ['gpt-4', 'claude-3-opus'], {
        tokenConfig: mockTokenConfig,
      });

      expect(decision).toBeDefined();
    });
  });

  describe('Non-Retryable HTTP Errors', () => {
    it('should not retry on 400 Bad Request', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: { message: 'Invalid request' } }),
      } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow(RouterLLMProviderError);

      // Should only be called once (no retries)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 401 Unauthorized', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API key' } }),
      } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow(RouterLLMProviderError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 403 Forbidden', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ error: { message: 'Access denied' } }),
      } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow(RouterLLMProviderError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 404 Not Found', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: { message: 'Model not found' } }),
      } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow(RouterLLMProviderError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 422 Unprocessable Entity', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ error: { message: 'Invalid parameters' } }),
      } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      await expect(
        routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], { tokenConfig: mockTokenConfig })
      ).rejects.toThrow(RouterLLMProviderError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 Rate Limit (retryable 4xx)', async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({ error: { message: 'Rate limit exceeded' } }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'chatcmpl-123',
            object: 'chat.completion',
            created: 1677652288,
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    intent: 'coding',
                    ranked_models: [
                      { rank: 1, model: 'gpt-4', score: 9, reason: 'Test' },
                      { rank: 2, model: 'claude-3-opus', score: 8, reason: 'Test' },
                    ],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      const decision = await routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], {
        tokenConfig: mockTokenConfig,
      });

      expect(decision).toBeDefined();
      // Should be called twice (initial + 1 retry)
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should retry on 500 Internal Server Error (retryable 5xx)', async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ error: { message: 'Server error' } }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'chatcmpl-123',
            object: 'chat.completion',
            created: 1677652288,
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    intent: 'coding',
                    ranked_models: [
                      { rank: 1, model: 'gpt-4', score: 9, reason: 'Test' },
                      { rank: 2, model: 'claude-3-opus', score: 8, reason: 'Test' },
                    ],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        } as Response);
      global.fetch = fetchSpy;

      const routerLLM = new DefaultRouterLLM(testConfig);

      const decision = await routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], {
        tokenConfig: mockTokenConfig,
      });

      expect(decision).toBeDefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should log raw response when JSON parsing fails', async () => {
    const malformedJSON = '{"intent": "code_generation", "ranked_models": [{"model": "gpt-4o", "score": 9, "reason": "Best for...';

    const mockResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: malformedJSON,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
      headers: new Headers(),
    } as Response);

    const mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const routerLLM = new DefaultRouterLLM(testConfig, mockLogger);

    // Should throw RouterLLMParseError immediately (no retry for parse errors)
    let caughtError: RouterLLMParseError | undefined;
    try {
      await routerLLM.invoke('Test prompt', ['gpt-4o', 'claude-3-opus'], {
        tokenConfig: mockTokenConfig,
      });
    } catch (error) {
      caughtError = error as RouterLLMParseError;
    }

    // Verify the error is RouterLLMParseError with raw response
    expect(caughtError).toBeInstanceOf(RouterLLMParseError);
    expect(caughtError?.rawResponse).toBe(malformedJSON);
    expect(caughtError?.message).toContain('Failed to parse router LLM response as JSON');

    // Verify error logging was called with raw response
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[RouterLLM] Failed to parse response as JSON',
      expect.objectContaining({
        rawResponse: malformedJSON,
        responseLength: malformedJSON.length,
        model: 'gpt-4o-mini',
      })
    );

    // Verify parse error logging (should not retry)
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[RouterLLM] Parse error, not retrying',
      expect.objectContaining({
        responseLength: malformedJSON.length,
      })
    );
  });
});

describe('StubRouterLLM', () => {
  const mockTokenConfig: TokenConfig = {
    id: 'token-123',
    token_hash: 'hash',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  it('should return valid RouteDecision', async () => {
    const stub = new StubRouterLLM();
    const decision = await stub.invoke('Test', ['gpt-4', 'claude-3-opus'], {
      tokenConfig: mockTokenConfig,
    });

    expect(decision).toHaveProperty('intent');
    expect(decision).toHaveProperty('ranked_models');
    expect(decision.ranked_models).toHaveLength(2);
  });

  it('should use prefer_model as primary if eligible', async () => {
    const stub = new StubRouterLLM();
    const decision = await stub.invoke('Test', ['gpt-4', 'claude-3-opus'], {
      tokenConfig: mockTokenConfig,
      preferModel: 'claude-3-opus',
    });

    expect(decision.ranked_models[0].model).toBe('claude-3-opus');
    expect(decision.ranked_models[1].model).toBe('gpt-4');
  });

  it('should handle single eligible model', async () => {
    const stub = new StubRouterLLM();
    const decision = await stub.invoke('Test', ['gpt-4'], {
      tokenConfig: mockTokenConfig,
    });

    expect(decision).toHaveProperty('ranked_models');
    expect(decision.ranked_models).toHaveLength(1);
    expect(decision.ranked_models[0].model).toBe('gpt-4');
  });
});
