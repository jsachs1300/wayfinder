import { describe, expect, it } from 'vitest';
import {
  getProviderCapabilityProfile,
  buildProviderInvocationPlan,
  InMemoryRouterProviderHealthStore,
} from '../../src/routing/router-llm';

describe('Router capability scaffolding', () => {
  it('selects max_completion_tokens for gpt-5/openai o-series models', () => {
    expect(getProviderCapabilityProfile('openai', 'gpt-5-mini').openaiTokenParameter)
      .toBe('max_completion_tokens');
    expect(getProviderCapabilityProfile('openai', 'o1').openaiTokenParameter)
      .toBe('max_completion_tokens');
  });

  it('selects max_tokens for non-gpt-5 openai models', () => {
    expect(getProviderCapabilityProfile('openai', 'gpt-4o').openaiTokenParameter)
      .toBe('max_tokens');
  });

  it('builds provider invocation plan from normalized request', () => {
    const plan = buildProviderInvocationPlan('gemini', {
      prompt: 'route this',
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxTokens: 500,
      timeout: 30000,
    });

    expect(plan.provider).toBe('gemini');
    expect(plan.model).toBe('gemini-2.5-flash');
    expect(plan.jsonResponseMode).toBe('native_json');
    expect(plan.jsonSchemaMode).toBe('provider_schema');
  });
});

describe('InMemoryRouterProviderHealthStore', () => {
  it('stores and retrieves health snapshots by provider/model', () => {
    const store = new InMemoryRouterProviderHealthStore();
    store.set({
      provider: 'openai',
      model: 'gpt-4o',
      health_state: 'healthy',
      circuit_breaker_state: 'closed',
      preflight_status: 'pass',
      consecutive_failures: 0,
      updated_at: '2026-03-04T00:00:00.000Z',
    });

    const found = store.get('openai', 'gpt-4o');
    expect(found?.health_state).toBe('healthy');
    expect(found?.circuit_breaker_state).toBe('closed');
  });

  it('lists snapshots in deterministic provider/model order', () => {
    const store = new InMemoryRouterProviderHealthStore();
    store.set({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      health_state: 'degraded',
      circuit_breaker_state: 'half_open',
      preflight_status: 'fail',
      consecutive_failures: 3,
      updated_at: '2026-03-04T00:00:00.000Z',
    });
    store.set({
      provider: 'openai',
      model: 'gpt-4o',
      health_state: 'healthy',
      circuit_breaker_state: 'closed',
      preflight_status: 'pass',
      consecutive_failures: 0,
      updated_at: '2026-03-04T00:00:00.000Z',
    });

    const list = store.list();
    expect(list.map((s) => `${s.provider}:${s.model}`)).toEqual([
      'gemini:gemini-2.5-flash',
      'openai:gpt-4o',
    ].sort());
  });
});

