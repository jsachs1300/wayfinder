import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { AppDependencies } from '../src/app';
import type { Express } from 'express';
import type { RoutingEngine } from '../src/routing';
import type { RouteRequest, RouteResult, TokenConfig } from '../src/types';
import Redis from 'ioredis-mock';
import express from 'express';
import { createUserTokenRoutes } from '../src/tokens/user-routes';
import { userAuthMiddleware } from '../src/auth';
import { createModelRegistry } from '../src/models';
import { createTokenMetricsStore } from '../src/tokens/metrics';

class StubRoutingEngine implements RoutingEngine {
  async route(request: RouteRequest, tokenConfig: TokenConfig): Promise<RouteResult> {
    const cacheHit = request.prompt.toLowerCase().includes('cache');
    return {
      decision: {
        intent: 'other',
        primary: {
          model: 'gpt-4-turbo',
          score: 9,
          reason: 'Stub decision for tests',
        },
        alternate: {
          model: 'gemini-2.5-flash',
          score: 7,
          reason: 'Stub alternate for tests',
        },
      },
      policyMetadata: {
        forcedModel: null,
        eligibleModelsCount: tokenConfig.eligible_models?.length ?? 0,
      },
      cache_hit: cacheHit,
      router_model_used: 'consensus',
    };
  }
}

