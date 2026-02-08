import type { ModelInfo } from '../../types';
import type { ModelCatalogProvider } from './types';
import {
  buildInferredCostMetadata,
  buildInferredPerformanceMetadata,
  inferCoreModelTiers,
  inferredConfidenceLevel,
} from './heuristics';

interface OllamaTagModel {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    family?: string;
    families?: string[];
    format?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

function normalizeOllamaModel(model: OllamaTagModel): ModelInfo | null {
  const modelId = model.model || model.name;
  if (!modelId) {
    return null;
  }
  const now = new Date().toISOString();
  const tiers = inferCoreModelTiers(modelId);

  return {
    id: modelId,
    provider: 'ollama',
    ...tiers,
    context_window: 8192,
    available: true,
    status: 'active',
    global_eligible: true,
    description: `Ollama model ${modelId}`,
    display_name: model.name ?? modelId,
    availability: 'generally_available',
    capabilities: ['local-inference'],
    cost: {
      ...buildInferredCostMetadata(),
      input_per_1k: 0,
      output_per_1k: 0,
      currency: 'USD',
    },
    performance: buildInferredPerformanceMetadata(modelId),
    metadata_confidence: {
      cost: 'medium',
      performance: inferredConfidenceLevel(),
      capabilities: 'medium',
    },
    provider_metadata: {
      raw: model as unknown as Record<string, unknown>,
      model_family: model.details?.family || modelId.split(':')[0],
      version: model.modified_at,
    },
    source: 'system_base',
    updated_at: now,
  };
}

export class OllamaModelCatalogProvider implements ModelCatalogProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(baseUrl = 'http://localhost:11434', timeoutMs = 10000, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.apiKey = apiKey;
  }

  getProviderName(): string {
    return 'ollama';
  }

  async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama model catalog request failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as OllamaTagsResponse;
      const normalized = (data.models ?? [])
        .map(normalizeOllamaModel)
        .filter((model): model is ModelInfo => model !== null);
      return normalized;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

