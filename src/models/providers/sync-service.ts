import type { Logger } from '../../logging/logger';
import type { ModelRegistry } from '../registry';
import type { ModelCatalogProvider, ModelRegistrySyncSummary, ProviderSyncResult } from './types';
import { sanitizeSensitive } from './security';
import { trimProviderCatalog } from './pruning';

export class ModelRegistrySyncService {
  private syncInFlight?: Promise<ModelRegistrySyncSummary>;

  constructor(
    private readonly modelRegistry: ModelRegistry,
    private readonly logger: Logger,
    private readonly providers: ModelCatalogProvider[]
  ) {}

  getProviderNames(): string[] {
    return this.providers.map((provider) => provider.getProviderName());
  }

  hasProviders(): boolean {
    return this.providers.length > 0;
  }

  async syncAll(): Promise<ModelRegistrySyncSummary> {
    if (this.syncInFlight) {
      this.logger.info('Model registry sync already in progress; reusing in-flight run');
      return this.syncInFlight;
    }

    this.syncInFlight = this.syncAllInternal();
    try {
      return await this.syncInFlight;
    } finally {
      this.syncInFlight = undefined;
    }
  }

  private async syncAllInternal(): Promise<ModelRegistrySyncSummary> {
    const startedAt = new Date().toISOString();
    const providerTasks = this.providers.map(async (provider): Promise<ProviderSyncResult> => {
      const providerName = provider.getProviderName();
      try {
        const fetchedModels = await provider.listModels();
        const trimmed = trimProviderCatalog(providerName, fetchedModels);

        for (const model of trimmed.models) {
          this.modelRegistry.registerModel({
            ...model,
            source: 'system_base',
            updated_at: new Date().toISOString(),
          });
        }

        const result: ProviderSyncResult = {
          provider: providerName,
          imported: trimmed.models.length,
          total_fetched: fetchedModels.length,
          dropped: trimmed.dropped,
          canonicalized: trimmed.canonicalized,
        };
        this.logger.info('Model registry provider sync completed', { ...result });
        return result;
      } catch (error) {
        const errorMessage = sanitizeSensitive(
          error instanceof Error ? error.message : String(error)
        );
        const result: ProviderSyncResult = {
          provider: providerName,
          imported: 0,
          total_fetched: 0,
          error: errorMessage,
        };
        this.logger.warn('Model registry provider sync failed', { ...result });
        return result;
      }
    });

    const results = await Promise.all(providerTasks);
    const importedTotal = results.reduce((total, result) => total + result.imported, 0);

    return {
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      imported_total: importedTotal,
      providers: results,
    };
  }
}
