import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIModelCatalogProvider } from '../../src/models/providers/openai-model-provider';
import { GeminiModelCatalogProvider } from '../../src/models/providers/gemini-model-provider';
import { AnthropicModelCatalogProvider } from '../../src/models/providers/anthropic-model-provider';
import { XAIModelCatalogProvider } from '../../src/models/providers/xai-model-provider';
import { OllamaModelCatalogProvider } from '../../src/models/providers/ollama-model-provider';

describe('Model Catalog Providers', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads and normalizes OpenAI model catalog', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', object: 'model', created: 1730000000, owned_by: 'openai' },
          { id: 'text-embedding-3-small', object: 'model', created: 1730000001, owned_by: 'openai' },
        ],
      }),
    } as Response);

    const provider = new OpenAIModelCatalogProvider('test-key');
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('gpt-4o-mini');
    expect(models[0]?.provider).toBe('openai');
    expect(models[0]?.source).toBe('system_base');
    expect(models[0]?.metadata_confidence?.cost).toBe('low');
  });

  it('loads and normalizes Gemini model catalog with pagination', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              description: 'Fast model',
              inputTokenLimit: 1048576,
              outputTokenLimit: 8192,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
              version: '001',
            },
          ],
          nextPageToken: 'page-2',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'models/text-embedding-004',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
      } as Response);
    global.fetch = fetchMock;

    const provider = new GeminiModelCatalogProvider('test-key');
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('gemini-2.5-flash');
    expect(models[0]?.provider).toBe('google');
    expect(models[0]?.context_window).toBe(1048576);
    expect(models[0]?.max_output_tokens).toBe(8192);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads and normalizes Anthropic model catalog', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
          { id: 'not-a-routing-model', display_name: 'Other' },
        ],
      }),
    } as Response);

    const provider = new AnthropicModelCatalogProvider('test-key');
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('claude-3-5-sonnet-20241022');
    expect(models[0]?.provider).toBe('anthropic');
  });

  it('loads and normalizes xAI model catalog', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'grok-2', object: 'model' },
          { id: 'text-embedding-v1', object: 'model' },
        ],
      }),
    } as Response);

    const provider = new XAIModelCatalogProvider('test-key');
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('grok-2');
    expect(models[0]?.provider).toBe('xai');
  });

  it('loads and normalizes Ollama model catalog', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: 'llama3.2:latest',
            model: 'llama3.2:latest',
            modified_at: '2026-02-08T00:00:00Z',
            details: { family: 'llama' },
          },
        ],
      }),
    } as Response);

    const provider = new OllamaModelCatalogProvider('http://localhost:11434');
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('llama3.2:latest');
    expect(models[0]?.provider).toBe('ollama');
    expect(models[0]?.cost?.input_per_1k).toBe(0);
  });
});
