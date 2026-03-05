import type { RouterLLMProvider } from '../config';

export type TokenLimitParameter = 'max_tokens' | 'max_completion_tokens';
export type JsonResponseMode = 'native_json' | 'prompt_only';
export type JsonSchemaMode = 'provider_schema' | 'none';

export interface ProviderCapabilityProfile {
  provider: RouterLLMProvider;
  modelPattern: RegExp;
  tokenLimitParameter: TokenLimitParameter;
  jsonResponseMode: JsonResponseMode;
  jsonSchemaMode: JsonSchemaMode;
}

const DEFAULT_CAPABILITY_PROFILES: ProviderCapabilityProfile[] = [
  {
    provider: 'openai',
    modelPattern: /^gpt-5|^o\d/i,
    tokenLimitParameter: 'max_completion_tokens',
    jsonResponseMode: 'native_json',
    jsonSchemaMode: 'none',
  },
  {
    provider: 'openai',
    modelPattern: /.*/,
    tokenLimitParameter: 'max_tokens',
    jsonResponseMode: 'native_json',
    jsonSchemaMode: 'none',
  },
  {
    provider: 'gemini',
    modelPattern: /.*/,
    tokenLimitParameter: 'max_tokens',
    jsonResponseMode: 'native_json',
    jsonSchemaMode: 'provider_schema',
  },
  {
    provider: 'anthropic',
    modelPattern: /.*/,
    tokenLimitParameter: 'max_tokens',
    jsonResponseMode: 'prompt_only',
    jsonSchemaMode: 'none',
  },
];

function getFallbackProfile(provider: RouterLLMProvider): ProviderCapabilityProfile {
  return {
    provider,
    modelPattern: /.*/,
    tokenLimitParameter: 'max_tokens',
    jsonResponseMode: 'prompt_only',
    jsonSchemaMode: 'none',
  };
}

export function getProviderCapabilityProfile(
  provider: RouterLLMProvider,
  modelId: string
): ProviderCapabilityProfile {
  const profile = DEFAULT_CAPABILITY_PROFILES.find(
    (candidate) => candidate.provider === provider && candidate.modelPattern.test(modelId)
  );
  return profile ?? getFallbackProfile(provider);
}
