/**
 * Provider Client Factory
 *
 * Exports all provider clients and provides factory function.
 */

export { OpenAIClient } from './openai-client';
export { AnthropicClient } from './anthropic-client';
export type { ProviderClient, ProviderRequest, ProviderResponse } from './types';

import type { RouterLLMProvider } from '../../config';
import type { ProviderClient } from './types';
import { OpenAIClient } from './openai-client';
import { AnthropicClient } from './anthropic-client';
import { RouterLLMConfigError } from '../errors';

/**
 * Creates a provider client based on the provider type
 *
 * @param provider - Provider type ('openai' or 'anthropic')
 * @param apiKey - API key for the provider
 * @returns ProviderClient implementation
 * @throws RouterLLMConfigError if provider is unsupported
 */
export function createProviderClient(
  provider: RouterLLMProvider,
  apiKey: string
): ProviderClient {
  switch (provider) {
    case 'openai':
      return new OpenAIClient(apiKey);
    case 'anthropic':
      return new AnthropicClient(apiKey);
    default:
      throw new RouterLLMConfigError(
        `Unsupported provider: ${provider}. Must be 'openai' or 'anthropic'`
      );
  }
}
