import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricsMocks = vi.hoisted(() => ({
  recordRouterPreflightOutcome: vi.fn(),
}));
vi.mock('../../src/observability/metrics', () => ({
  recordRouterPreflightOutcome: metricsMocks.recordRouterPreflightOutcome,
}));

import type { RouterLLMConfig, RouterLLMProvider } from '../../src/routing/config';
import { RouterStartupPreflight } from '../../src/routing/router-llm/preflight';
import { InMemoryRouterProviderHealthStore } from '../../src/routing/router-llm/provider-health';
import type { ProviderClient } from '../../src/routing/router-llm/providers/types';

const config: RouterLLMConfig = {
  openai: {
    enabled: true,
    apiKey: 'openai-key',
    model: 'gpt-4o-mini',
  },
  gemini: {
    enabled: true,
    apiKey: 'gemini-key',
    model: 'gemini-1.5-flash',
  },
  timeout: 10_000,
  maxRetries: 0,
  temperature: 0,
  maxTokens: 200,
  reliability: {
    preflightMode: 'warn',
    preflightTimeoutMs: 1_000,
    circuitBreakerWindowMs: 60_000,
    circuitBreakerErrorThreshold: 5,
    circuitBreakerOpenMs: 30_000,
    consensusMode: 'full',
  },
};

describe('RouterStartupPreflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records admin trigger on admin-initiated preflight runs', async () => {
    const store = new InMemoryRouterProviderHealthStore();

    const preflight = new RouterStartupPreflight(
      config,
      store,
      undefined,
      (): ProviderClient => ({
        getProviderName: () => 'openai',
        invoke: async () => ({
          content: JSON.stringify({
            intent: 'startup_preflight',
            ranked_models: [{ rank: 1, model: 'gpt-4o-mini', score: 10, reason: 'ok' }],
          }),
          metadata: {
            model: 'gpt-4o-mini',
            provider: 'openai',
            latencyMs: 1,
          },
        }),
      }),
      'admin'
    );

    await preflight.run();

    expect(metricsMocks.recordRouterPreflightOutcome).toHaveBeenCalledWith(
      'openai',
      'gpt-4o-mini',
      'pass',
      expect.any(Number),
      'admin'
    );
  });

  it('records preflight outcome metrics for pass and fail results', async () => {
    const store = new InMemoryRouterProviderHealthStore();

    const preflight = new RouterStartupPreflight(
      config,
      store,
      undefined,
      (provider: RouterLLMProvider): ProviderClient => ({
        getProviderName: () => provider,
        invoke: async () => {
          if (provider === 'gemini') {
            throw new Error('gemini unavailable');
          }
          return {
            content: JSON.stringify({
              intent: 'startup_preflight',
              ranked_models: [{ rank: 1, model: 'gpt-4o-mini', score: 10, reason: 'ok' }],
            }),
            metadata: {
              model: provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash',
              provider,
              latencyMs: 1,
            },
          };
        },
      })
    );

    const summary = await preflight.run();

    expect(summary.passCount).toBe(1);
    expect(summary.failCount).toBe(1);
    expect(metricsMocks.recordRouterPreflightOutcome).toHaveBeenCalledTimes(2);
    expect(metricsMocks.recordRouterPreflightOutcome).toHaveBeenCalledWith(
      'openai',
      'gpt-4o-mini',
      'pass',
      expect.any(Number),
      'startup'
    );
    expect(metricsMocks.recordRouterPreflightOutcome).toHaveBeenCalledWith(
      'gemini',
      'gemini-1.5-flash',
      'fail',
      expect.any(Number),
      'startup'
    );
  });
});
