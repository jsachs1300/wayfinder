import type Redis from 'ioredis';
import type { Logger } from '../logging/logger';
import type { ModelInfo } from '../types';
import { selectDefaultEligibleModelIds } from './utils';

const DEFAULT_TOKEN_PROFILE_KEY = 'wayfinder:default_token_profile:v1';
const DEFAULT_TOKEN_PROFILE_UPDATE_MAX_RETRIES = 5;

export interface DefaultTokenModelProfile {
  model_ids: string[];
  version: number;
  updated_at: string;
  updated_by?: string;
}

export interface ResolvedDefaultTokenModelProfile {
  profile: DefaultTokenModelProfile;
  effective_model_ids: string[];
  missing_model_ids: string[];
  cache_scope: string;
}

export interface DefaultTokenProfileStore {
  getProfile(): Promise<DefaultTokenModelProfile | null>;
  resolveForModels(availableModels: readonly ModelInfo[]): Promise<ResolvedDefaultTokenModelProfile>;
  setModelIds(modelIds: string[], updatedBy?: string): Promise<DefaultTokenModelProfile>;
  recommendModelIds(availableModels: readonly ModelInfo[]): string[];
}

interface PersistedDefaultTokenModelProfile {
  model_ids: unknown;
  version: unknown;
  updated_at: unknown;
  updated_by?: unknown;
}

