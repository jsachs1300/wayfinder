/**
 * Router LLM Configuration
 *
 * This module defines configuration types and loading logic for the router LLM.
 * Configuration MUST be loaded from environment variables with sensible defaults.
 */

/**
 * Supported router LLM providers
 */
export type RouterLLMProvider = 'openai' | 'anthropic' | 'gemini';

/**
 * Configuration for a single router LLM provider
 */
export interface ProviderConfig {
  /** Whether this provider is enabled */
  enabled: boolean;

  /** Provider API key (required only if enabled) */
  apiKey?: string;

  /** Model identifier */
  model: string;
}

/**
 * Router LLM configuration
 *
 * All values are loaded from environment variables with defaults.
 * At least one provider must be enabled.
 * If multiple providers are enabled, their rankings are aggregated.
 */
export interface RouterLLMConfig {
  /** OpenAI configuration */
  openai: ProviderConfig;

  /** Gemini configuration */
  gemini: ProviderConfig;

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
  openaiModel: 'gpt-4o-mini',
  geminiModel: 'gemini-1.5-flash',
  timeout: 30000, // Increased from 10s to 30s for ranked routing (14 models vs 2)
  maxRetries: 2,
  temperature: 0.0,
  maxTokens: 2000, // Increased from 500 to 2000 for ranked routing (14 models with reasons)
};

/**
 * Loads router LLM configuration from environment variables
 *
 * Environment variables:
 * - ROUTER_LLM_OPENAI_ENABLED: Enable OpenAI provider (default: true)
 * - ROUTER_LLM_OPENAI_API_KEY: OpenAI API key (required if OpenAI enabled)
 * - ROUTER_LLM_OPENAI_MODEL: OpenAI model identifier (default: 'gpt-4o-mini')
 * - ROUTER_LLM_GEMINI_ENABLED: Enable Gemini provider (default: true)
 * - ROUTER_LLM_GEMINI_API_KEY: Gemini API key (required if Gemini enabled)
 * - ROUTER_LLM_GEMINI_MODEL: Gemini model identifier (default: 'gemini-1.5-flash')
 * - ROUTER_LLM_TIMEOUT: Request timeout in ms (default: 30000)
 * - ROUTER_LLM_MAX_RETRIES: Max retry attempts (default: 2)
 * - ROUTER_LLM_TEMPERATURE: Sampling temperature (default: 0.0)
 * - ROUTER_LLM_MAX_TOKENS: Max response tokens (default: 2000)
 *
 * @throws Error if required configuration is missing or invalid
 * @returns Validated RouterLLMConfig
 */
export function loadRouterLLMConfig(): RouterLLMConfig {
  // OpenAI configuration
  const openaiEnabled = process.env.ROUTER_LLM_OPENAI_ENABLED !== 'false'; // Default: true
  const openaiApiKey = process.env.ROUTER_LLM_OPENAI_API_KEY;
  const openaiModel = process.env.ROUTER_LLM_OPENAI_MODEL || DEFAULTS.openaiModel;

  if (openaiEnabled && !openaiApiKey) {
    throw new Error(
      'ROUTER_LLM_OPENAI_API_KEY environment variable is required when OpenAI is enabled'
    );
  }

  // Gemini configuration
  const geminiEnabled = process.env.ROUTER_LLM_GEMINI_ENABLED !== 'false'; // Default: true
  const geminiApiKey = process.env.ROUTER_LLM_GEMINI_API_KEY;
  const geminiModel = process.env.ROUTER_LLM_GEMINI_MODEL || DEFAULTS.geminiModel;

  if (geminiEnabled && !geminiApiKey) {
    throw new Error(
      'ROUTER_LLM_GEMINI_API_KEY environment variable is required when Gemini is enabled'
    );
  }

  // Validate that at least one provider is enabled
  if (!openaiEnabled && !geminiEnabled) {
    throw new Error(
      'At least one router LLM provider must be enabled. ' +
      'Set ROUTER_LLM_OPENAI_ENABLED=true or ROUTER_LLM_GEMINI_ENABLED=true'
    );
  }

  // Load shared configuration with defaults
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
    openai: {
      enabled: openaiEnabled,
      apiKey: openaiApiKey,
      model: openaiModel,
    },
    gemini: {
      enabled: geminiEnabled,
      apiKey: geminiApiKey,
      model: geminiModel,
    },
    timeout,
    maxRetries,
    temperature,
    maxTokens,
  };
}
