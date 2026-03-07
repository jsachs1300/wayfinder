/**
 * Router LLM Module Exports
 *
 * This module provides the router LLM implementation for making routing decisions.
 */

export { DefaultRouterLLM } from './default-router-llm';
export {
  MultiProviderRouterLLM,
  type MultiProviderResult,
  ROUTER_MODEL_REQUESTED_METADATA_KEY,
} from './multi-provider-router-llm';
export { BYOLLMRouterLLM } from './byollm-router-llm';
export { StubRouterLLM } from './stub-router-llm';
export { buildProviderInvocationPlan, type ProviderInvocationPlan } from './provider-adapter';
export {
  getProviderCapabilityProfile,
  type ProviderCapabilityProfile,
  type TokenLimitParameter,
  type JsonResponseMode,
  type JsonSchemaMode,
} from './capabilities';
export {
  InMemoryRouterProviderHealthStore,
  type RouterProviderHealthSnapshot,
  type RouterProviderHealthStore,
  type ProviderHealthState,
  type CircuitBreakerState,
  type PreflightStatus,
} from './provider-health';
export { buildRoutingPrompt } from './prompt-builder';
export { parseRouteDecision, parseRouteDecisionLenient, extractJSON } from './response-parser';
export {
  RouterStartupPreflight,
  RouterStartupPreflightError,
  type RouterPreflightProviderResult,
  type RouterPreflightSummary,
} from './preflight';
export {
  ProviderCircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerDecision,
} from './circuit-breaker';
export {
  loadRouterLLMConfig,
  loadRouterLLMReliabilityConfig,
  type RouterLLMConfig,
  type RouterLLMProvider,
  type RouterPreflightMode,
  type RouterConsensusMode,
} from '../config';
export * from './errors';
export type { ProviderClient, ProviderRequest, ProviderResponse } from './providers/types';
