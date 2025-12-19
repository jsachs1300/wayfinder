/**
 * Model validation errors
 * These errors are thrown when model identifiers fail validation
 */

/**
 * Base class for all model validation errors
 */
export class ModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelValidationError';
    Object.setPrototypeOf(this, ModelValidationError.prototype);
  }
}

/**
 * Thrown when a model ID does not exist in the registry
 */
export class InvalidModelError extends ModelValidationError {
  constructor(
    public readonly modelId: string,
    public readonly context?: string
  ) {
    super(
      `Invalid model identifier: "${modelId}"${context ? ` (context: ${context})` : ''}. ` +
        `Model does not exist in the registry.`
    );
    this.name = 'InvalidModelError';
    Object.setPrototypeOf(this, InvalidModelError.prototype);
  }
}

/**
 * Thrown when a model is disabled and cannot be used
 */
export class DisabledModelError extends ModelValidationError {
  constructor(
    public readonly modelId: string,
    public readonly context?: string
  ) {
    super(
      `Model "${modelId}" is disabled and cannot be used${context ? ` (context: ${context})` : ''}. ` +
        `Disabled models are excluded from all routing, policy, and knowledge operations.`
    );
    this.name = 'DisabledModelError';
    Object.setPrototypeOf(this, DisabledModelError.prototype);
  }
}

/**
 * Thrown when a model is not eligible for global knowledge scope
 */
export class ModelNotGlobalEligibleError extends ModelValidationError {
  constructor(
    public readonly modelId: string,
    public readonly context?: string
  ) {
    super(
      `Model "${modelId}" is not eligible for global knowledge scope${context ? ` (context: ${context})` : ''}. ` +
        `Only curated, global-eligible models may participate in shared knowledge.`
    );
    this.name = 'ModelNotGlobalEligibleError';
    Object.setPrototypeOf(this, ModelNotGlobalEligibleError.prototype);
  }
}

/**
 * Thrown when a model is not allowed for a specific token
 */
export class ModelNotAllowedForTokenError extends ModelValidationError {
  constructor(
    public readonly modelId: string,
    public readonly tokenId: string,
    public readonly reason: string
  ) {
    super(
      `Model "${modelId}" is not allowed for token "${tokenId}": ${reason}`
    );
    this.name = 'ModelNotAllowedForTokenError';
    Object.setPrototypeOf(this, ModelNotAllowedForTokenError.prototype);
  }
}

/**
 * Thrown when token configuration contains contradictions
 */
export class ModelConfigurationError extends ModelValidationError {
  constructor(message: string) {
    super(`Invalid model configuration: ${message}`);
    this.name = 'ModelConfigurationError';
    Object.setPrototypeOf(this, ModelConfigurationError.prototype);
  }
}
