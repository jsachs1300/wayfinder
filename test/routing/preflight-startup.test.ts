import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import { createApp } from '../../src/app';
import { RouterStartupPreflightError } from '../../src/routing';

function openAiSuccessResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'chatcmpl-preflight',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              intent: 'startup_preflight',
              ranked_models: [
                {
                  rank: 1,
                  model: 'gpt-4o-mini',
                  score: 10,
                  reason: 'preflight',
                },
              ],
            }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20,
      },
    }),
  };
}

function openAiFailureResponse() {
  return {
    ok: false,
    status: 500,
    json: async () => ({
      error: {
        message: 'provider unavailable',
      },
    }),
  };
}

describe('Router startup preflight policy', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.ROUTER_LLM_OPENAI_ENABLED = 'true';
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_ENABLED = 'false';
    process.env.LANGCACHE_ENABLED = 'false';
    process.env.FEATURE_USER_SELF_SERVICE = 'false';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('blocks startup in strict mode when all preflight probes fail', async () => {
    process.env.ROUTER_PREFLIGHT_MODE = 'strict';
    global.fetch = vi.fn().mockResolvedValue(openAiFailureResponse() as Response);

    await expect(createApp({ redis: new Redis() })).rejects.toBeInstanceOf(RouterStartupPreflightError);
  });

  it('allows startup in warn mode when preflight probes fail', async () => {
    process.env.ROUTER_PREFLIGHT_MODE = 'warn';
    global.fetch = vi.fn().mockResolvedValue(openAiFailureResponse() as Response);

    const result = await createApp({ redis: new Redis() });

    const preflightStatus = result.dependencies.routerProviderHealthStore?.get('openai', 'gpt-4o-mini')?.preflightStatus;
    expect(preflightStatus).toBe('fail');
  });

  it('skips startup probes when preflight mode is off', async () => {
    process.env.ROUTER_PREFLIGHT_MODE = 'off';
    global.fetch = vi.fn().mockResolvedValue(openAiSuccessResponse() as Response);

    await createApp({ redis: new Redis() });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('records pass preflight status on successful probe', async () => {
    process.env.ROUTER_PREFLIGHT_MODE = 'warn';
    global.fetch = vi.fn().mockResolvedValue(openAiSuccessResponse() as Response);

    const result = await createApp({ redis: new Redis() });

    const snapshot = result.dependencies.routerProviderHealthStore?.get('openai', 'gpt-4o-mini');
    expect(snapshot?.preflightStatus).toBe('pass');
    expect(snapshot?.healthState).toBe('healthy');
  });
});

