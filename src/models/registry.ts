import { ModelInfo } from '../types';

/**
 * Model registry interface
 * Designed to allow BYOM (Bring Your Own Model) in the future
 */
export interface ModelRegistry {
  getModel(id: string): ModelInfo | null;
  getAllModels(): ModelInfo[];
  getAvailableModels(): ModelInfo[];
  isValidModel(id: string): boolean;
  getDefaultModel(): string;
  registerModel(model: ModelInfo): void;
  unregisterModel(id: string): boolean;
}

/**
 * Default known models
 * These represent well-known LLM providers and models
 * No execution happens - this is just a registry
 */
const DEFAULT_MODELS: ModelInfo[] = [
  // OpenAI Models
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    capabilities: ['reasoning', 'coding', 'creative', 'support'],
    cost_tier: 'high',
    speed_tier: 'medium',
    context_window: 128000,
    available: true,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: ['reasoning', 'coding', 'creative', 'support', 'vision'],
    cost_tier: 'high',
    speed_tier: 'fast',
    context_window: 128000,
    available: true,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    capabilities: ['coding', 'support', 'summarization'],
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 128000,
    available: true,
  },
  {
    id: 'o1',
    provider: 'openai',
    capabilities: ['reasoning', 'coding', 'legal'],
    cost_tier: 'high',
    speed_tier: 'slow',
    context_window: 128000,
    available: true,
  },
  {
    id: 'o1-mini',
    provider: 'openai',
    capabilities: ['reasoning', 'coding'],
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 128000,
    available: true,
  },

  // Anthropic Models
  {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    capabilities: ['reasoning', 'coding', 'creative', 'support', 'code_review'],
    cost_tier: 'medium',
    speed_tier: 'fast',
    context_window: 200000,
    available: true,
  },
  {
    id: 'claude-3-opus',
    provider: 'anthropic',
    capabilities: ['reasoning', 'coding', 'creative', 'legal', 'support'],
    cost_tier: 'high',
    speed_tier: 'slow',
    context_window: 200000,
    available: true,
  },
  {
    id: 'claude-3-haiku',
    provider: 'anthropic',
    capabilities: ['support', 'summarization'],
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 200000,
    available: true,
  },

  // Google Models
  {
    id: 'gemini-1.5-pro',
    provider: 'google',
    capabilities: ['reasoning', 'coding', 'creative', 'support'],
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 1000000,
    available: true,
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'google',
    capabilities: ['support', 'summarization', 'coding'],
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 1000000,
    available: true,
  },

  // Meta Models
  {
    id: 'llama-3.1-70b',
    provider: 'meta',
    capabilities: ['coding', 'reasoning', 'support'],
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 128000,
    available: true,
  },
  {
    id: 'llama-3.1-8b',
    provider: 'meta',
    capabilities: ['support', 'summarization'],
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 128000,
    available: true,
  },

  // Mistral Models
  {
    id: 'mistral-large',
    provider: 'mistral',
    capabilities: ['reasoning', 'coding', 'creative'],
    cost_tier: 'medium',
    speed_tier: 'medium',
    context_window: 32000,
    available: true,
  },
  {
    id: 'mistral-medium',
    provider: 'mistral',
    capabilities: ['coding', 'support'],
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 32000,
    available: true,
  },
];

/**
 * Default model registry implementation
 */
export class DefaultModelRegistry implements ModelRegistry {
  private models: Map<string, ModelInfo> = new Map();
  private defaultModelId: string = 'claude-3-5-sonnet';

  constructor(initialModels: ModelInfo[] = DEFAULT_MODELS) {
    for (const model of initialModels) {
      this.models.set(model.id, model);
    }
  }

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

  registerModel(model: ModelInfo): void {
    this.models.set(model.id, model);
  }

  unregisterModel(id: string): boolean {
    return this.models.delete(id);
  }

  /**
   * Get models suitable for a specific capability
   */
  getModelsForCapability(capability: string): ModelInfo[] {
    return Array.from(this.models.values()).filter(
      (m) => m.available && m.capabilities.includes(capability)
    );
  }

  /**
   * Get model IDs as a simple array
   */
  getModelIds(): string[] {
    return Array.from(this.models.keys());
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
