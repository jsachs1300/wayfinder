import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging';
import { createModelRegistry } from '../../src/models';
import { ModelRegistrySyncService } from '../../src/models/providers/sync-service';
import type { ModelCatalogProvider } from '../../src/models/providers/types';

describe('ModelRegistrySyncService', () => {
  afterEach(() => {
    delete process.env.MODEL_REGISTRY_TRIM_VARIANTS;
  });

  it('imports models from providers into system registry', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');

    const provider: ModelCatalogProvider = {
      getProviderName: () => 'test-provider',
      listModels: async () => [
        {
          id: 'test-provider-model',
          provider: 'test',
          cost_tier: 'medium',
          speed_tier: 'medium',
          context_window: 16000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
      ],
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [provider]);
    const summary = await syncService.syncAll();

    expect(summary.imported_total).toBe(1);
    expect(summary.providers[0]?.provider).toBe('test-provider');
    expect(summary.providers[0]?.imported).toBe(1);
    expect(registry.getModel('test-provider-model')).not.toBeNull();
  });

  it('captures provider errors without failing entire sync', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');

    const failingProvider: ModelCatalogProvider = {
      getProviderName: () => 'failing-provider',
      listModels: async () => {
        throw new Error('provider down');
      },
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [failingProvider]);
    const summary = await syncService.syncAll();

    expect(summary.imported_total).toBe(0);
    expect(summary.providers[0]?.provider).toBe('failing-provider');
    expect(summary.providers[0]?.error).toContain('provider down');
  });

  it('redacts API keys from provider errors', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');

    const failingProvider: ModelCatalogProvider = {
      getProviderName: () => 'failing-provider',
      listModels: async () => {
        throw new Error(
          'request failed with Authorization: Bearer sk-secret-abcdef and key=AIzaSySecretValue'
        );
      },
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [failingProvider]);
    const summary = await syncService.syncAll();

    expect(summary.providers[0]?.error).toContain('[REDACTED]');
    expect(summary.providers[0]?.error).not.toContain('sk-secret-abcdef');
    expect(summary.providers[0]?.error).not.toContain('AIzaSySecretValue');
  });

  it('runs provider sync in parallel', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');

    const delayed = (name: string): ModelCatalogProvider => ({
      getProviderName: () => name,
      listModels: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return [
          {
            id: `${name}-model`,
            provider: 'test',
            cost_tier: 'medium',
            speed_tier: 'medium',
            context_window: 16000,
            available: true,
            status: 'active',
            global_eligible: true,
            source: 'system_base',
          },
        ];
      },
    });

    const syncService = new ModelRegistrySyncService(registry, logger, [
      delayed('provider-a'),
      delayed('provider-b'),
    ]);

    const start = Date.now();
    const summary = await syncService.syncAll();
    const durationMs = Date.now() - start;

    expect(summary.imported_total).toBe(2);
    expect(durationMs).toBeLessThan(220);
  });

  it('reuses in-flight sync for concurrent callers', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');
    let calls = 0;

    const provider: ModelCatalogProvider = {
      getProviderName: () => 'single-provider',
      listModels: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return [];
      },
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [provider]);

    const [first, second] = await Promise.all([syncService.syncAll(), syncService.syncAll()]);
    expect(first.completed_at).toBe(second.completed_at);
    expect(calls).toBe(1);
  });

  it('trims preview/media variants and canonicalizes latest/date suffixes', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');

    const provider: ModelCatalogProvider = {
      getProviderName: () => 'gemini',
      listModels: async () => [
        {
          id: 'gemini-2.5-flash',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
        {
          id: 'gemini-2.5-flash-latest',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
        {
          id: 'gemini-2.5-flash-preview-09-2025',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
        {
          id: 'gemini-2.5-flash-lite',
          provider: 'google',
          cost_tier: 'low',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
        {
          id: 'gemini-2.5-flash-image',
          provider: 'google',
          cost_tier: 'low',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
      ],
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [provider]);
    const summary = await syncService.syncAll();

    const ids = registry.getAllModels().map((model) => model.id);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).toContain('gemini-2.5-flash-lite');
    expect(ids).not.toContain('gemini-2.5-flash-latest');
    expect(ids).not.toContain('gemini-2.5-flash-preview-09-2025');
    expect(ids).not.toContain('gemini-2.5-flash-image');
    expect(summary.providers[0]?.total_fetched).toBe(5);
    expect(summary.providers[0]?.imported).toBe(2);
    expect(summary.providers[0]?.dropped).toBe(3);
    expect(summary.providers[0]?.canonicalized).toBe(0);
  });

  it('can disable catalog trimming with MODEL_REGISTRY_TRIM_VARIANTS=false', async () => {
    process.env.MODEL_REGISTRY_TRIM_VARIANTS = 'false';

    const registry = createModelRegistry();
    const logger = createLogger('error');

    const provider: ModelCatalogProvider = {
      getProviderName: () => 'gemini',
      listModels: async () => [
        {
          id: 'gemini-2.5-flash',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
        {
          id: 'gemini-2.5-flash-preview-09-2025',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
      ],
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [provider]);
    const summary = await syncService.syncAll();

    expect(summary.providers[0]?.imported).toBe(2);
    expect(summary.providers[0]?.dropped).toBe(0);
    expect(registry.getModel('gemini-2.5-flash-preview-09-2025')).not.toBeNull();
  });

  it('counts canonicalized models from retained winners only', async () => {
    const registry = createModelRegistry();
    const logger = createLogger('error');

    const provider: ModelCatalogProvider = {
      getProviderName: () => 'gemini',
      listModels: async () => [
        {
          id: 'gemini-2.5-flash-latest',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
        {
          id: 'gemini-2.5-flash-2025-01-01',
          provider: 'google',
          cost_tier: 'medium',
          speed_tier: 'fast',
          context_window: 1000000,
          available: true,
          status: 'active',
          global_eligible: true,
          source: 'system_base',
        },
      ],
    };

    const syncService = new ModelRegistrySyncService(registry, logger, [provider]);
    const summary = await syncService.syncAll();

    expect(summary.providers[0]?.total_fetched).toBe(2);
    expect(summary.providers[0]?.imported).toBe(1);
    expect(summary.providers[0]?.dropped).toBe(1);
    expect(summary.providers[0]?.canonicalized).toBe(1);
    expect(registry.getModel('gemini-2.5-flash')).not.toBeNull();
  });
});
