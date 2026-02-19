import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminModelRegistryRoutes, createModelRegistry, createUserModelRegistryRoutes } from '../src/models';
import { createLogger } from '../src/logging';
import type { User } from '../src/users/types';
import { InMemoryTokenStore } from '../src/tokens/store';
import { createUserTokenRoutes } from '../src/tokens/user-routes';

function createMockUser(id: string): User {
  const now = new Date().toISOString();
  return {
    id,
    email: `${id}@example.com`,
    password_hash: 'hashed',
    tier: 'free',
    status: 'active',
    org_id: null,
    billing_customer_id: null,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
}

describe('Model Registry Routes', () => {
  const logger = createLogger('error');
  let modelRegistry = createModelRegistry();

  beforeEach(() => {
    modelRegistry = createModelRegistry();
  });

  it('supports admin curated override lifecycle', async () => {
    const app = express();
    app.use(express.json());
    app.use('/admin/registry', createAdminModelRegistryRoutes(modelRegistry, logger));

    const listBefore = await request(app).get('/admin/registry');
    expect(listBefore.status).toBe(200);
    expect(listBefore.body.count).toBeGreaterThan(0);

    const create = await request(app)
      .post('/admin/registry')
      .send({
        id: 'gpt-4o-mini',
        description: 'Curated description override',
      });
    expect(create.status).toBe(201);
    expect(create.body.model.id).toBe('gpt-4o-mini');
    expect(create.body.model.description).toBe('Curated description override');

    const patch = await request(app)
      .patch('/admin/registry/gpt-4o-mini')
      .send({
        speed_tier: 'medium',
      });
    expect(patch.status).toBe(200);
    expect(patch.body.model.speed_tier).toBe('medium');

    const remove = await request(app).delete('/admin/registry/gpt-4o-mini');
    expect(remove.status).toBe(204);
  });

  it('returns 503 for admin refresh when no providers are configured', async () => {
    const app = express();
    app.use(express.json());
    app.use('/admin/registry', createAdminModelRegistryRoutes(modelRegistry, logger));

    const response = await request(app).post('/admin/registry/refresh').send({});
    expect(response.status).toBe(503);
  });

  it('supports admin model registry refresh when sync service is configured', async () => {
    const syncService = {
      hasProviders: () => true,
      getProviderNames: () => ['openai', 'gemini'],
      syncAll: vi.fn().mockResolvedValue({
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        imported_total: 2,
        providers: [
          { provider: 'openai', imported: 1, total_fetched: 1 },
          { provider: 'gemini', imported: 1, total_fetched: 1 },
        ],
      }),
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/admin/registry',
      createAdminModelRegistryRoutes(modelRegistry, logger, syncService as any)
    );

    const response = await request(app).post('/admin/registry/refresh').send({});
    expect(response.status).toBe(200);
    expect(response.body.imported_total).toBe(2);
    expect(response.body.configured_providers).toEqual(['openai', 'gemini']);
  });

  it('returns 401 for user registry routes without authenticated user', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/registry', createUserModelRegistryRoutes(modelRegistry, logger));

    const response = await request(app).get('/api/registry');
    expect(response.status).toBe(401);
  });

  it('supports user registry mode and overlay in override mode', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = createMockUser('user-1');
      next();
    });
    app.use('/api/registry', createUserModelRegistryRoutes(modelRegistry, logger));

    const setMode = await request(app)
      .post('/api/registry/mode')
      .send({ mode: 'override' });
    expect(setMode.status).toBe(200);
    expect(setMode.body.registry_mode).toBe('override');

    const createOverlay = await request(app)
      .post('/api/registry')
      .send({
        id: 'custom-user-model',
        provider: 'custom',
        cost_tier: 'low',
        speed_tier: 'fast',
        context_window: 16000,
        available: true,
        status: 'active',
        global_eligible: true,
        description: 'User custom model',
      });
    expect(createOverlay.status).toBe(201);
    expect(createOverlay.body.model.id).toBe('custom-user-model');

    const list = await request(app).get('/api/registry');
    expect(list.status).toBe(200);
    expect(list.body.registry_mode).toBe('override');
    expect(list.body.count).toBe(1);
    expect(list.body.models[0].id).toBe('custom-user-model');
  });

  it('supports user augment mode overlays merged with system models', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = createMockUser('user-2');
      next();
    });
    app.use('/api/registry', createUserModelRegistryRoutes(modelRegistry, logger));

    const createOverlay = await request(app)
      .post('/api/registry')
      .send({
        id: 'gpt-4o-mini',
        description: 'User-specific description',
      });
    expect(createOverlay.status).toBe(201);
    expect(createOverlay.body.model.description).toBe('User-specific description');

    const list = await request(app).get('/api/registry');
    expect(list.status).toBe(200);
    expect(list.body.registry_mode).toBe('augment');
    expect(list.body.count).toBeGreaterThan(1);

    const gptModel = list.body.models.find((model: { id: string }) => model.id === 'gpt-4o-mini');
    expect(gptModel).toBeDefined();
    expect(gptModel.description).toBe('User-specific description');
  });

  it('returns non-null model for overlay-only create and includes it in immediate GET', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = createMockUser('user-overlay');
      next();
    });
    app.use('/api/registry', createUserModelRegistryRoutes(modelRegistry, logger));

    const createOverlay = await request(app)
      .post('/api/registry')
      .send({
        id: 'my-custom-model-mini',
        description: 'custom model for this user',
      });

    expect(createOverlay.status).toBe(201);
    expect(createOverlay.body.model).toBeTruthy();
    expect(createOverlay.body.model.id).toBe('my-custom-model-mini');
    expect(createOverlay.body.model.available).toBe(true);
    expect(createOverlay.body.model.status).toBe('active');

    const list = await request(app).get('/api/registry');
    expect(list.status).toBe(200);
    expect(list.body.models.some((model: { id: string }) => model.id === 'my-custom-model-mini')).toBe(true);
  });

  it('keeps user overlays isolated between users', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = (req.headers['x-user-id'] as string | undefined) ?? 'user-default';
      req.user = createMockUser(userId);
      next();
    });
    app.use('/api/registry', createUserModelRegistryRoutes(modelRegistry, logger));

    const createA = await request(app)
      .post('/api/registry')
      .set('x-user-id', 'user-a')
      .send({ id: 'user-a-model' });
    expect(createA.status).toBe(201);

    const createB = await request(app)
      .post('/api/registry')
      .set('x-user-id', 'user-b')
      .send({ id: 'user-b-model' });
    expect(createB.status).toBe(201);

    const listA = await request(app)
      .get('/api/registry')
      .set('x-user-id', 'user-a');
    const listB = await request(app)
      .get('/api/registry')
      .set('x-user-id', 'user-b');

    expect(listA.body.models.some((model: { id: string }) => model.id === 'user-a-model')).toBe(true);
    expect(listA.body.models.some((model: { id: string }) => model.id === 'user-b-model')).toBe(false);
    expect(listB.body.models.some((model: { id: string }) => model.id === 'user-b-model')).toBe(true);
    expect(listB.body.models.some((model: { id: string }) => model.id === 'user-a-model')).toBe(false);
  });

  it('allows /api/tokens creation with overlay-only model id for same user', async () => {
    const tokenStore = new InMemoryTokenStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = createMockUser('token-user');
      next();
    });
    app.use('/api/registry', createUserModelRegistryRoutes(modelRegistry, logger));
    app.use('/api/tokens', createUserTokenRoutes(tokenStore, modelRegistry, logger));

    const createOverlay = await request(app)
      .post('/api/registry')
      .send({
        id: 'overlay-only-model',
      });
    expect(createOverlay.status).toBe(201);

    const createToken = await request(app)
      .post('/api/tokens')
      .send({
        name: 'Custom Model Token',
        eligible_models: ['overlay-only-model'],
      });

    expect(createToken.status).toBe(201);
    expect(createToken.body.config.eligible_models).toEqual(['overlay-only-model']);
  });
});
