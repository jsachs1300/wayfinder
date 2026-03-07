import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('wayfinder');

const routingRequests = meter.createCounter('routing.requests_total', {
  description: 'Total routing requests accepted by the service',
});

const routingCacheHits = meter.createCounter('routing.cache_hits_total', {
  description: 'Total routing cache hits',
});

const routingCacheMisses = meter.createCounter('routing.cache_misses_total', {
  description: 'Total routing cache misses',
});

const routingLlmCalls = meter.createCounter('routing.llm_calls_total', {
  description: 'Total router LLM calls',
});

const routingLlmErrors = meter.createCounter('routing.llm_errors_total', {
  description: 'Total router LLM errors',
});

const routingLlmCircuitBreakerBlocks = meter.createCounter('routing.llm_circuit_breaker_blocks_total', {
  description: 'Total router LLM provider calls blocked by circuit breaker',
});

const routingLlmCircuitBreakerTransitions = meter.createCounter('routing.llm_circuit_breaker_transitions_total', {
  description: 'Total router LLM circuit breaker state transitions',
});

const routingLlmCompatibilityRetries = meter.createCounter('routing.llm_compatibility_retries_total', {
  description: 'Total router LLM compatibility retries',
});

const routingPreflightOutcomes = meter.createCounter('routing.preflight_outcomes_total', {
  description: 'Total router startup/admin preflight outcomes',
});

const routingPreflightLatency = meter.createHistogram('routing.preflight_latency_ms', {
  description: 'Router preflight latency in milliseconds',
  unit: 'ms',
});

const routingLlmLatency = meter.createHistogram('routing.llm_latency_ms', {
  description: 'Router LLM latency in milliseconds',
  unit: 'ms',
});

const routingFallbacks = meter.createCounter('routing.fallbacks_total', {
  description: 'Total router model fallbacks',
});

const routingErrors = meter.createCounter('routing.errors_total', {
  description: 'Total routing errors',
});

const usersRegistered = meter.createCounter('users.registered_total', {
  description: 'Total registered users',
});

const usersLoggedIn = meter.createCounter('users.logged_in_total', {
  description: 'Total user logins',
});

const tokensCreated = meter.createCounter('tokens.created_total', {
  description: 'Total tokens created',
});

const tokensDeleted = meter.createCounter('tokens.deleted_total', {
  description: 'Total tokens deleted',
});

const tokensRotated = meter.createCounter('tokens.rotated_total', {
  description: 'Total tokens rotated',
});

export type RoutingMetricAttributes = {
  token_tier?: string;
  router_model_requested?: string;
  router_model_used?: string;
  provider?: string;
};

export function recordRoutingRequest(attributes: RoutingMetricAttributes): void {
  routingRequests.add(1, attributes);
}

export function recordCacheHit(attributes: RoutingMetricAttributes): void {
  routingCacheHits.add(1, attributes);
}

export function recordCacheMiss(attributes: RoutingMetricAttributes): void {
  routingCacheMisses.add(1, attributes);
}

export function recordLlmCall(
  provider: string,
  latencyMs: number | undefined,
  attributes: RoutingMetricAttributes
): void {
  routingLlmCalls.add(1, { ...attributes, provider });
  if (typeof latencyMs === 'number') {
    routingLlmLatency.record(latencyMs, { ...attributes, provider });
  }
}

export function recordLlmError(provider: string, attributes: RoutingMetricAttributes): void {
  routingLlmErrors.add(1, { ...attributes, provider });
}

export function recordLlmCircuitBreakerBlock(
  provider: string,
  attributes: RoutingMetricAttributes
): void {
  routingLlmCircuitBreakerBlocks.add(1, { ...attributes, provider });
}

export function recordLlmCircuitBreakerTransition(
  provider: string,
  fromState: 'closed' | 'open' | 'half_open',
  toState: 'closed' | 'open' | 'half_open',
  attributes: RoutingMetricAttributes
): void {
  routingLlmCircuitBreakerTransitions.add(1, {
    ...attributes,
    provider,
    from_state: fromState,
    to_state: toState,
  });
}

export function recordLlmCompatibilityRetry(
  provider: string,
  retryType: 'token_parameter' | 'schema',
  model: string
): void {
  routingLlmCompatibilityRetries.add(1, {
    provider,
    retry_type: retryType,
    model,
  });
}

export function recordRouterPreflightOutcome(
  provider: string,
  model: string,
  status: 'pass' | 'fail',
  latencyMs: number
): void {
  routingPreflightOutcomes.add(1, {
    provider,
    model,
    status,
  });
  routingPreflightLatency.record(latencyMs, {
    provider,
    model,
    status,
  });
}

export function recordRoutingFallback(attributes: RoutingMetricAttributes): void {
  routingFallbacks.add(1, attributes);
}

export function recordRoutingError(
  attributes: RoutingMetricAttributes & { error_type: string }
): void {
  routingErrors.add(1, attributes);
}

export function recordUserRegistered(): void {
  usersRegistered.add(1);
}

export function recordUserLoggedIn(): void {
  usersLoggedIn.add(1);
}

export function recordTokenCreated(): void {
  tokensCreated.add(1);
}

export function recordTokenDeleted(): void {
  tokensDeleted.add(1);
}

export function recordTokenRotated(): void {
  tokensRotated.add(1);
}
