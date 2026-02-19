import { describe, expect, it } from 'vitest';
import { createModelRegistry } from '../src/models/registry';
import type { ModelInfo } from '../src/types';

const BASE_MODELS: ModelInfo[] = [
  {
    id: 'alpha-model',
    provider: 'test',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 8000,
    available: true,
    status: 'active',
    global_eligible: true,
  },
  {
    id: 'beta-model',
    provider: 'test',
    cost_tier: 'high',
    speed_tier: 'slow',
    context_window: 64000,
    available: true,
    status: 'active',
    global_eligible: true,
  },
];

describe('Model Registry Layering', () => {
  it('applies system curated override to system model views', () => {
    const registry = createModelRegistry(BASE_MODELS);

    registry.setSystemCuratedOverride('alpha-model', {
      cost_tier: 'medium',
      performance: {
        quality_tier: 'high',
      },
    });

    const alpha = registry.getModel('alpha-model');
    expect(alpha).toBeTruthy();
    expect(alpha?.cost_tier).toBe('medium');
    expect(alpha?.performance?.quality_tier).toBe('high');
  });

  it('merges system curated overrides instead of replacing previous fields', () => {
    const registry = createModelRegistry(BASE_MODELS);

    registry.setSystemCuratedOverride('alpha-model', {
      description: 'first description',
      performance: { strengths: ['reasoning'] },
    });
    registry.setSystemCuratedOverride('alpha-model', {
      speed_tier: 'medium',
    });

    const alpha = registry.getModel('alpha-model');
    expect(alpha?.speed_tier).toBe('medium');
    expect(alpha?.description).toBe('first description');
    expect(alpha?.performance?.strengths).toEqual(['reasoning']);
  });

  it('uses user overlays in augment mode while preserving system models', () => {
    const registry = createModelRegistry(BASE_MODELS);

    registry.setUserModelOverlay('user-1', 'alpha-model', {
      performance: {
        strengths: ['reasoning', 'coding'],
      },
    });

    const effective = registry.getEffectiveModelsForUser('user-1');
    expect(effective.map((m) => m.id).sort()).toEqual(['alpha-model', 'beta-model']);

    const alpha = registry.getEffectiveModelForUser('alpha-model', 'user-1');
    expect(alpha?.performance?.strengths).toEqual(['reasoning', 'coding']);
    expect(alpha?.source).toBe('user_overlay');
  });

  it('merges user overlays instead of replacing previous fields', () => {
    const registry = createModelRegistry(BASE_MODELS);

    registry.setUserModelOverlay('user-merge', 'alpha-model', {
      description: 'custom description',
      performance: { strengths: ['coding'] },
    });
    registry.setUserModelOverlay('user-merge', 'alpha-model', {
      speed_tier: 'medium',
    });

    const alpha = registry.getEffectiveModelForUser('alpha-model', 'user-merge');
    expect(alpha?.description).toBe('custom description');
    expect(alpha?.performance?.strengths).toEqual(['coding']);
    expect(alpha?.speed_tier).toBe('medium');
  });

  it('uses only user overlay entries in override mode', () => {
    const registry = createModelRegistry(BASE_MODELS);

    registry.setUserRegistryMode('user-2', 'override');
    registry.setUserModelOverlay('user-2', 'custom-model', {
      id: 'custom-model',
      provider: 'custom',
      cost_tier: 'low',
      speed_tier: 'fast',
      context_window: 16000,
      available: true,
      status: 'active',
      global_eligible: true,
    });

    const effective = registry.getEffectiveModelsForUser('user-2');
    expect(effective).toHaveLength(1);
    expect(effective[0]?.id).toBe('custom-model');
    expect(effective[0]?.source).toBe('user_overlay');
  });

  it('materializes incomplete overlay-only entries in override mode with defaults', () => {
    const registry = createModelRegistry(BASE_MODELS);

    registry.setUserRegistryMode('user-3', 'override');
    registry.setUserModelOverlay('user-3', 'invalid-model', {
      id: 'invalid-model',
      provider: 'custom',
      // required fields intentionally missing
    });

    const effective = registry.getEffectiveModelsForUser('user-3');
    expect(effective).toHaveLength(1);
    expect(effective[0]?.id).toBe('invalid-model');
    expect(effective[0]?.provider).toBe('custom');
    expect(effective[0]?.available).toBe(true);
    expect(effective[0]?.status).toBe('active');
    expect(effective[0]?.global_eligible).toBe(false);
  });
});
