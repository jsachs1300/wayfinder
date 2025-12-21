/**
 * Provider Interface Types
 *
 * This module defines the interface that all LLM provider clients must implement.
 * Providers are responsible for invoking their respective APIs and returning structured responses.
 */

/**
 * LLM provider invocation request
 */
export interface ProviderRequest {
  /** The prompt to send to the LLM */
  prompt: string;

  /** Model identifier */
  model: string;

  /** Sampling temperature (0.0 = deterministic) */
  temperature: number;

  /** Maximum tokens in response */
  maxTokens: number;

  /** Request timeout in milliseconds */
  timeout: number;
}

/**
 * LLM provider invocation response
 */
export interface ProviderResponse {
  /** The raw text content from the LLM */
  content: string;

  /** Provider-specific metadata */
  metadata: {
    /** Model that generated the response */
    model: string;

    /** Number of input tokens consumed */
    inputTokens?: number;

    /** Number of output tokens generated */
    outputTokens?: number;

    /** Response latency in milliseconds */
    latencyMs: number;

    /** Provider name */
    provider: string;

    /** Any additional provider-specific data */
    [key: string]: unknown;
  };
}

/**
 * LLM Provider Client Interface
 *
 * All provider implementations MUST implement this interface.
 * Implementations MUST use native fetch API (no external SDKs).
 */
export interface ProviderClient {
  /**
   * Invokes the LLM provider with the given request
   *
   * @param request - Provider invocation request
   * @returns Provider response with content and metadata
   * @throws RouterLLMProviderError on API failure
   * @throws RouterLLMTimeoutError on timeout
   */
  invoke(request: ProviderRequest): Promise<ProviderResponse>;

  /**
   * Returns the provider name
   */
  getProviderName(): string;
}
