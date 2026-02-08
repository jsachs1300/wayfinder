import type { ModelInfo } from '../../types';
import type { ModelCatalogProvider } from './types';
import {
  buildInferredCostMetadata,
  buildInferredPerformanceMetadata,
  inferCoreModelTiers,
  inferredConfidenceLevel,
} from './heuristics';

interface XAIModelsResponse {
  data?: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
  }>;
}

function isXAIRoutingModel(modelId: string): boolean {
  return /^(grok|xai)/i.test(modelId);
}

function normalizeXAIModel(model: NonNullable<XAIModelsResponse['data']>[number]): ModelInfo {
  const now = new Date().toISOString();
  const tiers = inferCoreModelTiers(model.id);

  return {
    id: model.id,
    provider: 'xai',
    ...tiers,
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: `xAI model ${model.id}`,
    display_name: model.id,
    availability: 'unknown',
    capabilities: ['text-generation'],
    cost: buildInferredCostMetadata(),
    performance: buildInferredPerformanceMetadata(model.id),
    metadata_confidence: {
      cost: inferredConfidenceLevel(),
      performance: inferredConfidenceLevel(),
      capabilities: 'unknown',
    },
    provider_metadata: {
      raw: model as unknown as Record<string, unknown>,
      model_family: model.id.split('-')[0],
      version: model.created ? String(model.created) : undefined,
    },
    source: 'system_base',
    updated_at: now,
  };
}

export class XAIModelCatalogProvider implements ModelCatalogProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, baseUrl = 'https://api.x.ai/v1', timeoutMs = 10000) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  getProviderName(): string {
    return 'xai';
  }

  async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`xAI model catalog request failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as XAIModelsResponse;
      return (data.data ?? [])
        .filter((model) => isXAIRoutingModel(model.id))
        .map(normalizeXAIModel);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

