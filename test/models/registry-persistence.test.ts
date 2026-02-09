import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../src/types';
import { createPersistentModelRegistry } from '../../src/models/registry';

class FakeRedis {
  private store = new Map<string, string>();
  public setDelayMs = 0;

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    if (this.setDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.setDelayMs));
    }
    this.store.set(key, value);
    return 'OK';
  }
}

const BASE_MODELS: ModelInfo[] = [
  {
    id: 'base-model',
    provider: 'test',
    cost_tier: 'low',
    speed_tier: 'fast',
    context_window: 8192,
    available: true,
    status: 'active',
    global_eligible: true,
  },
];

describe('Model Registry Redis Persistence', () => {
  it('persists mutable registry layers and reloads them on startup', async () => {
    const redis = new FakeRedis() as any;
    const registry = await createPersistentModelRegistry(redis, undefined, BASE_MODELS);

    registry.setSystemCuratedOverride('base-model', { description: 'curated description' });
    registry.setUserRegistryMode('user-1', 'override');
    registry.setUserModelOverlay('user-1', 'custom-model', {
      id: 'custom-model',
      provider: 'custom',
      cost_tier: 'medium',
      speed_tier: 'medium',
      context_window: 16000,
      available: true,
      status: 'active',
      global_eligible: true,
      description: 'overlay description',
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const loaded = await createPersistentModelRegistry(redis, undefined, BASE_MODELS);

    expect(loaded.getModel('base-model')?.description).toBe('curated description');
    expect(loaded.getUserRegistryMode('user-1')).toBe('override');

    const effective = loaded.getEffectiveModelsForUser('user-1');
    expect(effective).toHaveLength(1);
    expect(effective[0]?.id).toBe('custom-model');
    expect(effective[0]?.description).toBe('overlay description');
  });

  it('queues persistence changes that happen during an in-flight save', async () => {
    const redis = new FakeRedis() as any;
    redis.setDelayMs = 60;

    const registry = await createPersistentModelRegistry(redis, undefined, BASE_MODELS);
    registry.setSystemCuratedOverride('base-model', { description: 'v1' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    registry.setSystemCuratedOverride('base-model', { description: 'v2' });

    await new Promise((resolve) => setTimeout(resolve, 180));

    const loaded = await createPersistentModelRegistry(redis, undefined, BASE_MODELS);
    expect(loaded.getModel('base-model')?.description).toBe('v2');
  });
});
