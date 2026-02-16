import type { ModelCatalogProvider } from './types';
import { OpenAIModelCatalogProvider } from './openai-model-provider';
import { GeminiModelCatalogProvider } from './gemini-model-provider';
import { AnthropicModelCatalogProvider } from './anthropic-model-provider';
import { XAIModelCatalogProvider } from './xai-model-provider';
import { OllamaModelCatalogProvider } from './ollama-model-provider';

const MAX_MODEL_REGISTRY_SYNC_TIMEOUT_MS = 60000;

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, MAX_MODEL_REGISTRY_SYNC_TIMEOUT_MS);
}

function isProviderEnabled(flagValue: string | undefined, hasCredentials: boolean): boolean {
  if (!hasCredentials) {
    return false;
  }
  if (flagValue === 'false') {
    return false;
  }
  if (flagValue === 'true') {
    return true;
  }
  // Default to enabled when credentials are present.
  return true;
}

function shouldEnableProvider(
  registryFlag: string | undefined,
  routerFlag: string | undefined,
  hasCredentials: boolean
): boolean {
  if (!hasCredentials) {
    return false;
  }
  if (registryFlag === 'true') {
    return true;
  }
  if (registryFlag === 'false') {
    return false;
  }
  if (routerFlag === 'true') {
    return true;
  }
  if (routerFlag === 'false') {
    return false;
  }
  return true;
}

export function createModelCatalogProvidersFromEnv(): ModelCatalogProvider[] {
  const providers: ModelCatalogProvider[] = [];
  const timeoutMs = parseTimeoutMs(process.env.MODEL_REGISTRY_SYNC_TIMEOUT_MS, 10000);

  const openaiApiKey =
    process.env.MODEL_REGISTRY_OPENAI_API_KEY || process.env.ROUTER_LLM_OPENAI_API_KEY;
  if (openaiApiKey && shouldEnableProvider(
    process.env.MODEL_REGISTRY_OPENAI_ENABLED,
    process.env.ROUTER_LLM_OPENAI_ENABLED,
    true
  )) {
    providers.push(
      new OpenAIModelCatalogProvider(
        openaiApiKey,
        process.env.MODEL_REGISTRY_OPENAI_BASE_URL || 'https://api.openai.com/v1',
        timeoutMs
      )
    );
  }

  const geminiApiKey =
    process.env.MODEL_REGISTRY_GEMINI_API_KEY || process.env.ROUTER_LLM_GEMINI_API_KEY;
  if (geminiApiKey && shouldEnableProvider(
    process.env.MODEL_REGISTRY_GEMINI_ENABLED,
    process.env.ROUTER_LLM_GEMINI_ENABLED,
    true
  )) {
    providers.push(
      new GeminiModelCatalogProvider(
        geminiApiKey,
        process.env.MODEL_REGISTRY_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
        timeoutMs
      )
    );
  }

  const anthropicApiKey = process.env.MODEL_REGISTRY_ANTHROPIC_API_KEY;
  if (anthropicApiKey && isProviderEnabled(process.env.MODEL_REGISTRY_ANTHROPIC_ENABLED, !!anthropicApiKey)) {
    providers.push(
      new AnthropicModelCatalogProvider(
        anthropicApiKey,
        process.env.MODEL_REGISTRY_ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
        timeoutMs,
        process.env.MODEL_REGISTRY_ANTHROPIC_VERSION || '2023-06-01'
      )
    );
  }

  const xaiApiKey = process.env.MODEL_REGISTRY_XAI_API_KEY;
  if (xaiApiKey && isProviderEnabled(process.env.MODEL_REGISTRY_XAI_ENABLED, !!xaiApiKey)) {
    providers.push(
      new XAIModelCatalogProvider(
        xaiApiKey,
        process.env.MODEL_REGISTRY_XAI_BASE_URL || 'https://api.x.ai/v1',
        timeoutMs
      )
    );
  }

  const ollamaEnabled = process.env.MODEL_REGISTRY_OLLAMA_ENABLED === 'true';
  if (ollamaEnabled) {
    providers.push(
      new OllamaModelCatalogProvider(
        process.env.MODEL_REGISTRY_OLLAMA_BASE_URL || 'http://localhost:11434',
        timeoutMs,
        process.env.MODEL_REGISTRY_OLLAMA_API_KEY
      )
    );
  }

  return providers;
}

export { OpenAIModelCatalogProvider } from './openai-model-provider';
export { GeminiModelCatalogProvider } from './gemini-model-provider';
export { AnthropicModelCatalogProvider } from './anthropic-model-provider';
export { XAIModelCatalogProvider } from './xai-model-provider';
export { OllamaModelCatalogProvider } from './ollama-model-provider';
export { ModelRegistrySyncService } from './sync-service';
export type { ModelCatalogProvider, ModelRegistrySyncSummary, ProviderSyncResult } from './types';
