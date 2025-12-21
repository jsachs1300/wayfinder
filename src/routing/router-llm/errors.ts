/**
 * Router LLM Error Hierarchy
 *
 * This module defines all error types for the router LLM subsystem.
 * Errors MUST be specific and actionable for proper error handling.
 */

/**
 * Base error class for all router LLM errors
 */
export class RouterLLMError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'RouterLLMError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration error
 * Thrown when router LLM configuration is invalid or missing
 */
export class RouterLLMConfigError extends RouterLLMError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'RouterLLMConfigError';
  }
}

/**
 * Provider invocation error
 * Thrown when the LLM provider API call fails
 */
export class RouterLLMProviderError extends RouterLLMError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'RouterLLMProviderError';
  }
}

/**
 * Timeout error
 * Thrown when LLM provider request exceeds configured timeout
 */
export class RouterLLMTimeoutError extends RouterLLMError {
  constructor(
    message: string,
    public readonly timeoutMs: number,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'RouterLLMTimeoutError';
  }
}

/**
 * Validation error
 * Thrown when LLM response fails schema validation
 */
export class RouterLLMValidationError extends RouterLLMError {
  constructor(
    message: string,
    public readonly validationErrors: string[],
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'RouterLLMValidationError';
  }
}

/**
 * Response parsing error
 * Thrown when LLM response cannot be parsed as JSON
 */
export class RouterLLMParseError extends RouterLLMError {
  constructor(
    message: string,
    public readonly rawResponse: string,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'RouterLLMParseError';
  }
}

/**
 * Retry exhausted error
 * Thrown when all retry attempts have been exhausted
 */
export class RouterLLMRetryExhaustedError extends RouterLLMError {
  constructor(
    message: string,
    public readonly attempts: number,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'RouterLLMRetryExhaustedError';
  }
}

/**
 * Policy bypass error
 * Thrown when LLM selects a model that is not in the eligible set
 * This indicates the LLM is attempting to bypass policy constraints
 */
export class RouterLLMPolicyBypassError extends RouterLLMError {
  constructor(
    message: string,
    public readonly selectedModel: string,
    public readonly eligibleModels: string[],
    public readonly field: 'primary' | 'alternate'
  ) {
    super(message);
    this.name = 'RouterLLMPolicyBypassError';
  }
}
