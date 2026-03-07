/**
 * Tests for Router LLM Provider Clients
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const metricsMocks = vi.hoisted(() => ({
  recordLlmCompatibilityRetry: vi.fn(),
}));
vi.mock('../../src/observability/metrics', () => ({
  recordLlmCompatibilityRetry: metricsMocks.recordLlmCompatibilityRetry,
}));
import { OpenAIClient } from '../../src/routing/router-llm/providers/openai-client';
import { AnthropicClient } from '../../src/routing/router-llm/providers/anthropic-client';
import { GeminiClient } from '../../src/routing/router-llm/providers/gemini-client';
import { createProviderClient } from '../../src/routing/router-llm/providers/index';
import type { ProviderRequest } from '../../src/routing/router-llm/providers/types';
import {
  RouterLLMProviderError,
  RouterLLMTimeoutError,
  RouterLLMConfigError,
} from '../../src/routing/router-llm/errors';

describe('OpenAIClient', () => {
  let client: OpenAIClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new OpenAIClient('test-api-key');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should return provider name', () => {
    expect(client.getProviderName()).toBe('openai');
  });

  it('should successfully invoke OpenAI API', async () => {
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
            content: '{"intent":"test","primary":{"model":"gpt-4","score":8,"reason":"test"}}',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    const response = await client.invoke(request);

    expect(response.content).toContain('intent');
    expect(response.metadata.provider).toBe('openai');
    expect(response.metadata.model).toBe('gpt-4o-mini');
    expect(response.metadata.inputTokens).toBe(10);
    expect(response.metadata.outputTokens).toBe(20);
    expect(response.metadata.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should throw RouterLLMProviderError on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
        },
      }),
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMProviderError);
    await expect(client.invoke(request)).rejects.toThrow('Invalid API key');
  });

  it('should throw RouterLLMTimeoutError on timeout', async () => {
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100);
        })
    );

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 50,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMTimeoutError);
  });

  it('should throw RouterLLMProviderError on empty response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1677652288,
        model: 'gpt-4o-mini',
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 0,
          total_tokens: 10,
        },
      }),
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMProviderError);
    await expect(client.invoke(request)).rejects.toThrow('empty choices');
  });

  it('retries once with compatibility token parameter on OpenAI contract errors', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '{"intent":"test","ranked_models":[{"rank":1,"model":"gpt-4o","score":9,"reason":"test"}]}',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            type: 'invalid_request_error',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });
    global.fetch = fetchMock;

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gpt-4o',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    const response = await client.invoke(request);
    expect(response.metadata.provider).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(firstBody.max_tokens).toBe(500);
    expect(firstBody.max_completion_tokens).toBeUndefined();
    expect(secondBody.max_tokens).toBeUndefined();
    expect(secondBody.max_completion_tokens).toBe(500);
    expect(metricsMocks.recordLlmCompatibilityRetry).toHaveBeenCalledWith(
      'openai',
      'token_parameter',
      'gpt-4o'
    );
  });

  it('does not retry compatibility when ROUTER_COMPAT_RETRY_ENABLED=false', async () => {
    const previous = process.env.ROUTER_COMPAT_RETRY_ENABLED;
    process.env.ROUTER_COMPAT_RETRY_ENABLED = 'false';

    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            type: 'invalid_request_error',
          },
        }),
      });
      global.fetch = fetchMock;

      const request: ProviderRequest = {
        prompt: 'Test prompt',
        model: 'gpt-4o',
        temperature: 0.0,
        maxTokens: 500,
        timeout: 10000,
      };

      await expect(client.invoke(request)).rejects.toThrow('Unsupported parameter');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete process.env.ROUTER_COMPAT_RETRY_ENABLED;
      } else {
        process.env.ROUTER_COMPAT_RETRY_ENABLED = previous;
      }
    }
  });

  it('throws provider error when compatibility retry attempt also fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            type: 'invalid_request_error',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: 'Still invalid after compatibility retry',
            type: 'invalid_request_error',
          },
        }),
      });
    global.fetch = fetchMock;

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gpt-4o',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow('Still invalid after compatibility retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AnthropicClient', () => {
  let client: AnthropicClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new AnthropicClient('test-api-key');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    metricsMocks.recordLlmCompatibilityRetry.mockReset();
  });

  it('should return provider name', () => {
    expect(client.getProviderName()).toBe('anthropic');
  });

  it('should successfully invoke Anthropic API', async () => {
    const mockResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '{"intent":"test","primary":{"model":"claude-3-opus","score":9,"reason":"test"}}',
        },
      ],
      model: 'claude-3-opus-20240229',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 15,
        output_tokens: 25,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'claude-3-opus-20240229',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    const response = await client.invoke(request);

    expect(response.content).toContain('intent');
    expect(response.metadata.provider).toBe('anthropic');
    expect(response.metadata.model).toBe('claude-3-opus-20240229');
    expect(response.metadata.inputTokens).toBe(15);
    expect(response.metadata.outputTokens).toBe(25);
    expect(response.metadata.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should throw RouterLLMProviderError on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Invalid API key',
        },
      }),
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'claude-3-opus-20240229',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMProviderError);
    await expect(client.invoke(request)).rejects.toThrow('Invalid API key');
  });

  it('should throw RouterLLMTimeoutError on timeout', async () => {
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100);
        })
    );

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'claude-3-opus-20240229',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 50,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMTimeoutError);
  });

  it('should throw RouterLLMProviderError on empty response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 15,
          output_tokens: 0,
        },
      }),
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'claude-3-opus-20240229',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMProviderError);
    await expect(client.invoke(request)).rejects.toThrow('empty response');
  });
});

describe('GeminiClient', () => {
  let client: GeminiClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new GeminiClient('test-api-key');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should return provider name', () => {
    expect(client.getProviderName()).toBe('gemini');
  });

  it('should successfully invoke Gemini API', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                text: '{"intent":"test","ranked_models":[{"rank":1,"model":"gpt-4o","score":9,"reason":"test"}]}',
              },
            ],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
      modelVersion: 'gemini-1.5-flash',
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });
    global.fetch = fetchMock;

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gemini-1.5-flash',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    const response = await client.invoke(request);

    expect(response.content).toContain('ranked_models');
    expect(response.metadata.provider).toBe('gemini');
    expect(response.metadata.model).toBe('gemini-1.5-flash');
    expect(response.metadata.inputTokens).toBe(10);
    expect(response.metadata.outputTokens).toBe(20);
    expect(response.metadata.latencyMs).toBeGreaterThanOrEqual(0);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toMatchObject({
      type: 'object',
      properties: {
        intent: { type: 'string' },
        ranked_models: { type: 'array' },
      },
    });
  });

  it('should throw RouterLLMProviderError on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 400,
          message: 'Invalid response schema',
          status: 'INVALID_ARGUMENT',
        },
      }),
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gemini-1.5-flash',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMProviderError);
    await expect(client.invoke(request)).rejects.toThrow('Invalid response schema');
  });

  it('should throw RouterLLMTimeoutError on timeout', async () => {
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100);
        })
    );

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gemini-1.5-flash',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 50,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMTimeoutError);
  });

  it('should throw RouterLLMProviderError on empty response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          totalTokenCount: 10,
        },
        modelVersion: 'gemini-1.5-flash',
      }),
    });

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gemini-1.5-flash',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow(RouterLLMProviderError);
    await expect(client.invoke(request)).rejects.toThrow('no candidates');
  });

  it('retries once without responseSchema on Gemini schema compatibility errors', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                text: '{"intent":"test","ranked_models":[{"rank":1,"model":"gpt-4o","score":9,"reason":"test"}]}',
              },
            ],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
      modelVersion: 'gemini-1.5-flash',
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 400,
            message: 'Invalid JSON payload received. Unknown name "additionalProperties"',
            status: 'INVALID_ARGUMENT',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });
    global.fetch = fetchMock;

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gemini-1.5-flash',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    const response = await client.invoke(request);
    expect(response.metadata.provider).toBe('gemini');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(firstBody.generationConfig.responseMimeType).toBe('application/json');
    expect(firstBody.generationConfig.responseSchema).toBeDefined();
    expect(secondBody.generationConfig.responseSchema).toBeUndefined();
    expect(secondBody.generationConfig.responseMimeType).toBe('application/json');
    expect(metricsMocks.recordLlmCompatibilityRetry).toHaveBeenCalledWith(
      'gemini',
      'schema',
      'gemini-1.5-flash'
    );
  });

  it('does not retry schema compatibility when ROUTER_COMPAT_RETRY_ENABLED=false', async () => {
    const previous = process.env.ROUTER_COMPAT_RETRY_ENABLED;
    process.env.ROUTER_COMPAT_RETRY_ENABLED = 'false';

    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 400,
            message: 'Invalid JSON payload received. Unknown name "additionalProperties"',
            status: 'INVALID_ARGUMENT',
          },
        }),
      });
      global.fetch = fetchMock;

      const request: ProviderRequest = {
        prompt: 'Test prompt',
        model: 'gemini-1.5-flash',
        temperature: 0.0,
        maxTokens: 500,
        timeout: 10000,
      };

      await expect(client.invoke(request)).rejects.toThrow('Unknown name "additionalProperties"');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete process.env.ROUTER_COMPAT_RETRY_ENABLED;
      } else {
        process.env.ROUTER_COMPAT_RETRY_ENABLED = previous;
      }
    }
  });

  it('throws provider error when schema-compat retry also fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 400,
            message: 'Invalid JSON payload received. Unknown name "additionalProperties"',
            status: 'INVALID_ARGUMENT',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 400,
            message: 'Schema-less retry still failed',
            status: 'INVALID_ARGUMENT',
          },
        }),
      });
    global.fetch = fetchMock;

    const request: ProviderRequest = {
      prompt: 'Test prompt',
      model: 'gemini-1.5-flash',
      temperature: 0.0,
      maxTokens: 500,
      timeout: 10000,
    };

    await expect(client.invoke(request)).rejects.toThrow('Schema-less retry still failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createProviderClient', () => {
  it('should create OpenAI client', () => {
    const client = createProviderClient('openai', 'test-key');
    expect(client.getProviderName()).toBe('openai');
  });

  it('should create Anthropic client', () => {
    const client = createProviderClient('anthropic', 'test-key');
    expect(client.getProviderName()).toBe('anthropic');
  });

  it('should create Gemini client', () => {
    const client = createProviderClient('gemini', 'test-key');
    expect(client.getProviderName()).toBe('gemini');
  });

  it('should throw RouterLLMConfigError for unsupported provider', () => {
    expect(() => createProviderClient('invalid' as any, 'test-key')).toThrow(
      RouterLLMConfigError
    );
  });
});
