import type { ModelInfo } from '../../types';
import type { ModelCatalogProvider } from './types';
import {
  buildInferredCostMetadata,
  buildInferredPerformanceMetadata,
  inferCoreModelTiers,
  inferredConfidenceLevel,
} from './heuristics';

interface AnthropicModelsResponse {
  data?: Array<{
    id: string;
    display_name?: string;
    created_at?: string;
    type?: string;
  }>;
}

function normalizeAnthropicModel(
  model: NonNullable<AnthropicModelsResponse['data']>[number]
): ModelInfo {
  const now = new Date().toISOString();
  const tiers = inferCoreModelTiers(model.id);

  return {
    id: model.id,
    provider: 'anthropic',
    ...tiers,
    context_window: 200000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: `Anthropic model ${model.id}`,
    display_name: model.display_name ?? model.id,
    availability: 'unknown',
    capabilities: ['messages'],
    cost: buildInferredCostMetadata(),
    performance: buildInferredPerformanceMetadata(model.id),
    metadata_confidence: {
      cost: inferredConfidenceLevel(),
      performance: inferredConfidenceLevel(),
      capabilities: 'medium',
    },
    provider_metadata: {
      raw: model as unknown as Record<string, unknown>,
      model_family: model.id.split('-').slice(0, 2).join('-') || 'claude',
      version: model.created_at,
    },
    source: 'system_base',
    updated_at: now,
  };
}

function isAnthropicRoutingModel(modelId: string): boolean {
  return /^claude/i.test(modelId);
}

export class AnthropicModelCatalogProvider implements ModelCatalogProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly anthropicVersion: string;

  constructor(
    apiKey: string,
    baseUrl = 'https://api.anthropic.com/v1',
    timeoutMs = 10000,
    anthropicVersion = '2023-06-01'
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.anthropicVersion = anthropicVersion;
  }

  getProviderName(): string {
    return 'anthropic';
  }

  async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.anthropicVersion,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic model catalog request failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as AnthropicModelsResponse;
      return (data.data ?? [])
        .filter((model) => isAnthropicRoutingModel(model.id))
        .map(normalizeAnthropicModel);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

