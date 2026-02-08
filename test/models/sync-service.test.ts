import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging';
import { createModelRegistry } from '../../src/models';
import { ModelRegistrySyncService } from '../../src/models/providers/sync-service';
import type { ModelCatalogProvider } from '../../src/models/providers/types';

describe('ModelRegistrySyncService', () => {
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
});

