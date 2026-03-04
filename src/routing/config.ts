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
 * Startup preflight behavior
 */
export type RouterPreflightMode = 'strict' | 'warn' | 'off';

/**
 * Multi-provider aggregation behavior
 */
export type RouterConsensusMode = 'full' | 'fast';

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

  /** Reliability and compatibility controls */
  reliability: {
    /** Startup preflight policy */
    preflightMode: RouterPreflightMode;
    /** Timeout for each preflight probe in milliseconds */
    preflightTimeoutMs: number;
    /** Sliding window duration for circuit breaker in milliseconds */
    circuitBreakerWindowMs: number;
    /** Consecutive/within-window error threshold to open breaker */
    circuitBreakerErrorThreshold: number;
    /** Time breaker stays open before half-open probe in milliseconds */
    circuitBreakerOpenMs: number;
    /** Consensus behavior mode */
    consensusMode: RouterConsensusMode;
  };
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
  preflightTimeoutMs: 10000,
  circuitBreakerWindowMs: 60000,
  circuitBreakerErrorThreshold: 5,
  circuitBreakerOpenMs: 30000,
  consensusMode: 'full' as RouterConsensusMode,
};

export function loadRouterLLMReliabilityConfig(): RouterLLMConfig['reliability'] {
  const isProduction = process.env.NODE_ENV === 'production';
  const preflightModeRaw = process.env.ROUTER_PREFLIGHT_MODE ?? (isProduction ? 'strict' : 'warn');
  if (preflightModeRaw !== 'strict' && preflightModeRaw !== 'warn' && preflightModeRaw !== 'off') {
    throw new Error('Invalid ROUTER_PREFLIGHT_MODE: must be one of strict, warn, off');
  }

  const consensusModeRaw = process.env.ROUTER_CONSENSUS_MODE || DEFAULTS.consensusMode;
  if (consensusModeRaw !== 'full' && consensusModeRaw !== 'fast') {
    throw new Error('Invalid ROUTER_CONSENSUS_MODE: must be one of full, fast');
  }

  const preflightTimeoutMs = parseInt(
    process.env.ROUTER_PREFLIGHT_TIMEOUT_MS || String(DEFAULTS.preflightTimeoutMs),
    10
  );
  const circuitBreakerWindowMs = parseInt(
    process.env.ROUTER_CIRCUIT_BREAKER_WINDOW_MS || String(DEFAULTS.circuitBreakerWindowMs),
    10
  );
  const circuitBreakerErrorThreshold = parseInt(
    process.env.ROUTER_CIRCUIT_BREAKER_ERROR_THRESHOLD || String(DEFAULTS.circuitBreakerErrorThreshold),
    10
  );
  const circuitBreakerOpenMs = parseInt(
    process.env.ROUTER_CIRCUIT_BREAKER_OPEN_MS || String(DEFAULTS.circuitBreakerOpenMs),
    10
  );

  if (isNaN(preflightTimeoutMs) || preflightTimeoutMs <= 0) {
    throw new Error('Invalid ROUTER_PREFLIGHT_TIMEOUT_MS: must be a positive number');
  }
  if (isNaN(circuitBreakerWindowMs) || circuitBreakerWindowMs <= 0) {
    throw new Error('Invalid ROUTER_CIRCUIT_BREAKER_WINDOW_MS: must be a positive number');
  }
  if (isNaN(circuitBreakerErrorThreshold) || circuitBreakerErrorThreshold <= 0) {
    throw new Error('Invalid ROUTER_CIRCUIT_BREAKER_ERROR_THRESHOLD: must be a positive number');
  }
  if (isNaN(circuitBreakerOpenMs) || circuitBreakerOpenMs <= 0) {
    throw new Error('Invalid ROUTER_CIRCUIT_BREAKER_OPEN_MS: must be a positive number');
  }

  return {
    preflightMode: preflightModeRaw,
    preflightTimeoutMs,
    circuitBreakerWindowMs,
    circuitBreakerErrorThreshold,
    circuitBreakerOpenMs,
    consensusMode: consensusModeRaw,
  };
}

