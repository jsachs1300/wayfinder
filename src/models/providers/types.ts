import type { ModelInfo } from '../../types';

export interface ModelCatalogProvider {
  getProviderName(): string;
  listModels(): Promise<ModelInfo[]>;
}

export interface ProviderSyncResult {
  provider: string;
  imported: number;
  total_fetched: number;
  error?: string;
}

export interface ModelRegistrySyncSummary {
  started_at: string;
  completed_at: string;
  imported_total: number;
  providers: ProviderSyncResult[];
}

