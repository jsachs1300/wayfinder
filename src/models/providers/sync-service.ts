import type { Logger } from '../../logging/logger';
import type { ModelRegistry } from '../registry';
import type { ModelCatalogProvider, ModelRegistrySyncSummary, ProviderSyncResult } from './types';

export class ModelRegistrySyncService {
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
    const startedAt = new Date().toISOString();
    const results: ProviderSyncResult[] = [];
    let importedTotal = 0;

    for (const provider of this.providers) {
      const providerName = provider.getProviderName();
      try {
        const models = await provider.listModels();
        for (const model of models) {
          this.modelRegistry.registerModel({
            ...model,
            source: 'system_base',
            updated_at: new Date().toISOString(),
          });
        }

        importedTotal += models.length;
        const result: ProviderSyncResult = {
          provider: providerName,
          imported: models.length,
          total_fetched: models.length,
        };
        results.push(result);
        this.logger.info('Model registry provider sync completed', { ...result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const result: ProviderSyncResult = {
          provider: providerName,
          imported: 0,
          total_fetched: 0,
          error: errorMessage,
        };
        results.push(result);
        this.logger.warn('Model registry provider sync failed', { ...result });
      }
    }

    return {
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      imported_total: importedTotal,
      providers: results,
    };
  }
}
