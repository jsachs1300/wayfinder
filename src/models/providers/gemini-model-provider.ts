import type { ModelInfo } from '../../types';
import type { ModelCatalogProvider } from './types';
import {
  buildInferredCostMetadata,
  buildInferredPerformanceMetadata,
  inferCoreModelTiers,
  inferredConfidenceLevel,
} from './heuristics';

interface GeminiModel {
  name: string; // e.g. "models/gemini-2.5-flash"
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  version?: string;
}

interface GeminiModelsResponse {
  models?: GeminiModel[];
  nextPageToken?: string;
}

function extractModelId(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

function isSupportedForRouting(model: GeminiModel): boolean {
  if (!model.name) {
    return false;
  }
  const modelId = extractModelId(model.name);
  if (!modelId.startsWith('gemini')) {
    return false;
  }
  const methods = model.supportedGenerationMethods ?? [];
  return methods.includes('generateContent');
}

function normalizeGeminiModel(model: GeminiModel): ModelInfo {
  const now = new Date().toISOString();
  const modelId = extractModelId(model.name);
  const tiers = inferCoreModelTiers(modelId);
  const generationMethods = model.supportedGenerationMethods ?? [];

  return {
    id: modelId,
    provider: 'google',
    ...tiers,
    context_window: model.inputTokenLimit ?? 128000,
    max_output_tokens: model.outputTokenLimit,
    available: true,
    status: 'active',
    global_eligible: true,
    description: model.description ?? `Google Gemini model ${modelId}`,
    display_name: model.displayName ?? modelId,
    availability: 'unknown',
    capabilities: generationMethods,
    capability_flags: {
      json_mode: generationMethods.includes('generateContent'),
    },
    cost: buildInferredCostMetadata(),
    performance: buildInferredPerformanceMetadata(modelId),
    metadata_confidence: {
      cost: inferredConfidenceLevel(),
      performance: inferredConfidenceLevel(),
      capabilities: 'medium',
    },
    provider_metadata: {
      raw: model as unknown as Record<string, unknown>,
      model_family: modelId.split('-').slice(0, 2).join('-') || 'gemini',
      version: model.version,
    },
    source: 'system_base',
    updated_at: now,
  };
}

export class GeminiModelCatalogProvider implements ModelCatalogProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs = 10000
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  getProviderName(): string {
    return 'gemini';
  }

  async listModels(): Promise<ModelInfo[]> {
    const collected: GeminiModel[] = [];
    let pageToken: string | undefined;

    do {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const url = new URL(`${this.baseUrl}/models`);
        if (pageToken) {
          url.searchParams.set('pageToken', pageToken);
        }

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'x-goog-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Gemini model catalog request failed (${response.status}): ${body}`);
        }

        const data = (await response.json()) as GeminiModelsResponse;
        const pageModels = data.models ?? [];
        collected.push(...pageModels);
        pageToken = data.nextPageToken;
      } finally {
        clearTimeout(timeoutId);
      }
    } while (pageToken);

    return collected
      .filter(isSupportedForRouting)
      .map(normalizeGeminiModel);
  }
}

