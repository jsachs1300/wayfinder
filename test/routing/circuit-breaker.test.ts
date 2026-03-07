import { describe, expect, it } from 'vitest';
import { ProviderCircuitBreaker } from '../../src/routing/router-llm/circuit-breaker';

describe('ProviderCircuitBreaker', () => {
  it('starts closed and allows requests', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 2,
      windowMs: 1000,
      openMs: 500,
    });

    const decision = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1000);

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe('closed');
    expect(breaker.getState('openai', 'gpt-4o-mini', 1000)).toBe('closed');
  });

  it('opens after threshold failures within the window', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 2,
      windowMs: 1000,
      openMs: 500,
    });

    breaker.recordFailure('openai', 'gpt-4o-mini', 1000);
    breaker.recordFailure('openai', 'gpt-4o-mini', 1200);

    expect(breaker.getState('openai', 'gpt-4o-mini', 1200)).toBe('open');
    const blocked = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe('open');
  });

  it('enters half-open after open window and allows only one probe', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 1,
      windowMs: 1000,
      openMs: 500,
    });

    breaker.recordFailure('gemini', 'gemini-2.5-flash', 1000);
    expect(breaker.getState('gemini', 'gemini-2.5-flash', 1200)).toBe('open');

    const firstProbe = breaker.shouldAllowRequest('gemini', 'gemini-2.5-flash', 1500);
    expect(firstProbe.allowed).toBe(true);
    expect(firstProbe.state).toBe('half_open');

    const secondProbe = breaker.shouldAllowRequest('gemini', 'gemini-2.5-flash', 1501);
    expect(secondProbe.allowed).toBe(false);
    expect(secondProbe.state).toBe('half_open');
  });

  it('closes after half-open success', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 1,
      windowMs: 1000,
      openMs: 500,
    });

    breaker.recordFailure('openai', 'gpt-4o-mini', 1000);
    breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1500); // half-open probe
    breaker.recordSuccess('openai', 'gpt-4o-mini', 1501);

    expect(breaker.getState('openai', 'gpt-4o-mini', 1501)).toBe('closed');
    const allowed = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1502);
    expect(allowed.allowed).toBe(true);
    expect(allowed.state).toBe('closed');
  });

  it('re-opens after half-open probe failure', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 1,
      windowMs: 1000,
      openMs: 500,
    });

    breaker.recordFailure('openai', 'gpt-4o-mini', 1000);
    breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1500); // half-open probe
    breaker.recordFailure('openai', 'gpt-4o-mini', 1501);

    expect(breaker.getState('openai', 'gpt-4o-mini', 1502)).toBe('open');
    const blocked = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1502);
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe('open');
  });

  it('prunes failures outside the sliding window', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 2,
      windowMs: 1000,
      openMs: 500,
    });

    breaker.recordFailure('gemini', 'gemini-2.5-flash', 1000);
    breaker.recordFailure('gemini', 'gemini-2.5-flash', 2501);

    expect(breaker.getState('gemini', 'gemini-2.5-flash', 2501)).toBe('closed');
    const allowed = breaker.shouldAllowRequest('gemini', 'gemini-2.5-flash', 2501);
    expect(allowed.allowed).toBe(true);
    expect(allowed.state).toBe('closed');
  });

  it('handles full cycle: closed -> open -> half_open fail -> open -> half_open success -> closed', () => {
    const breaker = new ProviderCircuitBreaker({
      errorThreshold: 1,
      windowMs: 1000,
      openMs: 500,
    });

    // closed -> open
    breaker.recordFailure('openai', 'gpt-4o-mini', 1000);
    expect(breaker.getState('openai', 'gpt-4o-mini', 1001)).toBe('open');

    // open -> half_open probe, then failed probe re-opens
    const probeOne = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 1500);
    expect(probeOne.allowed).toBe(true);
    expect(probeOne.state).toBe('half_open');
    breaker.recordFailure('openai', 'gpt-4o-mini', 1501);
    expect(breaker.getState('openai', 'gpt-4o-mini', 1502)).toBe('open');

    // open -> half_open probe, then success closes
    const probeTwo = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 2001);
    expect(probeTwo.allowed).toBe(true);
    expect(probeTwo.state).toBe('half_open');
    breaker.recordSuccess('openai', 'gpt-4o-mini', 2002);

    const finalDecision = breaker.shouldAllowRequest('openai', 'gpt-4o-mini', 2003);
    expect(finalDecision.allowed).toBe(true);
    expect(finalDecision.state).toBe('closed');
  });
});
