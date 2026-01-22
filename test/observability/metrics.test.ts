import { recordRoutingRequest, recordCacheHit } from '../../src/observability/metrics';

describe('Observability Metrics', () => {
  it('records routing requests without errors', () => {
    expect(() => {
      recordRoutingRequest({ token_tier: 'free' });
    }).not.toThrow();
  });

  it('records cache hits with attributes without errors', () => {
    expect(() => {
      recordCacheHit({ router_model_used: 'openai' });
    }).not.toThrow();
  });
});
