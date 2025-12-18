import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import request from 'supertest';

describe('Routing with Scoped Knowledge - Integration', () => {
  let app: any;
  let dependencies: any;
  let globalToken: string;
  let globalTokenId: string;
  let scopedToken1: string;
  let scopedToken1Id: string;
  let scopedToken2: string;
  let scopedToken2Id: string;
  const adminApiKey = 'test-admin-key';

  beforeEach(async () => {
    process.env.ADMIN_API_KEY = adminApiKey;

    const result = createApp();
    app = result.app;
    dependencies = result.dependencies;

    // Create global scope token (default)
    const globalResponse = await request(app)
      .post('/admin/tokens')
      .set('X-Admin-Api-Key', adminApiKey)
      .send({
        default_model: 'gpt-4o',
        // No knowledge_scope specified - defaults to 'global'
      });

    globalToken = globalResponse.body.token;
    globalTokenId = globalResponse.body.id;

    // Create token-scoped token 1
    const scoped1Response = await request(app)
      .post('/admin/tokens')
      .set('X-Admin-Api-Key', adminApiKey)
      .send({
        default_model: 'gpt-4o',
        knowledge_scope: 'token',
      });

    scopedToken1 = scoped1Response.body.token;
    scopedToken1Id = scoped1Response.body.id;

    // Create token-scoped token 2
    const scoped2Response = await request(app)
      .post('/admin/tokens')
      .set('X-Admin-Api-Key', adminApiKey)
      .send({
        default_model: 'gpt-4o',
        knowledge_scope: 'token',
      });

    scopedToken2 = scoped2Response.body.token;
    scopedToken2Id = scoped2Response.body.id;

    // Clear knowledge store
    await dependencies.knowledgeStore.clear();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it('should default to global scope when knowledge_scope not specified', async () => {
    const tokenResponse = await request(app)
      .get(`/admin/tokens/${globalTokenId}`)
      .set('X-Admin-Api-Key', adminApiKey);

    expect(tokenResponse.body.knowledge_scope).toBe('global');
  });

  it('should respect token scope setting', async () => {
    const tokenResponse = await request(app)
      .get(`/admin/tokens/${scopedToken1Id}`)
      .set('X-Admin-Api-Key', adminApiKey);

    expect(tokenResponse.body.knowledge_scope).toBe('token');
  });

  it('should build global knowledge via feedback from global token', async () => {
    // Route request
    const routeResponse = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', globalToken)
      .send({ prompt: 'Write a function to sort an array' });

    // Submit positive feedback
    await request(app)
      .post('/feedback')
      .set('X-Wayfinder-Token', globalToken)
      .send({
        request_id: routeResponse.body.request_id,
        selected_model: routeResponse.body.selected_model,
        intent_label: 'coding',
        rating: 'positive',
      });

    // Verify global knowledge was updated
    const stats = await dependencies.knowledgeStore.getStats({ scope: 'global' });
    expect(stats.total_entries).toBe(1);
    expect(stats.entries_by_scope?.global).toBe(1);
  });

  it('should build token-scoped knowledge via feedback from scoped token', async () => {
    // Route request with scoped token
    const routeResponse = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', scopedToken1)
      .send({ prompt: 'Write a function to sort an array' });

    // Submit positive feedback
    await request(app)
      .post('/feedback')
      .set('X-Wayfinder-Token', scopedToken1)
      .send({
        request_id: routeResponse.body.request_id,
        selected_model: routeResponse.body.selected_model,
        intent_label: 'coding',
        rating: 'positive',
      });

    // Verify token-scoped knowledge was updated
    const allStats = await dependencies.knowledgeStore.getStats();
    expect(allStats.entries_by_scope?.token).toBe(1);
    expect(allStats.entries_by_scope?.global).toBe(0);

    // Verify token-specific stats
    const tokenStats = await dependencies.knowledgeStore.getStats({
      scope: 'token',
      token_id: scopedToken1Id,
    });
    expect(tokenStats.total_entries).toBe(1);
  });

  it('should isolate knowledge between two token-scoped tokens', async () => {
    // Build knowledge for token 1
    for (let i = 0; i < 6; i++) {
      await dependencies.knowledgeStore.recordVote(
        'coding',
        'gpt-4-turbo',
        { scope: 'token', token_id: scopedToken1Id }
      );
    }

    // Build knowledge for token 2
    for (let i = 0; i < 6; i++) {
      await dependencies.knowledgeStore.recordVote(
        'coding',
        'claude-3-5-sonnet',
        { scope: 'token', token_id: scopedToken2Id }
      );
    }

    // Route with token 1 - should prefer gpt-4-turbo
    const route1Response = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', scopedToken1)
      .send({ prompt: 'Write a function to sort an array' });

    // Route with token 2 - should prefer claude-3-5-sonnet
    const route2Response = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', scopedToken2)
      .send({ prompt: 'Write a function to sort an array' });

    // Verify different models selected based on scoped knowledge
    expect(route1Response.body.selected_model).toBe('gpt-4-turbo');
    expect(route1Response.body.routing_decision.reason).toBe('knowledge_consensus');

    expect(route2Response.body.selected_model).toBe('claude-3-5-sonnet');
    expect(route2Response.body.routing_decision.reason).toBe('knowledge_consensus');
  });

  it('should not leak global knowledge to token-scoped tokens', async () => {
    // Build strong global knowledge
    for (let i = 0; i < 10; i++) {
      await dependencies.knowledgeStore.recordVote(
        'coding',
        'gpt-4-turbo',
        { scope: 'global' }
      );
    }

    // Route with token-scoped token
    const routeResponse = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', scopedToken1)
      .send({ prompt: 'Write a function to sort an array' });

    // Should NOT use global knowledge consensus
    expect(routeResponse.body.routing_decision.knowledge_used).toBe(false);
    expect(routeResponse.body.selected_model).not.toBe('gpt-4-turbo');
  });

  it('should bypass knowledge for policy-forced routing regardless of scope', async () => {
    // Build token-scoped knowledge
    for (let i = 0; i < 10; i++) {
      await dependencies.knowledgeStore.recordVote(
        'coding',
        'gpt-4-turbo',
        { scope: 'token', token_id: scopedToken1Id }
      );
    }

    // Create token with forced policy
    const policyTokenResponse = await request(app)
      .post('/admin/tokens')
      .set('X-Admin-Api-Key', adminApiKey)
      .send({
        default_model: 'gpt-4o',
        knowledge_scope: 'token',
        policy_rules: [
          {
            type: 'ForceModelByIntent',
            intent: 'coding',
            models: ['claude-3-opus'],
          },
        ],
      });

    const policyToken = policyTokenResponse.body.token;

    // Route with policy-forced token
    const routeResponse = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', policyToken)
      .send({ prompt: 'Write a function to sort an array' });

    // Policy should force model regardless of knowledge
    expect(routeResponse.body.selected_model).toBe('claude-3-opus');
    expect(routeResponse.body.routing_decision.policy_forced).toBe(true);
    expect(routeResponse.body.routing_decision.knowledge_used).toBe(false);
  });

  it('should support updating token knowledge_scope via PATCH', async () => {
    // Update token to use token scope
    await request(app)
      .patch(`/admin/tokens/${globalTokenId}`)
      .set('X-Admin-Api-Key', adminApiKey)
      .send({
        knowledge_scope: 'token',
      });

    // Verify update
    const tokenResponse = await request(app)
      .get(`/admin/tokens/${globalTokenId}`)
      .set('X-Admin-Api-Key', adminApiKey);

    expect(tokenResponse.body.knowledge_scope).toBe('token');
  });

  it('should get stats filtered by scope via query params', async () => {
    // Create knowledge in both scopes
    await dependencies.knowledgeStore.recordVote(
      'coding',
      'gpt-4-turbo',
      { scope: 'global' }
    );
    await dependencies.knowledgeStore.recordVote(
      'coding',
      'gpt-4o',
      { scope: 'token', token_id: scopedToken1Id }
    );

    // Get all stats
    const allStatsResponse = await request(app)
      .get('/admin/knowledge/stats')
      .set('X-Admin-Api-Key', adminApiKey);

    expect(allStatsResponse.body.total_entries).toBe(2);

    // Get global stats only
    const globalStatsResponse = await request(app)
      .get('/admin/knowledge/stats?scope=global')
      .set('X-Admin-Api-Key', adminApiKey);

    expect(globalStatsResponse.body.total_entries).toBe(1);

    // Get token stats only
    const tokenStatsResponse = await request(app)
      .get(`/admin/knowledge/stats?scope=token&token_id=${scopedToken1Id}`)
      .set('X-Admin-Api-Key', adminApiKey);

    expect(tokenStatsResponse.body.total_entries).toBe(1);
  });
});