function normalizeModelIds(modelIds: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const modelId of modelIds) {
    const trimmed = modelId.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function toCacheScope(version: number): string {
  return `global:v${version}`;
}

function parsePersistedProfile(raw: string): DefaultTokenModelProfile | null {
  const parsed = JSON.parse(raw) as PersistedDefaultTokenModelProfile;
  if (!Array.isArray(parsed.model_ids) || typeof parsed.version !== 'number' || typeof parsed.updated_at !== 'string') {
    return null;
  }

  const modelIds = parsed.model_ids.filter((value): value is string => typeof value === 'string');

  return {
    model_ids: normalizeModelIds(modelIds),
    version: Math.max(1, Math.floor(parsed.version)),
    updated_at: parsed.updated_at,
    updated_by: typeof parsed.updated_by === 'string' ? parsed.updated_by : undefined,
  };
}

function buildBootstrapProfile(availableModels: readonly ModelInfo[]): DefaultTokenModelProfile {
  return {
    model_ids: selectDefaultEligibleModelIds(availableModels),
    version: 1,
    updated_at: new Date().toISOString(),
    updated_by: 'system:auto-bootstrap',
  };
}

function resolveEffectiveModelIds(
  profile: DefaultTokenModelProfile,
  availableModels: readonly ModelInfo[]
): { effective_model_ids: string[]; missing_model_ids: string[] } {
  const availableIds = new Set(availableModels.map((model) => model.id));
  const effectiveModelIds = profile.model_ids.filter((id) => availableIds.has(id));
  const missingModelIds = profile.model_ids.filter((id) => !availableIds.has(id));

  if (effectiveModelIds.length > 0) {
    return {
      effective_model_ids: effectiveModelIds,
      missing_model_ids: missingModelIds,
    };
  }

  return {
    effective_model_ids: selectDefaultEligibleModelIds(availableModels),
    missing_model_ids: missingModelIds,
  };
}

class InMemoryDefaultTokenProfileStore implements DefaultTokenProfileStore {
  private profile: DefaultTokenModelProfile | null = null;

  async getProfile(): Promise<DefaultTokenModelProfile | null> {
    return this.profile ? { ...this.profile, model_ids: [...this.profile.model_ids] } : null;
  }

  recommendModelIds(availableModels: readonly ModelInfo[]): string[] {
    return selectDefaultEligibleModelIds(availableModels);
  }

  async setModelIds(modelIds: string[], updatedBy?: string): Promise<DefaultTokenModelProfile> {
    const normalized = normalizeModelIds(modelIds);
    if (normalized.length === 0) {
      throw new Error('Default token profile requires at least one model id');
    }

    const nextVersion = (this.profile?.version ?? 0) + 1;
    this.profile = {
      model_ids: normalized,
      version: nextVersion,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    };
    return { ...this.profile, model_ids: [...this.profile.model_ids] };
  }

  async resolveForModels(availableModels: readonly ModelInfo[]): Promise<ResolvedDefaultTokenModelProfile> {
    if (!this.profile) {
      this.profile = buildBootstrapProfile(availableModels);
    }

    const resolved = resolveEffectiveModelIds(this.profile, availableModels);
    return {
      profile: { ...this.profile, model_ids: [...this.profile.model_ids] },
      effective_model_ids: resolved.effective_model_ids,
      missing_model_ids: resolved.missing_model_ids,
      cache_scope: toCacheScope(this.profile.version),
    };
  }
}

class RedisDefaultTokenProfileStore implements DefaultTokenProfileStore {
  constructor(private readonly redis: Redis, private readonly logger?: Logger) {}

  private async persistProfile(profile: DefaultTokenModelProfile): Promise<void> {
    await this.redis.set(DEFAULT_TOKEN_PROFILE_KEY, JSON.stringify(profile));
  }

  async getProfile(): Promise<DefaultTokenModelProfile | null> {
    const raw = await this.redis.get(DEFAULT_TOKEN_PROFILE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return parsePersistedProfile(raw);
    } catch (error) {
      this.logger?.warn('Failed to parse default token profile; ignoring persisted value', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  recommendModelIds(availableModels: readonly ModelInfo[]): string[] {
    return selectDefaultEligibleModelIds(availableModels);
  }

  async setModelIds(modelIds: string[], updatedBy?: string): Promise<DefaultTokenModelProfile> {
    const normalized = normalizeModelIds(modelIds);
    if (normalized.length === 0) {
      throw new Error('Default token profile requires at least one model id');
    }

    for (let attempt = 1; attempt <= DEFAULT_TOKEN_PROFILE_UPDATE_MAX_RETRIES; attempt += 1) {
      await this.redis.watch(DEFAULT_TOKEN_PROFILE_KEY);
      try {
        const current = await this.getProfile();
        const profile: DefaultTokenModelProfile = {
          model_ids: normalized,
          version: (current?.version ?? 0) + 1,
          updated_at: new Date().toISOString(),
          updated_by: updatedBy,
        };

        const transaction = this.redis.multi();
        transaction.set(DEFAULT_TOKEN_PROFILE_KEY, JSON.stringify(profile));
        const execResult = await transaction.exec();

        if (execResult !== null) {
          return profile;
        }

        if (attempt < DEFAULT_TOKEN_PROFILE_UPDATE_MAX_RETRIES) {
          this.logger?.warn('Default token profile update conflicted, retrying', {
            attempt,
            max_retries: DEFAULT_TOKEN_PROFILE_UPDATE_MAX_RETRIES,
          });
          continue;
        }
      } finally {
        await this.redis.unwatch();
      }
    }

    throw new Error('Failed to update default token profile due to concurrent updates');
  }

  async resolveForModels(availableModels: readonly ModelInfo[]): Promise<ResolvedDefaultTokenModelProfile> {
    let profile = await this.getProfile();

    if (!profile) {
      profile = buildBootstrapProfile(availableModels);
      await this.persistProfile(profile);
    }

    const resolved = resolveEffectiveModelIds(profile, availableModels);
    return {
      profile,
      effective_model_ids: resolved.effective_model_ids,
      missing_model_ids: resolved.missing_model_ids,
      cache_scope: toCacheScope(profile.version),
    };
  }
}

export function createDefaultTokenProfileStore(
  redis?: Redis,
  logger?: Logger
): DefaultTokenProfileStore {
  if (redis) {
    return new RedisDefaultTokenProfileStore(redis, logger);
  }
  return new InMemoryDefaultTokenProfileStore();
}
