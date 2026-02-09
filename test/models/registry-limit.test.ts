import { describe, expect, it } from 'vitest';
import { createModelRegistry } from '../../src/models/registry';
import type { ModelInfo } from '../../src/types';

function makeModel(id: string): ModelInfo {
  return {
    id,
    provider: 'test',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 8000,
    available: true,
    status: 'active',
    global_eligible: true,
    updated_at: new Date().toISOString(),
  };
}

function makeModelWithStatus(id: string, status: ModelInfo['status']): ModelInfo {
  return {
    ...makeModel(id),
    status,
  };
}

describe('Model registry max size pruning', () => {
  it('enforces MODEL_REGISTRY_MAX_MODELS when registering new models', () => {
    const originalMax = process.env.MODEL_REGISTRY_MAX_MODELS;
    process.env.MODEL_REGISTRY_MAX_MODELS = '3';

    const registry = createModelRegistry([makeModel('m1'), makeModel('m2'), makeModel('m3')]);
    registry.registerModel(makeModel('m4'));

    const all = registry.getAllModels();
    expect(all.length).toBeLessThanOrEqual(3);

    if (originalMax === undefined) {
      delete process.env.MODEL_REGISTRY_MAX_MODELS;
    } else {
      process.env.MODEL_REGISTRY_MAX_MODELS = originalMax;
    }
  });

  it('does not prune curated override-backed ids first', () => {
    const originalMax = process.env.MODEL_REGISTRY_MAX_MODELS;
    process.env.MODEL_REGISTRY_MAX_MODELS = '2';

    const registry = createModelRegistry([makeModel('m1'), makeModel('m2')]);
    registry.setSystemCuratedOverride('m1', { description: 'protected override' });
    registry.registerModel(makeModel('m3'));

    const allIds = registry.getAllModels().map((m) => m.id);
    expect(allIds).toContain('m1');
    expect(allIds.length).toBeLessThanOrEqual(2);

    if (originalMax === undefined) {
      delete process.env.MODEL_REGISTRY_MAX_MODELS;
    } else {
      process.env.MODEL_REGISTRY_MAX_MODELS = originalMax;
    }
  });

  it('allows disabled protected models to be pruned', () => {
    const originalMax = process.env.MODEL_REGISTRY_MAX_MODELS;
    process.env.MODEL_REGISTRY_MAX_MODELS = '2';

    const registry = createModelRegistry([
      makeModel('active-protected'),
      makeModelWithStatus('disabled-protected', 'disabled'),
    ]);

    registry.setSystemCuratedOverride('active-protected', { description: 'keep me' });
    registry.setSystemCuratedOverride('disabled-protected', { description: 'can be pruned' });

    registry.registerModel(makeModel('new-active'));

    const allIds = registry.getAllModels().map((m) => m.id);
    expect(allIds).toContain('active-protected');
    expect(allIds).toContain('new-active');
    expect(allIds).not.toContain('disabled-protected');
    expect(allIds.length).toBeLessThanOrEqual(2);

    if (originalMax === undefined) {
      delete process.env.MODEL_REGISTRY_MAX_MODELS;
    } else {
      process.env.MODEL_REGISTRY_MAX_MODELS = originalMax;
    }
  });
});
