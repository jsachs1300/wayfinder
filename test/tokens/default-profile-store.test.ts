import { describe, expect, it } from 'vitest';
import { createDefaultTokenProfileStore } from '../../src/tokens/default-profile-store';
import type { ModelInfo } from '../../src/types';
import { selectDefaultEligibleModelIds } from '../../src/tokens/utils';

function model(
  id: string,
  provider: string,
  costTier: 'low' | 'medium' | 'high',
  speedTier: 'fast' | 'medium' | 'slow'
): ModelInfo {
  return {
    id,
    provider,
    cost_tier: costTier,
    speed_tier: speedTier,
    context_window: 128000,
    available: true,
    status: 'active',
    global_eligible: true,
  };
}

describe('DefaultTokenProfileStore', () => {
  const availableModels: ModelInfo[] = [
    model('gpt-4o-mini', 'openai', 'low', 'fast'),
    model('gpt-4o', 'openai', 'high', 'medium'),
    model('gemini-2.5-flash-lite', 'gemini', 'low', 'fast'),
    model('gemini-2.5-pro', 'gemini', 'high', 'slow'),
  ];

  it('bootstraps profile from recommended compact defaults', async () => {
    const store = createDefaultTokenProfileStore();
    const resolved = await store.resolveForModels(availableModels);

    expect(resolved.profile.version).toBe(1);
    expect(resolved.profile.model_ids).toEqual(selectDefaultEligibleModelIds(availableModels));
    expect(resolved.effective_model_ids).toEqual(resolved.profile.model_ids);
    expect(resolved.cache_scope).toBe('global:v1');
  });

  it('updates profile and increments version', async () => {
    const store = createDefaultTokenProfileStore();
    await store.resolveForModels(availableModels);

    const updated = await store.setModelIds(['gpt-4o-mini', 'gemini-2.5-flash-lite'], 'admin-user');
    expect(updated.version).toBe(2);
    expect(updated.updated_by).toBe('admin-user');

    const resolved = await store.resolveForModels(availableModels);
    expect(resolved.profile.version).toBe(2);
    expect(resolved.effective_model_ids).toEqual(['gpt-4o-mini', 'gemini-2.5-flash-lite']);
    expect(resolved.cache_scope).toBe('global:v2');
  });

  it('falls back to recommended defaults when configured profile has no available models', async () => {
    const store = createDefaultTokenProfileStore();
    await store.setModelIds(['non-existent-model'], 'admin-user');

    const resolved = await store.resolveForModels(availableModels);
    expect(resolved.missing_model_ids).toEqual(['non-existent-model']);
    expect(resolved.effective_model_ids).toEqual(selectDefaultEligibleModelIds(availableModels));
  });
});
