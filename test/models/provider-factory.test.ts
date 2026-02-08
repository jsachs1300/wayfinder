import { afterEach, describe, expect, it } from 'vitest';
import { createModelCatalogProvidersFromEnv } from '../../src/models/providers';

function resetRegistryProviderEnv(): void {
  delete process.env.MODEL_REGISTRY_OPENAI_ENABLED;
  delete process.env.MODEL_REGISTRY_OPENAI_API_KEY;
  delete process.env.MODEL_REGISTRY_GEMINI_ENABLED;
  delete process.env.MODEL_REGISTRY_GEMINI_API_KEY;
  delete process.env.MODEL_REGISTRY_ANTHROPIC_ENABLED;
  delete process.env.MODEL_REGISTRY_ANTHROPIC_API_KEY;
  delete process.env.MODEL_REGISTRY_XAI_ENABLED;
  delete process.env.MODEL_REGISTRY_XAI_API_KEY;
  delete process.env.MODEL_REGISTRY_OLLAMA_ENABLED;
  delete process.env.MODEL_REGISTRY_OLLAMA_BASE_URL;
}

describe('Model catalog provider factory', () => {
  afterEach(() => {
    resetRegistryProviderEnv();
  });

  it('creates providers for enabled env configurations', () => {
    process.env.MODEL_REGISTRY_OPENAI_ENABLED = 'true';
    process.env.MODEL_REGISTRY_OPENAI_API_KEY = 'openai-test';
    process.env.MODEL_REGISTRY_GEMINI_ENABLED = 'true';
    process.env.MODEL_REGISTRY_GEMINI_API_KEY = 'gemini-test';
    process.env.MODEL_REGISTRY_ANTHROPIC_ENABLED = 'true';
    process.env.MODEL_REGISTRY_ANTHROPIC_API_KEY = 'anthropic-test';
    process.env.MODEL_REGISTRY_XAI_ENABLED = 'true';
    process.env.MODEL_REGISTRY_XAI_API_KEY = 'xai-test';
    process.env.MODEL_REGISTRY_OLLAMA_ENABLED = 'true';
    process.env.MODEL_REGISTRY_OLLAMA_BASE_URL = 'http://localhost:11434';

    const providers = createModelCatalogProvidersFromEnv();
    const names = providers.map((provider) => provider.getProviderName());

    expect(names).toEqual(['openai', 'gemini', 'anthropic', 'xai', 'ollama']);
  });
});

