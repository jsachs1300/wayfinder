import { afterEach, describe, expect, it, vi } from 'vitest';
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
  providerHealthStore?: InMemoryRouterProviderHealthStore
): MultiProviderRouterLLM {
  const router = new MultiProviderRouterLLM(config, undefined, providerHealthStore);
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
    expect(geminiHealth?.circuitBreakerState).toBe('closed');
    expect(geminiHealth?.healthState).toBe('healthy');
  });
});
