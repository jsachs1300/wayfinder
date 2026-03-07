import { afterEach, describe, expect, it, vi } from 'vitest';
const metricsMocks = vi.hoisted(() => ({
  recordLlmCall: vi.fn(),
  recordLlmError: vi.fn(),
  recordLlmCircuitBreakerBlock: vi.fn(),
  recordLlmCircuitBreakerTransition: vi.fn(),
}));
vi.mock('../../src/observability/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/observability/metrics')>();
  return {
    ...actual,
    recordLlmCall: metricsMocks.recordLlmCall,
    recordLlmError: metricsMocks.recordLlmError,
    recordLlmCircuitBreakerBlock: metricsMocks.recordLlmCircuitBreakerBlock,
    recordLlmCircuitBreakerTransition: metricsMocks.recordLlmCircuitBreakerTransition,
  };
});
import type { RouterLLMConfig } from '../../src/routing/config';
import { MultiProviderRouterLLM } from '../../src/routing/router-llm/multi-provider-router-llm';
import type { ProviderClient } from '../../src/routing/router-llm/providers/types';
import type { TokenConfig } from '../../src/types';
import { InMemoryRouterProviderHealthStore } from '../../src/routing/router-llm/provider-health';

const tokenConfig: TokenConfig = {
  id: 'token-1',
  token_hash: 'hash-1',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const baseConfig: RouterLLMConfig = {
  openai: {
    enabled: true,
    apiKey: 'openai-test-key',
    model: 'gpt-4o-mini',
  },
  gemini: {
    enabled: true,
    apiKey: 'gemini-test-key',
    model: 'gemini-2.5-flash',
  },
  timeout: 5000,
  maxRetries: 0,
  temperature: 0,
  maxTokens: 400,
  reliability: {
    preflightMode: 'warn',
    preflightTimeoutMs: 1000,
    circuitBreakerWindowMs: 60_000,
    circuitBreakerErrorThreshold: 1,
    circuitBreakerOpenMs: 50,
    consensusMode: 'full',
  },
};

function providerResponse(model: string, provider: string): ReturnType<ProviderClient['invoke']> {
  return Promise.resolve({
    content: JSON.stringify({
      intent: 'test intent',
      ranked_models: [
        { rank: 1, model: 'gpt-4o-mini', score: 9, reason: 'good fit' },
        { rank: 2, model: 'gemini-2.5-flash', score: 8, reason: 'fallback fit' },
      ],
    }),
    metadata: {
      model,
      provider,
      latencyMs: 12,
      inputTokens: 10,
      outputTokens: 20,
    },
  });
}

function createRouterWithClients(
  openaiClient: ProviderClient,
  geminiClient: ProviderClient,
  config: RouterLLMConfig = baseConfig,
  providerHealthStore?: InMemoryRouterProviderHealthStore,
  logger?: Console
): MultiProviderRouterLLM {
  const router = new MultiProviderRouterLLM(config, logger, providerHealthStore);
  const mutableRouter = router as unknown as {
    openaiClient: ProviderClient;
    geminiClient: ProviderClient;
  };
  mutableRouter.openaiClient = openaiClient;
  mutableRouter.geminiClient = geminiClient;
  return router;
}

describe('MultiProviderRouterLLM circuit breaker integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    metricsMocks.recordLlmCall.mockReset();
    metricsMocks.recordLlmError.mockReset();
    metricsMocks.recordLlmCircuitBreakerBlock.mockReset();
    metricsMocks.recordLlmCircuitBreakerTransition.mockReset();
  });

  it('opens the breaker on provider failure and falls back to remaining provider', async () => {
    const openaiInvoke = vi.fn()
      .mockRejectedValueOnce(new Error('openai unavailable'))
      .mockResolvedValue(providerResponse('gpt-4o-mini', 'openai'));
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' }
    );

    const first = await router.invoke('route this prompt', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig }) as {
      provider_rankings: Record<string, unknown>;
    };
    expect(first.provider_rankings.gemini).toBeDefined();
    expect(openaiInvoke).toHaveBeenCalledTimes(1);
    expect(geminiInvoke).toHaveBeenCalledTimes(1);

    const second = await router.invoke('route this prompt again', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig }) as {
      provider_rankings: Record<string, unknown>;
    };
    expect(second.provider_rankings.gemini).toBeDefined();
    expect(openaiInvoke).toHaveBeenCalledTimes(1);
    expect(geminiInvoke).toHaveBeenCalledTimes(2);
    expect(metricsMocks.recordLlmCircuitBreakerTransition).toHaveBeenCalledWith(
      'openai',
      'closed',
      'open',
      {}
    );
  });

  it('returns first successful provider in fast consensus mode', async () => {
    vi.useFakeTimers();
    const fastConfig: RouterLLMConfig = {
      ...baseConfig,
      reliability: {
        ...baseConfig.reliability,
        consensusMode: 'fast',
      },
    };

    const openaiInvoke = vi.fn().mockResolvedValue(providerResponse('gpt-4o-mini', 'openai'));
    const geminiInvoke = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            void providerResponse('gemini-2.5-flash', 'gemini').then(resolve);
          }, 1000);
        })
    );

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' },
      fastConfig
    );

    const result = await router.invoke('fast route', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig }) as {
      provider_rankings: Record<string, unknown>;
      consensus: { ranked_models: Array<{ model: string }> };
    };

    expect(result.provider_rankings.openai).toBeDefined();
    expect(result.provider_rankings.gemini).toBeUndefined();
    expect(result.consensus.ranked_models[0]?.model).toBe('gpt-4o-mini');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('still succeeds in fast consensus mode when one provider fails', async () => {
    const fastConfig: RouterLLMConfig = {
      ...baseConfig,
      reliability: {
        ...baseConfig.reliability,
        consensusMode: 'fast',
      },
    };
    const openaiInvoke = vi.fn().mockRejectedValue(new Error('openai unavailable'));
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' },
      fastConfig
    );

    const result = await router.invoke('fast route fallback', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig }) as {
      provider_rankings: Record<string, unknown>;
    };

    expect(result.provider_rankings.gemini).toBeDefined();
    expect(metricsMocks.recordLlmCircuitBreakerTransition).toHaveBeenCalledWith(
      'openai',
      'closed',
      'open',
      {}
    );
  });

  it('preserves explicit provider routing semantics in fast mode', async () => {
    const fastConfig: RouterLLMConfig = {
      ...baseConfig,
      reliability: {
        ...baseConfig.reliability,
        consensusMode: 'fast',
      },
    };
    const openaiInvoke = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            void providerResponse('gpt-4o-mini', 'openai').then(resolve);
          }, 20);
        })
    );
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' },
      fastConfig
    );

    const result = await router.invoke('explicit provider request', ['gpt-4o-mini', 'gemini-2.5-flash'], {
      tokenConfig,
      requestMetadata: {
        router_model_requested: 'openai',
      },
    }) as {
      provider_rankings: Record<string, unknown>;
    };

    expect(result.provider_rankings.openai).toBeDefined();
    expect(result.provider_rankings.gemini).toBeUndefined();
  });

  it('falls back to another provider when explicitly requested provider fails in fast mode', async () => {
    const fastConfig: RouterLLMConfig = {
      ...baseConfig,
      reliability: {
        ...baseConfig.reliability,
        consensusMode: 'fast',
      },
    };
    const openaiInvoke = vi.fn().mockRejectedValue(new Error('openai failed'));
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' },
      fastConfig
    );

    const result = await router.invoke('explicit provider fallback', ['gpt-4o-mini', 'gemini-2.5-flash'], {
      tokenConfig,
      requestMetadata: {
        router_model_requested: 'openai',
      },
    }) as {
      provider_rankings: Record<string, unknown>;
    };

    expect(result.provider_rankings.gemini).toBeDefined();
    expect(result.provider_rankings.openai).toBeUndefined();
  });

  it('logs background provider failures after fast response is returned', async () => {
    const fastConfig: RouterLLMConfig = {
      ...baseConfig,
      reliability: {
        ...baseConfig.reliability,
        consensusMode: 'fast',
      },
    };
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    } as unknown as Console;

    const openaiInvoke = vi.fn().mockResolvedValue(providerResponse('gpt-4o-mini', 'openai'));
    const geminiInvoke = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('gemini timed out')), 5);
        })
    );

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' },
      fastConfig,
      undefined,
      logger
    );

    await router.invoke('fast background failure', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(logger.warn).toHaveBeenCalledWith(
      '[MultiProviderRouterLLM] Fast consensus background provider failures',
      expect.objectContaining({
        failed: expect.arrayContaining([
          expect.objectContaining({ name: 'gemini' }),
        ]),
      })
    );
  });

  it('falls back to single-provider standard flow when fast mode has one invocable provider', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    } as unknown as Console;
    const fastConfig: RouterLLMConfig = {
      ...baseConfig,
      gemini: {
        ...baseConfig.gemini,
        enabled: false,
      },
      reliability: {
        ...baseConfig.reliability,
        consensusMode: 'fast',
      },
    };
    const openaiInvoke = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        intent: 'test intent',
        ranked_models: [
          { rank: 1, model: 'gpt-4o-mini', score: 9, reason: 'good fit' },
        ],
      }),
      metadata: {
        model: 'gpt-4o-mini',
        provider: 'openai',
        latencyMs: 12,
        inputTokens: 10,
        outputTokens: 20,
      },
    });

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: vi.fn(), getProviderName: () => 'gemini' },
      fastConfig,
      undefined,
      logger
    );

    const result = await router.invoke('single provider fast', ['gpt-4o-mini'], { tokenConfig }) as {
      provider_rankings: Record<string, unknown>;
    };

    expect(result.provider_rankings.openai).toBeDefined();
    expect(logger.log).toHaveBeenCalledWith(
      '[MultiProviderRouterLLM] Fast consensus fallback to standard flow (single invocable provider)',
      expect.objectContaining({ invocable_count: 1 })
    );
  });

  it('allows a half-open probe after open timeout and closes on success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const openaiInvoke = vi.fn()
      .mockRejectedValueOnce(new Error('openai unavailable'))
      .mockResolvedValue(providerResponse('gpt-4o-mini', 'openai'));
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' }
    );

    await router.invoke('first', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });
    await router.invoke('second', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });
    expect(openaiInvoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(51);

    const third = await router.invoke('third', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig }) as {
      provider_rankings: Record<string, unknown>;
    };
    expect(third.provider_rankings.openai).toBeDefined();
    expect(openaiInvoke).toHaveBeenCalledTimes(2);

    await router.invoke('fourth', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });
    expect(openaiInvoke).toHaveBeenCalledTimes(3);
  });

  it('fails fast when every provider is open', async () => {
    const alwaysFailOpenAI = vi.fn().mockRejectedValue(new Error('openai down'));
    const alwaysFailGemini = vi.fn().mockRejectedValue(new Error('gemini down'));

    const router = createRouterWithClients(
      { invoke: alwaysFailOpenAI, getProviderName: () => 'openai' },
      { invoke: alwaysFailGemini, getProviderName: () => 'gemini' }
    );

    await expect(
      router.invoke('first', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig })
    ).rejects.toThrow('All router LLM providers failed');
    expect(alwaysFailOpenAI).toHaveBeenCalledTimes(1);
    expect(alwaysFailGemini).toHaveBeenCalledTimes(1);

    await expect(
      router.invoke('second', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig })
    ).rejects.toThrow('blocked by circuit breaker');
    expect(alwaysFailOpenAI).toHaveBeenCalledTimes(1);
    expect(alwaysFailGemini).toHaveBeenCalledTimes(1);
  });

  it('fails fast for single-provider configuration after breaker opens', async () => {
    const config: RouterLLMConfig = {
      ...baseConfig,
      gemini: {
        ...baseConfig.gemini,
        enabled: false,
      },
      reliability: {
        ...baseConfig.reliability,
        circuitBreakerErrorThreshold: 1,
      },
    };
    const alwaysFailOpenAI = vi.fn().mockRejectedValue(new Error('openai down'));

    const router = createRouterWithClients(
      { invoke: alwaysFailOpenAI, getProviderName: () => 'openai' },
      { invoke: vi.fn(), getProviderName: () => 'gemini' },
      config
    );

    await expect(
      router.invoke('first', ['gpt-4o-mini'], { tokenConfig })
    ).rejects.toThrow('All router LLM providers failed');
    expect(alwaysFailOpenAI).toHaveBeenCalledTimes(1);

    await expect(
      router.invoke('second', ['gpt-4o-mini'], { tokenConfig })
    ).rejects.toThrow('blocked by circuit breaker');
    expect(alwaysFailOpenAI).toHaveBeenCalledTimes(1);
  });

  it('writes circuit-breaker state updates into provider health store', async () => {
    const healthStore = new InMemoryRouterProviderHealthStore();
    const alwaysFailOpenAI = vi.fn().mockRejectedValue(new Error('openai down'));
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: alwaysFailOpenAI, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' },
      baseConfig,
      healthStore
    );

    await router.invoke('first', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });

    const openaiHealth = healthStore.get('openai', 'gpt-4o-mini');
    const geminiHealth = healthStore.get('gemini', 'gemini-2.5-flash');
    expect(openaiHealth?.circuitBreakerState).toBe('open');
    expect(openaiHealth?.healthState).toBe('unhealthy');
    expect(openaiHealth?.lastError).toContain('openai down');
    expect(geminiHealth?.circuitBreakerState).toBe('closed');
    expect(geminiHealth?.healthState).toBe('healthy');
    const originalLastError = openaiHealth?.lastError;

    // On blocked follow-up requests, keep the original root-cause error message.
    await router.invoke('second', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });
    const openaiBlockedHealth = healthStore.get('openai', 'gpt-4o-mini');
    expect(openaiBlockedHealth?.circuitBreakerState).toBe('open');
    expect(openaiBlockedHealth?.lastError).toBe(originalLastError);
  });

  it('does not emit transition metric when breaker state remains unchanged', async () => {
    const openaiInvoke = vi.fn().mockResolvedValue(providerResponse('gpt-4o-mini', 'openai'));
    const geminiInvoke = vi.fn().mockResolvedValue(providerResponse('gemini-2.5-flash', 'gemini'));

    const router = createRouterWithClients(
      { invoke: openaiInvoke, getProviderName: () => 'openai' },
      { invoke: geminiInvoke, getProviderName: () => 'gemini' }
    );

    await router.invoke('stable state', ['gpt-4o-mini', 'gemini-2.5-flash'], { tokenConfig });

    expect(metricsMocks.recordLlmCircuitBreakerTransition).not.toHaveBeenCalled();
  });
});
