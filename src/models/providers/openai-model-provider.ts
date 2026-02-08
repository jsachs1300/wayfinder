import type { ModelInfo } from '../../types';
import type { ModelCatalogProvider } from './types';
import {
  buildInferredCostMetadata,
  buildInferredPerformanceMetadata,
  inferCoreModelTiers,
  inferredConfidenceLevel,
} from './heuristics';
import { buildCatalogRequestError, validateProviderApiKey } from './security';

interface OpenAIModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: string;
    created?: number;
    owned_by?: string;
  }>;
}

const OPENAI_EXCLUDE_PATTERN = /(embedding|moderation|whisper|tts|dall|realtime|audio)/i;

function isLikelyGenerativeModel(modelId: string): boolean {
  if (!modelId || OPENAI_EXCLUDE_PATTERN.test(modelId)) {
    return false;
  }
  return /(^gpt|^o\d|^o1|^o3|^o4|^chatgpt|^codex)/i.test(modelId);
}

function normalizeOpenAIModel(model: OpenAIModelsResponse['data'][number]): ModelInfo {
  const now = new Date().toISOString();
  const tiers = inferCoreModelTiers(model.id);

  return {
    id: model.id,
    provider: 'openai',
    ...tiers,
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
    description: `OpenAI model ${model.id}`,
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
      raw: {
        object: model.object,
        created: model.created,
        owned_by: model.owned_by,
      },
      model_family: model.id.split('-')[0],
      version: model.created ? String(model.created) : undefined,
    },
    source: 'system_base',
    updated_at: now,
  };
}

export class OpenAIModelCatalogProvider implements ModelCatalogProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1', timeoutMs = 10000) {
    this.apiKey = validateProviderApiKey('OpenAI', apiKey);
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  getProviderName(): string {
    return 'openai';
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
        throw await buildCatalogRequestError('OpenAI', response);
      }

      const data = (await response.json()) as OpenAIModelsResponse;
      return data.data
        .filter((model) => isLikelyGenerativeModel(model.id))
        .map(normalizeOpenAIModel);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
