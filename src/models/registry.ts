import { ModelInfo, TokenConfig, KnowledgeScope } from '../types';
import {
  InvalidModelError,
  DisabledModelError,
  ModelNotGlobalEligibleError,
  ModelNotAllowedForTokenError,
  ModelConfigurationError,
} from './errors';
import { createLogger } from '../logging';

const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Context for model validation
 */
export type ValidationContext =
  | 'token_config'
  | 'policy_rule'
  | 'feedback'
  | 'polling'
  | 'knowledge_vote'
  | 'routing';

/**
 * Model registry interface
 * Designed to allow BYOM (Bring Your Own Model) in the future
 */
export interface ModelRegistry {
  // Read operations
  getModel(id: string): ModelInfo | null;
  getAllModels(): ModelInfo[];
  getAvailableModels(): ModelInfo[];
  isValidModel(id: string): boolean;
  getDefaultModel(): string;

  // Mutation operations (future BYOM support)
  registerModel(model: ModelInfo): void;
  unregisterModel(id: string): boolean;

  // Validation API (fail-fast assertions)
  assertModelExists(modelId: string, context?: ValidationContext): void;
  assertModelActive(modelId: string, context?: ValidationContext): void;
  assertModelGlobalEligible(modelId: string, context?: ValidationContext): void;
  assertModelAllowedForToken(
    modelId: string,
    tokenConfig: TokenConfig,
    context?: ValidationContext
  ): void;
  assertModelListValid(
    modelIds: string[],
    knowledgeScope: KnowledgeScope,
    context?: ValidationContext
  ): void;
  validateTokenConfig(tokenConfig: Partial<TokenConfig>): void;
}

/**
 * Default known models
 * These represent well-known LLM providers and models
 * No execution happens - this is just a registry
 *
 * IMPORTANT: This is the ONLY authoritative source of model identifiers.
 * Only models listed here may participate in Wayfinder operations.
 */
const DEFAULT_MODELS: ModelInfo[] = [
  // OpenAI Models
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    cost_tier: 'high',
    speed_tier: 'medium',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'OpenAI GPT-4 Turbo - High-performance general-purpose model',
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    cost_tier: 'high',
    speed_tier: 'fast',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'OpenAI GPT-4o - Fast multimodal model with vision capabilities',
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'OpenAI GPT-4o Mini - Cost-effective model for lightweight tasks',
  },
  {
    id: 'o1',
    provider: 'openai',
    cost_tier: 'high',
    speed_tier: 'slow',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'OpenAI o1 - Advanced reasoning model for complex problem-solving',
  },
  {
    id: 'o1-mini',
    provider: 'openai',
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'OpenAI o1-mini - Reasoning-optimized model at lower cost',
  },

  // Anthropic Models
  {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    cost_tier: 'medium',
    speed_tier: 'fast',
    context_window: 200000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Anthropic Claude 3.5 Sonnet - Balanced model for most tasks',
  },
  {
    id: 'claude-3-opus',
    provider: 'anthropic',
    cost_tier: 'high',
    speed_tier: 'slow',
    context_window: 200000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Anthropic Claude 3 Opus - Most capable model for complex tasks',
  },
  {
    id: 'claude-3-haiku',
    provider: 'anthropic',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 200000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Anthropic Claude 3 Haiku - Fast model for simple tasks',
  },

  // Google Models
  {
    id: 'gemini-1.5-pro',
    provider: 'google',
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 1000000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Google Gemini 1.5 Pro - Long-context general-purpose model',
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'google',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 1000000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Google Gemini 1.5 Flash - Fast model with long context',
  },

  // Meta Models
  {
    id: 'llama-3.1-70b',
    provider: 'meta',
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Meta Llama 3.1 70B - Open-weight large model',
  },
  {
    id: 'llama-3.1-8b',
    provider: 'meta',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Meta Llama 3.1 8B - Efficient open-weight model',
  },

  // Mistral Models
  {
    id: 'mistral-large',
    provider: 'mistral',
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 32000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Mistral Large - High-performance European model',
  },
  {
    id: 'mistral-medium',
    provider: 'mistral',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 32000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: 'Mistral Medium - Balanced European model',
  },
];

/**
 * Default model registry implementation with strict validation
 */
export class DefaultModelRegistry implements ModelRegistry {
  private models: Map<string, ModelInfo> = new Map();
  private defaultModelId: string = 'claude-3-5-sonnet';

  constructor(initialModels: ModelInfo[] = DEFAULT_MODELS) {
    for (const model of initialModels) {
      this.models.set(model.id, model);
    }
  }

