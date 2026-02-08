import type { Logger } from '../../logging/logger';
import type { ModelRegistry } from '../registry';
import type { ModelCatalogProvider, ModelRegistrySyncSummary, ProviderSyncResult } from './types';

function sanitizeSyncError(message: string): string {
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(x-api-key[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, 'sk-[REDACTED]')
    .replace(/(AIza[0-9A-Za-z_-]{8,})/g, 'AIza[REDACTED]');
}

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
        const models = await provider.listModels();
        for (const model of models) {
          this.modelRegistry.registerModel({
            ...model,
            source: 'system_base',
            updated_at: new Date().toISOString(),
          });
        }

        const result: ProviderSyncResult = {
          provider: providerName,
          imported: models.length,
          total_fetched: models.length,
        };
        this.logger.info('Model registry provider sync completed', { ...result });
        return result;
      } catch (error) {
        const errorMessage = sanitizeSyncError(
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
