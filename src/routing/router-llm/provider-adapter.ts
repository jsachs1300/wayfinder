import type { RouterLLMProvider } from '../config';
import type { ProviderRequest } from './providers/types';
import {
  getProviderCapabilityProfile,
  type JsonResponseMode,
  type JsonSchemaMode,
  type TokenLimitParameter,
} from './capabilities';

/**
 * Provider invocation plan derived from a normalized provider request.
 * PR1 scaffolding only; request building will be wired in subsequent PRs.
 */
export interface ProviderInvocationPlan {
  provider: RouterLLMProvider;
  model: string;
  tokenLimitParameter: TokenLimitParameter;
  jsonResponseMode: JsonResponseMode;
  jsonSchemaMode: JsonSchemaMode;
  request: ProviderRequest;
}

export function buildProviderInvocationPlan(
  provider: RouterLLMProvider,
  request: ProviderRequest
): ProviderInvocationPlan {
  const capabilities = getProviderCapabilityProfile(provider, request.model);

  return {
    provider,
    model: request.model,
    tokenLimitParameter: capabilities.tokenLimitParameter,
    jsonResponseMode: capabilities.jsonResponseMode,
    jsonSchemaMode: capabilities.jsonSchemaMode,
    request,
  };
}