  // ===== Read Operations =====

  getModel(id: string): ModelInfo | null {
    return this.models.get(id) ?? null;
  }

  getAllModels(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  getAvailableModels(): ModelInfo[] {
    return Array.from(this.models.values()).filter((m) => m.available);
  }

  isValidModel(id: string): boolean {
    return this.models.has(id);
  }

  getDefaultModel(): string {
    return this.defaultModelId;
  }

  // ===== Mutation Operations =====

  registerModel(model: ModelInfo): void {
    this.models.set(model.id, model);
  }

  unregisterModel(id: string): boolean {
    return this.models.delete(id);
  }

  // ===== Validation API (Fail-Fast Assertions) =====

  /**
   * Assert that a model ID exists in the registry
   * @throws InvalidModelError if model does not exist
   */
  assertModelExists(modelId: string, context?: ValidationContext): void {
    if (!this.models.has(modelId)) {
      throw new InvalidModelError(modelId, context);
    }
  }

  /**
   * Assert that a model is active (not deprecated or disabled)
   * @throws InvalidModelError if model doesn't exist
   * @throws DisabledModelError if model is disabled
   */
  assertModelActive(modelId: string, context?: ValidationContext): void {
    const model = this.models.get(modelId);
    if (!model) {
      throw new InvalidModelError(modelId, context);
    }

    if (model.status === 'disabled') {
      throw new DisabledModelError(modelId, context);
    }

    // Log warning for deprecated models but don't fail
    if (model.status === 'deprecated') {
      logger.warn('Deprecated model in use', {
        model_id: modelId,
        context,
        message: `Model "${modelId}" is deprecated and may be removed in the future`,
      });
    }
  }

  /**
   * Assert that a model is eligible for global knowledge scope
   * @throws InvalidModelError if model doesn't exist
   * @throws ModelNotGlobalEligibleError if model is not global-eligible
   */
  assertModelGlobalEligible(
    modelId: string,
    context?: ValidationContext
  ): void {
    const model = this.models.get(modelId);
    if (!model) {
      throw new InvalidModelError(modelId, context);
    }

    if (!model.global_eligible) {
      throw new ModelNotGlobalEligibleError(modelId, context);
    }
  }

  /**
   * Assert that a model is allowed for a specific token configuration
   * Checks: exists, active, allowed_models, denied_models
   * @throws InvalidModelError, DisabledModelError, or ModelNotAllowedForTokenError
   */
  assertModelAllowedForToken(
    modelId: string,
    tokenConfig: TokenConfig,
    context?: ValidationContext
  ): void {
    // First check model exists and is active
    this.assertModelExists(modelId, context);
    this.assertModelActive(modelId, context);

    // Check allowed_models (if specified, model must be in the list)
    if (tokenConfig.allowed_models && tokenConfig.allowed_models.length > 0) {
      if (!tokenConfig.allowed_models.includes(modelId)) {
        throw new ModelNotAllowedForTokenError(
          modelId,
          tokenConfig.id,
          `Model is not in the token's allowed_models list`
        );
      }
    }

    // Check denied_models (if model is in deny list, reject)
    if (tokenConfig.denied_models && tokenConfig.denied_models.includes(modelId)) {
      throw new ModelNotAllowedForTokenError(
        modelId,
        tokenConfig.id,
        `Model is in the token's denied_models list`
      );
    }
  }

  /**
   * Validate a list of model IDs for a given knowledge scope
   * For global scope, all models must be global-eligible
   * @throws InvalidModelError, DisabledModelError, or ModelNotGlobalEligibleError
   */
  assertModelListValid(
    modelIds: string[],
    knowledgeScope: KnowledgeScope,
    context?: ValidationContext
  ): void {
    for (const modelId of modelIds) {
      this.assertModelExists(modelId, context);
      this.assertModelActive(modelId, context);

      // For global scope, ensure all models are global-eligible
      if (knowledgeScope === 'global') {
        this.assertModelGlobalEligible(modelId, context);
      }
    }
  }

  /**
   * Comprehensive token configuration validation
   * Validates all model references and checks for contradictions
   * @throws ModelValidationError subclasses or ModelConfigurationError
   */
  validateTokenConfig(tokenConfig: Partial<TokenConfig>): void {
    const knowledgeScope = tokenConfig.knowledge_scope ?? 'global';

    // Validate trusted_anchor_model
    if (tokenConfig.trusted_anchor_model) {
      this.assertModelExists(tokenConfig.trusted_anchor_model, 'token_config');
      this.assertModelActive(tokenConfig.trusted_anchor_model, 'token_config');

      if (knowledgeScope === 'global') {
        this.assertModelGlobalEligible(
          tokenConfig.trusted_anchor_model,
          'token_config'
        );
      }
    }

    // Validate eligible_models
    if (tokenConfig.eligible_models) {
      this.assertModelListValid(
        tokenConfig.eligible_models,
        knowledgeScope,
        'token_config'
      );

      // Ensure at least one model
      if (tokenConfig.eligible_models.length === 0) {
        throw new ModelConfigurationError(
          'eligible_models must contain at least one model'
        );
      }
    }

    // Validate allowed_models
    if (tokenConfig.allowed_models) {
      this.assertModelListValid(
        tokenConfig.allowed_models,
        knowledgeScope,
        'token_config'
      );
    }

    // Validate denied_models
    if (tokenConfig.denied_models) {
      this.assertModelListValid(
        tokenConfig.denied_models,
        knowledgeScope,
        'token_config'
      );
    }

    // Check for contradictions
    if (
      tokenConfig.allowed_models &&
      tokenConfig.denied_models &&
      tokenConfig.allowed_models.length > 0 &&
      tokenConfig.denied_models.length > 0
    ) {
      const allowSet = new Set(tokenConfig.allowed_models);
      const denySet = new Set(tokenConfig.denied_models);
      const overlap = tokenConfig.allowed_models.filter((m) => denySet.has(m));

      if (overlap.length > 0) {
        throw new ModelConfigurationError(
          `Models cannot be in both allowed_models and denied_models: ${overlap.join(', ')}`
        );
      }
    }

    // trusted_anchor_model must not be denied
    if (
      tokenConfig.trusted_anchor_model &&
      tokenConfig.denied_models &&
      tokenConfig.denied_models.includes(tokenConfig.trusted_anchor_model)
    ) {
      throw new ModelConfigurationError(
        `trusted_anchor_model "${tokenConfig.trusted_anchor_model}" cannot be in denied_models`
      );
    }

    // eligible_models must not overlap with denied_models
    if (
      tokenConfig.eligible_models &&
      tokenConfig.denied_models &&
      tokenConfig.denied_models.length > 0
    ) {
      const overlap = tokenConfig.eligible_models.filter(m =>
        tokenConfig.denied_models!.includes(m)
      );
      if (overlap.length > 0) {
        throw new ModelConfigurationError(
          `Models cannot be in both eligible_models and denied_models: ${overlap.join(', ')}`
        );
      }
    }

    // If allowed_models is specified, trusted_anchor and default must be in it
    if (tokenConfig.allowed_models && tokenConfig.allowed_models.length > 0) {
      if (
        tokenConfig.trusted_anchor_model &&
        !tokenConfig.allowed_models.includes(tokenConfig.trusted_anchor_model)
      ) {
        throw new ModelConfigurationError(
          `trusted_anchor_model "${tokenConfig.trusted_anchor_model}" must be in allowed_models`
        );
      }

      if (
        tokenConfig.eligible_models
      ) {
        // If both allowed_models and eligible_models are specified,
        // eligible_models must be a subset of allowed_models
        const notInAllowed = tokenConfig.eligible_models.filter(m =>
          !tokenConfig.allowed_models!.includes(m)
        );
        if (notInAllowed.length > 0) {
          throw new ModelConfigurationError(
            `eligible_models must be a subset of allowed_models. Not in allowed: ${notInAllowed.join(', ')}`
          );
        }
      }
    }

    // Validate policy rules
    if (tokenConfig.policy_rules) {
      for (const rule of tokenConfig.policy_rules) {
        this.assertModelListValid(rule.models, knowledgeScope, 'policy_rule');
      }
    }
  }

  // ===== Utility Methods =====

  /**
   * Get model IDs as a simple array
   */
  getModelIds(): string[] {
    return Array.from(this.models.keys());
  }

  /**
   * Get all active models (excludes disabled)
   */
  getActiveModels(): ModelInfo[] {
    return Array.from(this.models.values()).filter(
      (m) => m.status === 'active' || m.status === 'deprecated'
    );
  }

  /**
   * Get all global-eligible models
   */
  getGlobalEligibleModels(): ModelInfo[] {
    return Array.from(this.models.values()).filter((m) => m.global_eligible);
  }
}

/**
 * Create a model registry instance
 */
export function createModelRegistry(
  customModels?: ModelInfo[]
): DefaultModelRegistry {
  return new DefaultModelRegistry(customModels ?? DEFAULT_MODELS);
}