/**
 * Loads router LLM configuration from environment variables
 *
 * Environment variables:
 * - ROUTER_LLM_OPENAI_ENABLED: Enable OpenAI provider (default: false)
 * - ROUTER_LLM_OPENAI_API_KEY: OpenAI API key (required if OpenAI enabled)
 * - ROUTER_LLM_OPENAI_MODEL: OpenAI model identifier (default: 'gpt-4o-mini')
 * - ROUTER_LLM_GEMINI_ENABLED: Enable Gemini provider (default: false)
 * - ROUTER_LLM_GEMINI_API_KEY: Gemini API key (required if Gemini enabled)
 * - ROUTER_LLM_GEMINI_MODEL: Gemini model identifier (default: 'gemini-1.5-flash')
 * - ROUTER_LLM_TIMEOUT: Request timeout in ms (default: 30000)
 * - ROUTER_LLM_MAX_RETRIES: Max retry attempts (default: 2)
 * - ROUTER_LLM_TEMPERATURE: Sampling temperature (default: 0.0)
 * - ROUTER_LLM_MAX_TOKENS: Max response tokens (default: 2000)
 * - ROUTER_PREFLIGHT_MODE: strict|warn|off (default: strict in prod, warn otherwise)
 * - ROUTER_PREFLIGHT_TIMEOUT_MS: Preflight probe timeout in ms (default: 10000)
 * - ROUTER_CIRCUIT_BREAKER_WINDOW_MS: Breaker error window in ms (default: 60000)
 * - ROUTER_CIRCUIT_BREAKER_ERROR_THRESHOLD: Breaker open threshold (default: 5)
 * - ROUTER_CIRCUIT_BREAKER_OPEN_MS: Breaker open duration in ms (default: 30000)
 * - ROUTER_CONSENSUS_MODE: full|fast (default: full)
 * - NODE_ENV: Set to 'test' or 'development' to bypass router LLM requirement for testing
 *
 * @throws Error if required configuration is missing or invalid (unless in test/dev mode)
 * @returns Validated RouterLLMConfig
 */
export function loadRouterLLMConfig(): RouterLLMConfig {
  // Check if we're in test/dev mode (allows bypassing requirements for testing)
  const isTestMode = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

  // OpenAI configuration
  const openaiEnabled = process.env.ROUTER_LLM_OPENAI_ENABLED === 'true'; // Default: false
  const openaiApiKey = process.env.ROUTER_LLM_OPENAI_API_KEY;
  const openaiModel = process.env.ROUTER_LLM_OPENAI_MODEL || DEFAULTS.openaiModel;

  if (openaiEnabled && !openaiApiKey && !isTestMode) {
    throw new Error(
      'ROUTER_LLM_OPENAI_API_KEY environment variable is required when OpenAI is enabled.\n' +
      'Set ROUTER_LLM_OPENAI_API_KEY in your .env file or disable OpenAI with ROUTER_LLM_OPENAI_ENABLED=false'
    );
  }

  // Gemini configuration
  const geminiEnabled = process.env.ROUTER_LLM_GEMINI_ENABLED === 'true'; // Default: false
  const geminiApiKey = process.env.ROUTER_LLM_GEMINI_API_KEY;
  const geminiModel = process.env.ROUTER_LLM_GEMINI_MODEL || DEFAULTS.geminiModel;

  if (geminiEnabled && !geminiApiKey && !isTestMode) {
    throw new Error(
      'ROUTER_LLM_GEMINI_API_KEY environment variable is required when Gemini is enabled.\n' +
      'Set ROUTER_LLM_GEMINI_API_KEY in your .env file or disable Gemini with ROUTER_LLM_GEMINI_ENABLED=false'
    );
  }

  // Validate that at least one provider is enabled (unless in test mode)
  if (!openaiEnabled && !geminiEnabled && !isTestMode) {
    throw new Error(
      'At least one router LLM provider must be enabled for production use.\n\n' +
      'To enable OpenAI:\n' +
      '  ROUTER_LLM_OPENAI_ENABLED=true\n' +
      '  ROUTER_LLM_OPENAI_API_KEY=sk-your-key-here\n\n' +
      'To enable Gemini:\n' +
      '  ROUTER_LLM_GEMINI_ENABLED=true\n' +
      '  ROUTER_LLM_GEMINI_API_KEY=your-key-here\n\n' +
      'You can enable both providers for multi-provider routing.'
    );
  }

  // Load shared configuration with defaults
  const timeout = parseInt(process.env.ROUTER_LLM_TIMEOUT || String(DEFAULTS.timeout), 10);
  const maxRetries = parseInt(process.env.ROUTER_LLM_MAX_RETRIES || String(DEFAULTS.maxRetries), 10);
  const temperature = parseFloat(process.env.ROUTER_LLM_TEMPERATURE || String(DEFAULTS.temperature));
  const maxTokens = parseInt(process.env.ROUTER_LLM_MAX_TOKENS || String(DEFAULTS.maxTokens), 10);
  const reliability = loadRouterLLMReliabilityConfig();

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
    reliability,
  };
}
