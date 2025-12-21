/**
 * Tests for DefaultRouterLLM
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DefaultRouterLLM } from '../../src/routing/router-llm/default-router-llm.js';
import { StubRouterLLM } from '../../src/routing/router-llm/stub-router-llm.js';
import type { TokenConfig } from '../../src/types/index.js';
import type { RouterLLMConfig } from '../../src/routing/config.js';
import {
  RouterLLMProviderError,
  RouterLLMTimeoutError,
  RouterLLMValidationError,
  RouterLLMRetryExhaustedError,
} from '../../src/routing/router-llm/errors.js';

describe('DefaultRouterLLM', () => {
  let originalFetch: typeof global.fetch;
  const mockTokenConfig: TokenConfig = {
    id: 'token-123',
    token_hash: 'hash',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const testConfig: RouterLLMConfig = {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
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
              primary: {
                model: 'gpt-4',
                score: 9,
                reason: 'Excellent for coding tasks',
              },
              alternate: {
                model: 'claude-3-opus',
                score: 8,
                reason: 'Strong alternative',
              },
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
      primary: {
        model: 'gpt-4',
        score: 9,
        reason: 'Excellent for coding tasks',
      },
      alternate: {
        model: 'claude-3-opus',
        score: 8,
        reason: 'Strong alternative',
      },
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
              primary: {
                model: 'claude-3-opus',
                score: 9,
                reason: 'User preferred model',
              },
              alternate: {
                model: 'gpt-4',
                score: 8,
                reason: 'Alternative',
              },
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
                  primary: { model: 'gpt-4', score: 8, reason: 'test' },
                  alternate: { model: 'claude-3-opus', score: 7, reason: 'test' },
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
              // Missing intent
              primary: { model: 'gpt-4', score: 8, reason: 'test' },
              alternate: { model: 'claude', score: 7, reason: 'test' },
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
    ).rejects.toThrow(RouterLLMValidationError);

    // Should not retry on validation error
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should parse JSON from markdown code blocks', async () => {
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
            content: '```json\n{"intent":"coding","primary":{"model":"gpt-4","score":9,"reason":"Good"},"alternate":{"model":"claude-3-opus","score":8,"reason":"Alternative"}}\n```',
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
    const decision = await routerLLM.invoke('Test', ['gpt-4', 'claude-3-opus'], {
      tokenConfig: mockTokenConfig,
    });

    expect(decision).toMatchObject({
      intent: 'coding',
      primary: { model: 'gpt-4' },
      alternate: { model: 'claude-3-opus' },
    });
  });

  it('should expose config and client', () => {
    const routerLLM = new DefaultRouterLLM(testConfig);

    const config = routerLLM.getConfig();
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4o-mini');

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
                primary: { model: 'gpt-4', score: 9, reason: 'Test' },
                alternate: { model: 'claude-3-opus', score: 8, reason: 'Test' },
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
                    primary: { model: 'gpt-4', score: 9, reason: 'Test' },
                    alternate: { model: 'claude-3-opus', score: 8, reason: 'Test' },
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
                    primary: { model: 'gpt-4', score: 9, reason: 'Test' },
                    alternate: { model: 'claude-3-opus', score: 8, reason: 'Test' },
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
    expect(decision).toHaveProperty('primary');
    expect(decision).toHaveProperty('alternate');
  });

  it('should use prefer_model as primary if eligible', async () => {
    const stub = new StubRouterLLM();
    const decision = await stub.invoke('Test', ['gpt-4', 'claude-3-opus'], {
      tokenConfig: mockTokenConfig,
      preferModel: 'claude-3-opus',
    });

    expect((decision as any).primary.model).toBe('claude-3-opus');
    expect((decision as any).alternate.model).toBe('gpt-4');
  });

  it('should handle single eligible model', async () => {
    const stub = new StubRouterLLM();
    const decision = await stub.invoke('Test', ['gpt-4'], {
      tokenConfig: mockTokenConfig,
    });

    expect(decision).toHaveProperty('primary');
    expect(decision).toHaveProperty('alternate');
  });
});
