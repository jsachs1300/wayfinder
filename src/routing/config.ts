/**
 * Router LLM Configuration
 *
 * This module defines configuration types and loading logic for the router LLM.
 * Configuration MUST be loaded from environment variables with sensible defaults.
 */

/**
 * Supported router LLM providers
 */
export type RouterLLMProvider = 'openai' | 'anthropic';

/**
 * Router LLM configuration
 *
 * All values are loaded from environment variables with defaults.
 * Required values (API keys) MUST be validated at load time.
 */
export interface RouterLLMConfig {
  /** Provider to use (openai or anthropic) */
  provider: RouterLLMProvider;

  /** Provider API key (from environment) */
  apiKey: string;

  /** Model identifier to use for routing decisions */
  model: string;

  /** Request timeout in milliseconds */
  timeout: number;

  /** Maximum retry attempts on failure */
  maxRetries: number;

  /** Temperature for LLM sampling (0.0 = deterministic) */
  temperature: number;

  /** Maximum tokens in LLM response */
  maxTokens: number;
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  provider: 'openai' as RouterLLMProvider,
  model: 'gpt-4o-mini',
  timeout: 30000, // Increased from 10s to 30s for ranked routing (14 models vs 2)
  maxRetries: 2,
  temperature: 0.0,
  maxTokens: 2000, // Increased from 500 to 2000 for ranked routing (14 models with reasons)
};

/**
 * Loads router LLM configuration from environment variables
 *
 * Environment variables:
 * - ROUTER_LLM_PROVIDER: 'openai' | 'anthropic' (default: 'openai')
 * - ROUTER_LLM_API_KEY: API key for the provider (REQUIRED)
 * - ROUTER_LLM_MODEL: Model identifier (default: 'gpt-4o-mini')
 * - ROUTER_LLM_TIMEOUT: Request timeout in ms (default: 10000)
 * - ROUTER_LLM_MAX_RETRIES: Max retry attempts (default: 2)
 * - ROUTER_LLM_TEMPERATURE: Sampling temperature (default: 0.0)
 * - ROUTER_LLM_MAX_TOKENS: Max response tokens (default: 500)
 *
 * @throws Error if required configuration is missing
 * @returns Validated RouterLLMConfig
 */
export function loadRouterLLMConfig(): RouterLLMConfig {
  const provider = (process.env.ROUTER_LLM_PROVIDER || DEFAULTS.provider) as RouterLLMProvider;

  // Validate provider
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(
      `Invalid ROUTER_LLM_PROVIDER: ${provider}. Must be 'openai' or 'anthropic'`
    );
  }

  // API key is REQUIRED
  const apiKey = process.env.ROUTER_LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ROUTER_LLM_API_KEY environment variable is required'
    );
  }

  // Load other configuration with defaults
  const model = process.env.ROUTER_LLM_MODEL || DEFAULTS.model;
  const timeout = parseInt(process.env.ROUTER_LLM_TIMEOUT || String(DEFAULTS.timeout), 10);
  const maxRetries = parseInt(process.env.ROUTER_LLM_MAX_RETRIES || String(DEFAULTS.maxRetries), 10);
  const temperature = parseFloat(process.env.ROUTER_LLM_TEMPERATURE || String(DEFAULTS.temperature));
  const maxTokens = parseInt(process.env.ROUTER_LLM_MAX_TOKENS || String(DEFAULTS.maxTokens), 10);

  // Validate parsed numbers
  if (isNaN(timeout) || timeout <= 0) {
    throw new Error(`Invalid ROUTER_LLM_TIMEOUT: must be a positive number`);
  }
  if (isNaN(maxRetries) || maxRetries < 0) {
    throw new Error(`Invalid ROUTER_LLM_MAX_RETRIES: must be a non-negative number`);
  }
  if (isNaN(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid ROUTER_LLM_TEMPERATURE: must be between 0 and 2`);
  }
  if (isNaN(maxTokens) || maxTokens <= 0) {
    throw new Error(`Invalid ROUTER_LLM_MAX_TOKENS: must be a positive number`);
  }

  return {
    provider,
    apiKey,
    model,
    timeout,
    maxRetries,
    temperature,
    maxTokens,
  };
}
