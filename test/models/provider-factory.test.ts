import { afterEach, describe, expect, it } from 'vitest';
import { createModelCatalogProvidersFromEnv } from '../../src/models/providers';

function resetRegistryProviderEnv(): void {
  delete process.env.MODEL_REGISTRY_OPENAI_ENABLED;
  delete process.env.MODEL_REGISTRY_OPENAI_API_KEY;
  delete process.env.ROUTER_LLM_OPENAI_ENABLED;
  delete process.env.ROUTER_LLM_OPENAI_API_KEY;
  delete process.env.MODEL_REGISTRY_GEMINI_ENABLED;
  delete process.env.MODEL_REGISTRY_GEMINI_API_KEY;
  delete process.env.ROUTER_LLM_GEMINI_ENABLED;
  delete process.env.ROUTER_LLM_GEMINI_API_KEY;
  delete process.env.MODEL_REGISTRY_ANTHROPIC_ENABLED;
  delete process.env.MODEL_REGISTRY_ANTHROPIC_API_KEY;
  delete process.env.MODEL_REGISTRY_XAI_ENABLED;
  delete process.env.MODEL_REGISTRY_XAI_API_KEY;
  delete process.env.MODEL_REGISTRY_OLLAMA_ENABLED;
  delete process.env.MODEL_REGISTRY_OLLAMA_BASE_URL;
  delete process.env.MODEL_REGISTRY_SYNC_TIMEOUT_MS;
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

  it('caps sync timeout at 60s', () => {
    process.env.MODEL_REGISTRY_OPENAI_ENABLED = 'true';
    process.env.MODEL_REGISTRY_OPENAI_API_KEY = 'openai-test';
    process.env.MODEL_REGISTRY_SYNC_TIMEOUT_MS = '120000';

    const providers = createModelCatalogProvidersFromEnv();
    expect(providers).toHaveLength(1);

    const timeoutMs = (providers[0] as any).timeoutMs;
    expect(timeoutMs).toBe(60000);
  });

  it('auto-enables providers when API keys are present', () => {
    process.env.MODEL_REGISTRY_OPENAI_API_KEY = 'openai-test';
    process.env.MODEL_REGISTRY_GEMINI_API_KEY = 'gemini-test';
    process.env.MODEL_REGISTRY_ANTHROPIC_API_KEY = 'anthropic-test';
    process.env.MODEL_REGISTRY_XAI_API_KEY = 'xai-test';

    const providers = createModelCatalogProvidersFromEnv();
    const names = providers.map((provider) => provider.getProviderName());

    expect(names).toEqual(['openai', 'gemini', 'anthropic', 'xai']);
  });

  it('supports explicitly disabling an auto-enabled provider', () => {
    process.env.MODEL_REGISTRY_OPENAI_API_KEY = 'openai-test';
    process.env.MODEL_REGISTRY_GEMINI_API_KEY = 'gemini-test';
    process.env.MODEL_REGISTRY_GEMINI_ENABLED = 'false';

    const providers = createModelCatalogProvidersFromEnv();
    const names = providers.map((provider) => provider.getProviderName());

    expect(names).toContain('openai');
    expect(names).not.toContain('gemini');
  });
});
