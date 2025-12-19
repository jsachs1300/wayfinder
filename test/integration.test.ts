import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, AppDependencies } from '../src/app';
import { Express } from 'express';

describe('API Integration Tests', () => {
  let app: Express;
  let deps: AppDependencies;
  let adminApiKey: string;
  let userToken: string;

  beforeEach(async () => {
    adminApiKey = 'test-admin-key';
    process.env.ADMIN_API_KEY = adminApiKey;

    const result = createApp();
    app = result.app;
    deps = result.dependencies;

    // Create a user token for testing
    const tokenResult = await deps.tokenStore.create({
      trusted_anchor_model: 'claude-3-5-sonnet',
      default_model: 'gpt-4o',
    });
    userToken = tokenResult.token;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  describe('Health Endpoint', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('Admin Token Management', () => {
    it('should create a new token', async () => {
      const response = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey)
        .send({
          trusted_anchor_model: 'claude-3-opus',
          allowed_models: ['gpt-4-turbo', 'claude-3-opus'],
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
        .send({ default_model: 'gpt-4o' });

      const tokenId = createResponse.body.id;

      const response = await request(app)
        .get(`/admin/tokens/${tokenId}`)
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(tokenId);
      expect(response.body.default_model).toBe('gpt-4o');
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

  describe('Routing Endpoint', () => {
    it('should route a request successfully', async () => {
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', userToken)
        .send({
          prompt: 'Write a function to calculate fibonacci numbers',
        });

      expect(response.status).toBe(200);
      expect(response.body.selected_model).toBeDefined();
      expect(response.body.routing_decision).toBeDefined();
      expect(response.body.request_id).toBeDefined();
    });

    it('should reject requests without token', async () => {
      const response = await request(app)
        .post('/route')
        .send({
          prompt: 'Test prompt',
        });

      expect(response.status).toBe(401);
    });

    it('should reject requests with invalid token', async () => {
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', 'invalid-token')
        .send({
          prompt: 'Test prompt',
        });

      expect(response.status).toBe(401);
    });

    it('should validate request body', async () => {
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', userToken)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('ValidationError');
    });

    it('should include routing decision details', async () => {
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', userToken)
        .send({
          prompt: 'What is the legal liability for this contract?',
        });

      expect(response.status).toBe(200);
      expect(response.body.routing_decision.reason).toBeDefined();
      expect(response.body.routing_decision.confidence).toBeDefined();
      expect(response.body.routing_decision.eligible_models).toBeInstanceOf(Array);
      expect(response.body.routing_decision.timestamp).toBeDefined();
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
          intent_label: 'code_change',
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
          intent_label: 'code_change',
          rating: 'positive',
        });

      const knowledge = await deps.knowledgeStore.get('code_change', { scope: "global" });
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
      // Add some knowledge first
      await deps.knowledgeStore.recordVote('code_change', 'gpt-4-turbo', { scope: "global" });
      await deps.knowledgeStore.recordVote('other:legal', 'claude-3-opus', { scope: "global" });

      const response = await request(app)
        .get('/admin/knowledge/stats')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.total_entries).toBe(2);
      expect(response.body.entries_by_confidence).toBeDefined();
    });

    it('should trigger decay', async () => {
      await deps.knowledgeStore.recordVote('code_change', 'gpt-4-turbo', { scope: "global" });

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

  describe('404 Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await request(app).get('/unknown-endpoint');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('NotFound');
    });
  });
});