describe('API Integration Tests', () => {
  let app: Express;
  let deps: AppDependencies;
  let adminApiKey: string;
  let userToken: string;

  beforeEach(async () => {
    adminApiKey = 'test-admin-key';
    process.env.ADMIN_API_KEY = adminApiKey;
    process.env.FEATURE_USER_SELF_SERVICE = 'true';
    process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(64);

    vi.resetModules();
    const { createApp } = await import('../src/app');
    const redis = new Redis();
    const routingEngine = new StubRoutingEngine();

    const result = await createApp({ redis, routingEngine });
    app = result.app;
    deps = result.dependencies;

    // Create a user token for testing
    const tokenResult = await deps.tokenStore.create({
      trusted_anchor_model: 'claude-3-5-sonnet',
    });
    userToken = tokenResult.token;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.FEATURE_USER_SELF_SERVICE;
    delete process.env.LLM_KEY_ENCRYPTION_KEY;
  });

  describe('Health Endpoint', () => {
    it('should return healthy status with public router summary only', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.router_provider_health).toBeUndefined();
      expect(typeof response.body.router_provider_configured_count).toBe('number');
      expect(typeof response.body.router_provider_snapshot_count).toBe('number');
      expect(typeof response.body.router_provider_healthy_count).toBe('number');
      expect(typeof response.body.router_provider_unhealthy_count).toBe('number');
      expect(response.body.redis_last_error).toBeUndefined();
      if (response.body.redis_last_error_kind !== undefined) {
        expect(typeof response.body.redis_last_error_kind).toBe('string');
      }
    });

    it('should include detailed router diagnostics when admin key is supplied', async () => {
      const response = await request(app)
        .get('/health')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.router_provider_health)).toBe(true);
      expect(response.body.router_provider_snapshot_count).toBe(response.body.router_provider_health.length);
    });
  });

  describe('Public LLM Spec Endpoint', () => {
    it('should return integration spec without authentication', async () => {
      const response = await request(app).get('/llm-integration-spec');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Wayfinder LLM Integration Spec');
      expect(response.body.auth_headers).toBeDefined();
      expect(Array.isArray(response.body.core_endpoints)).toBe(true);
      expect(response.body.core_endpoints.some((e: { path: string }) => e.path === '/route')).toBe(true);
      expect(response.body.admin_endpoints.some((e: { path: string }) => e.path === '/admin/default-token-profile')).toBe(true);
      expect(response.body.integration_patterns.length).toBeGreaterThan(0);
    });

    it('should return plain text LLM spec', async () => {
      const response = await request(app).get('/llms.txt');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Wayfinder LLM Integration Spec');
      expect(response.text).toContain('POST /route');
      expect(response.text).toContain('PUT /admin/default-token-profile');
    });
  });

  describe('Session Token Route Endpoint', () => {
    async function createUserWithTokenAndSession(emailPrefix: string) {
      if (!deps.userStore || !deps.sessionStore) {
        throw new Error('User/session stores are not available');
      }

      const user = await deps.userStore.create({
        email: `${emailPrefix}-${Date.now()}@example.com`,
        password: 'Testpass1!',
      });
      const tokenResult = await deps.tokenStore.createForUser(
        user.id,
        `${emailPrefix}-token`,
        { eligible_models: ['gpt-4-turbo'] }
      );
      const sessionResult = await deps.sessionStore.create(user.id);

      return { user, tokenResult, sessionResult };
    }

    it('should route using selected token_id and session token', async () => {
      const { tokenResult, sessionResult } = await createUserWithTokenAndSession('playground');

      const response = await request(app)
        .post(`/api/tokens/${tokenResult.id}/route`)
        .set('X-Session-Token', sessionResult.token)
        .send({ prompt: 'Write a small Python helper function' });

      expect(response.status).toBe(200);
      expect(response.body.primary).toBeDefined();
      expect(response.body.alternate).toBeDefined();
      expect(response.body.request_id).toBeDefined();
      expect(response.body.router_model_used).toBeDefined();
    });

    it('should reject requests without session token', async () => {
      const { tokenResult } = await createUserWithTokenAndSession('missing-session');

      const response = await request(app)
        .post(`/api/tokens/${tokenResult.id}/route`)
        .send({ prompt: 'test' });

      expect(response.status).toBe(401);
    });

    it('should reject routing when token is not owned by session user', async () => {
      const owner = await createUserWithTokenAndSession('owner');
      const otherUser = await createUserWithTokenAndSession('other');

      const response = await request(app)
        .post(`/api/tokens/${owner.tokenResult.id}/route`)
        .set('X-Session-Token', otherUser.sessionResult.token)
        .send({ prompt: 'test prompt' });

      expect(response.status).toBe(403);
    });

    it('should return 422 for invalid route request payload', async () => {
      const { tokenResult, sessionResult } = await createUserWithTokenAndSession('invalid-payload');

      const response = await request(app)
        .post(`/api/tokens/${tokenResult.id}/route`)
        .set('X-Session-Token', sessionResult.token)
        .send({});

      expect(response.status).toBe(422);
      expect(response.body.error).toBe('ValidationError');
    });

    it('should attribute route metrics to selected token', async () => {
      const { tokenResult, sessionResult } = await createUserWithTokenAndSession('metrics');

      const routeResponse = await request(app)
        .post(`/api/tokens/${tokenResult.id}/route`)
        .set('X-Session-Token', sessionResult.token)
        .send({ prompt: 'cache test' });

      expect(routeResponse.status).toBe(200);

      const metricsResponse = await request(app)
        .get(`/admin/tokens/${tokenResult.id}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(metricsResponse.status).toBe(200);
      expect(metricsResponse.body.metrics.route_requests).toBe(1);
    });
  });

  describe('Admin Token Management', () => {
    it('should create a new token', async () => {
      const response = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({
          trusted_anchor_model: 'claude-3-5-sonnet',
          allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
          eligible_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.token).toBeDefined();
      expect(response.body.token).toMatch(/^wf_/);
      expect(response.body.config.token_hash).toBeUndefined();
    });

    it('should reject requests without admin key', async () => {
      const response = await request(app)
        .post('/admin/tokens')
        .send({});

      expect(response.status).toBe(401);
    });

    it('should reject requests with invalid admin key', async () => {
      const response = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'wrong-key')
        .send({});

      expect(response.status).toBe(401);
    });

    it('should get token by ID', async () => {
      // Create a token first
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({ eligible_models: ['gpt-4o', 'claude-3-5-sonnet'] });

      const tokenId = createResponse.body.id;

      const response = await request(app)
        .get(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(tokenId);
      expect(response.body.eligible_models).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
    });

    it('should update token configuration', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({});

      const tokenId = createResponse.body.id;

      const response = await request(app)
        .patch(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey)
        .send({
          trusted_anchor_model: 'gpt-4-turbo',
          confidence_threshold: 0.75,
        });

      expect(response.status).toBe(200);
      expect(response.body.trusted_anchor_model).toBe('gpt-4-turbo');
      expect(response.body.confidence_threshold).toBe(0.75);
    });

    it('should rotate token', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({});

      const tokenId = createResponse.body.id;
      const originalToken = createResponse.body.token;

      const response = await request(app)
        .post(`/admin/tokens/${tokenId}/rotate`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
      expect(response.body.token).not.toBe(originalToken);
    });
  });

  describe('Admin Router Diagnostics', () => {
    it('should return router provider snapshots', async () => {
      const response = await request(app)
        .get('/admin/router/providers')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.providers)).toBe(true);
      expect(typeof response.body.count).toBe('number');
      expect(response.body.timestamp).toBeDefined();
    });

    it('should run router provider validation preflight', async () => {
      const response = await request(app)
        .post('/admin/router/validate')
        .set('X-Admin-Api-Key', adminApiKey);

      // In test mode with no providers enabled, preflight reports no healthy providers.
      expect(response.status).toBe(503);
      expect(response.body.summary).toBeDefined();
      expect(Array.isArray(response.body.summary.results)).toBe(true);
      expect(typeof response.body.summary.passCount).toBe('number');
      expect(typeof response.body.summary.failCount).toBe('number');
      expect(typeof response.body.note).toBe('string');
    });
  });

  describe('Feedback Endpoint', () => {
    it('should accept feedback', async () => {
      const response = await request(app)
        .post('/feedback')
        .set('X-Wayfinder-Token', userToken)
        .send({
          request_id: 'test-request-id',
          selected_model: 'gpt-4-turbo',
          intent_label: 'coding',
          rating: 'positive',
        });

      expect(response.status).toBe(200);
      expect(response.body.feedback_id).toBeDefined();
      expect(response.body.acknowledged).toBe(true);
    });

    it('should update knowledge on positive feedback', async () => {
      await request(app)
        .post('/feedback')
        .set('X-Wayfinder-Token', userToken)
        .send({
          request_id: 'test-request-id',
          selected_model: 'gpt-4-turbo',
          intent_label: 'coding',
          rating: 'positive',
        });

      const knowledge = await deps.knowledgeStore.get('coding', { scope: "global" });
      expect(knowledge).not.toBeNull();
      expect(knowledge!.model_votes['gpt-4-turbo']).toBeGreaterThan(0);
    });

    it('should validate feedback request', async () => {
      const response = await request(app)
        .post('/feedback')
        .set('X-Wayfinder-Token', userToken)
        .send({
          request_id: 'test',
          // Missing required fields
        });

      expect(response.status).toBe(400);
    });
  });

  describe('Knowledge Admin Endpoints', () => {
    it('should return knowledge stats', async () => {
      await deps.knowledgeStore.clear({ scope: 'global' });

      // Add some knowledge first
      await deps.knowledgeStore.recordVote('coding', 'gpt-4-turbo', { scope: "global" });
      await deps.knowledgeStore.recordVote('legal', 'claude-3-opus', { scope: "global" });

      const response = await request(app)
        .get('/admin/knowledge/stats')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.total_entries).toBe(2);
      expect(response.body.entries_by_confidence).toBeDefined();
    });

    it('should trigger decay', async () => {
      await deps.knowledgeStore.recordVote('coding', 'gpt-4-turbo', { scope: "global" });

      const response = await request(app)
        .post('/admin/knowledge/decay')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(410);
      expect(response.body.error).toBe('Deprecated');
    });
  });

  describe('Models Endpoint', () => {
    it('should list available models', async () => {
      const response = await request(app)
        .get('/admin/models')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.models).toBeInstanceOf(Array);
      expect(response.body.count).toBeGreaterThan(0);
      expect(response.body.default).toBeDefined();
    });
  });

  describe('Default Token Profile', () => {
    it('should return default token profile', async () => {
      const response = await request(app)
        .get('/admin/default-token-profile')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.profile).toBeDefined();
      expect(response.body.profile.version).toBe(1);
      expect(Array.isArray(response.body.profile.model_ids)).toBe(true);
      expect(Array.isArray(response.body.effective_model_ids)).toBe(true);
      expect(response.body.cache_scope).toBe('global:v1');
    });

    it('should update default token profile and bump version', async () => {
      const modelsResponse = await request(app)
        .get('/admin/models')
        .set('X-Admin-Api-Key', adminApiKey);
      const candidateModels = (modelsResponse.body.models as Array<{ id: string; available?: boolean; global_eligible?: boolean }>)
        .filter((model) => model.available !== false && model.global_eligible !== false)
        .slice(0, 2)
        .map((model) => model.id);
      expect(candidateModels.length).toBe(2);

      const response = await request(app)
        .put('/admin/default-token-profile')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({
          model_ids: candidateModels,
        });

      expect(response.status).toBe(200);
      expect(response.body.profile.version).toBe(2);
      expect(response.body.profile.model_ids).toEqual(candidateModels);
      expect(response.body.cache_scope).toBe('global:v2');
      expect(response.body.cache_flush_recommended).toBe(true);
    });
  });

  describe('Token Metrics Integration', () => {
    it('should include metrics for admin token list', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({ eligible_models: ['gpt-4-turbo'] });

      const tokenId = createResponse.body.id;

      const response = await request(app)
        .get('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      const token = response.body.tokens.find((t: { id: string }) => t.id === tokenId);
      expect(token).toBeDefined();
      expect(token.metrics).toEqual({ route_requests: 0, cache_hits: 0, throttled_requests: 0 });
    });

    it('should include metrics for admin token detail', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({ eligible_models: ['gpt-4-turbo'] });

      const tokenId = createResponse.body.id;

      const response = await request(app)
        .get(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.metrics).toEqual({ route_requests: 0, cache_hits: 0, throttled_requests: 0 });
    });

    it('should include metrics for user token list', async () => {
      const userApp = express();
      userApp.use(express.json());
      const modelRegistry = createModelRegistry();
      const metricsStore = createTokenMetricsStore(deps.redis);
      userApp.use(
        '/api/tokens',
        userAuthMiddleware(deps.tokenStore, deps.userStore!, deps.sessionStore),
        createUserTokenRoutes(deps.tokenStore, modelRegistry, deps.logger, metricsStore)
      );

      const user = await deps.userStore!.create({
        email: 'metrics@example.com',
        password: 'Password123!',
      });
      const tokenResult = await deps.tokenStore.createForUser(
        user.id,
        null,
        { eligible_models: ['gpt-4-turbo'] }
      );

      const response = await request(userApp)
        .get('/api/tokens')
        .set('X-Wayfinder-Token', tokenResult.token);

      expect(response.status).toBe(200);
      expect(response.body.tokens).toHaveLength(1);
      expect(response.body.tokens[0].metrics).toEqual({ route_requests: 0, cache_hits: 0, throttled_requests: 0 });
    });

    it('should increment metrics on route requests', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({ eligible_models: ['gpt-4-turbo'] });

      const tokenId = createResponse.body.id;
      const token = createResponse.body.token;

      const routeResponse = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', token)
        .send({ prompt: 'Route this request' });

      expect(routeResponse.status).toBe(200);

      const metricsResponse = await request(app)
        .get(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(metricsResponse.body.metrics).toEqual({ route_requests: 1, cache_hits: 0, throttled_requests: 0 });
    });

    it('should increment cache hit metrics on cached routes', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({ eligible_models: ['gpt-4-turbo'] });

      const tokenId = createResponse.body.id;
      const token = createResponse.body.token;

      const routeResponse = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', token)
        .send({ prompt: 'cache this request' });

      expect(routeResponse.status).toBe(200);

      const metricsResponse = await request(app)
        .get(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(metricsResponse.body.metrics).toEqual({ route_requests: 1, cache_hits: 1, throttled_requests: 0 });
    });

    it('should accumulate metrics across multiple requests', async () => {
      const createResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({ eligible_models: ['gpt-4-turbo'] });

      const tokenId = createResponse.body.id;
      const token = createResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', token)
        .send({ prompt: 'first request' });

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', token)
        .send({ prompt: 'cache second request' });

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', token)
        .send({ prompt: 'third request' });

      const metricsResponse = await request(app)
        .get(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(metricsResponse.body.metrics).toEqual({ route_requests: 3, cache_hits: 1, throttled_requests: 0 });
    });
  });

  describe('404 Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await request(app).get('/unknown-endpoint');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('NotFound');
    });
  });
});
