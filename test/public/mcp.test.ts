import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis-mock';

type EnvSnapshot = {
  featureUserSelfService?: string;
  llmKeyEncryptionKey?: string;
  adminApiKey?: string;
  rateLimitRoutingMax?: string;
};

const envSnapshot: EnvSnapshot = {
  featureUserSelfService: process.env.FEATURE_USER_SELF_SERVICE,
  llmKeyEncryptionKey: process.env.LLM_KEY_ENCRYPTION_KEY,
  adminApiKey: process.env.ADMIN_API_KEY,
  rateLimitRoutingMax: process.env.RATE_LIMIT_ROUTING_MAX,
};

function restoreEnv(): void {
  if (envSnapshot.featureUserSelfService === undefined) {
    delete process.env.FEATURE_USER_SELF_SERVICE;
  } else {
    process.env.FEATURE_USER_SELF_SERVICE = envSnapshot.featureUserSelfService;
  }
  if (envSnapshot.llmKeyEncryptionKey === undefined) {
    delete process.env.LLM_KEY_ENCRYPTION_KEY;
  } else {
    process.env.LLM_KEY_ENCRYPTION_KEY = envSnapshot.llmKeyEncryptionKey;
  }
  if (envSnapshot.adminApiKey === undefined) {
    delete process.env.ADMIN_API_KEY;
  } else {
    process.env.ADMIN_API_KEY = envSnapshot.adminApiKey;
  }

  if (envSnapshot.rateLimitRoutingMax === undefined) {
    delete process.env.RATE_LIMIT_ROUTING_MAX;
  } else {
    process.env.RATE_LIMIT_ROUTING_MAX = envSnapshot.rateLimitRoutingMax;
  }
}


async function createTestApp() {
  process.env.FEATURE_USER_SELF_SERVICE = 'false';
  process.env.ADMIN_API_KEY = 'test-admin-key';
  process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(64);
  vi.resetModules();
  const { createApp } = await import('../../src/app');
  const redis = new Redis();
  const { app, dependencies } = await createApp({ redis });
  return { app, dependencies };
}

describe('MCP endpoint and LLM discovery files', () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('serves /prompt.txt and well-known descriptors', async () => {
    const { app } = await createTestApp();

    const promptRes = await request(app).get('/prompt.txt');
    expect(promptRes.status).toBe(200);
    expect(promptRes.headers['content-type']).toContain('text/plain; charset=utf-8');
    expect(promptRes.text).toContain('wayfinder_route');

    const mcpWellKnownRes = await request(app).get('/.well-known/mcp.json');
    expect(mcpWellKnownRes.status).toBe(200);
    expect(mcpWellKnownRes.body.endpoint).toBe('/mcp');

    const aiPluginRes = await request(app).get('/.well-known/ai-plugin.json');
    expect(aiPluginRes.status).toBe(200);
    expect(aiPluginRes.body.name_for_model).toBe('wayfinder_mcp');
    expect(aiPluginRes.body.api.url).toBe('/llm-spec');
    expect(aiPluginRes.body.auth.type).toBe('user_http');
  });





  it('does not count notifications/initialized against MCP POST rate limit', async () => {
    process.env.RATE_LIMIT_ROUTING_MAX = '1';
    const { app } = await createTestApp();

    const notificationRes = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(notificationRes.status).toBe(204);

    const toolsListRes = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list' });

    expect(toolsListRes.status).toBe(200);
  });


  it('records throttled MCP route tool calls in token metrics', async () => {
    process.env.RATE_LIMIT_ROUTING_MAX = '1';
    const { app, dependencies } = await createTestApp();
    const created = await dependencies.tokenStore.create({ environment: 'dev' });

    const firstCall = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${created.token}`)
      .send({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'wayfinder_route',
          arguments: {
            prompt: 'first call',
          },
        },
      });

    expect(firstCall.status).toBe(200);

    const secondCall = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${created.token}`)
      .send({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'wayfinder_route',
          arguments: {
            prompt: 'second call',
          },
        },
      });

    expect(secondCall.status).toBe(429);

    const metrics = await dependencies.tokenMetricsStore?.getMetrics(created.id);
    expect(metrics?.throttled_requests).toBe(1);
  });

  it('returns 204 with no body for notifications/initialized', async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });



  it('prefers X-Wayfinder-Token over conflicting args token', async () => {
    const { app, dependencies } = await createTestApp();
    const created = await dependencies.tokenStore.create({ environment: 'dev' });

    const response = await request(app)
      .post('/mcp')
      .set('X-Wayfinder-Token', created.token)
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'wayfinder_route',
          arguments: {
            token: 'wf_invalid',
            prompt: 'Prefer header token',
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result.structuredContent.primary.model).toBeTypeOf('string');
  });

  it('returns JSON-RPC internal error when dependencies throw', async () => {
    const { app, dependencies } = await createTestApp();
    const created = await dependencies.tokenStore.create({ environment: 'dev' });

    const originalGetByHash = dependencies.tokenStore.getByHash.bind(dependencies.tokenStore);
    dependencies.tokenStore.getByHash = async () => {
      throw new Error('token store unavailable');
    };

    try {
      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${created.token}`)
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'wayfinder_route',
            arguments: {
              prompt: 'trigger failure',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error.code).toBe(-32603);
      expect(response.body.error.message).toBe('Internal error');
      expect(response.body.error.data).toBeUndefined();
    } finally {
      dependencies.tokenStore.getByHash = originalGetByHash;
    }
  });


  it('returns initialize handshake metadata', async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize' });

    expect(response.status).toBe(200);
    expect(response.body.result.protocolVersion).toBe('2025-03-26');
    expect(response.body.result.serverInfo.name).toBe('wayfinder-mcp');
    expect(response.body.result.serverInfo.version).toBeTypeOf('string');
  });




  it('rejects oversized prompt payloads', async () => {
    const { app, dependencies } = await createTestApp();
    const created = await dependencies.tokenStore.create({ environment: 'dev' });

    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${created.token}`)
      .send({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'wayfinder_route',
          arguments: {
            prompt: 'x'.repeat(10001),
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.error.code).toBe(-32602);
  });

  it('lists MCP tools and routes a prompt', async () => {
    const { app, dependencies } = await createTestApp();

    const created = await dependencies.tokenStore.create({ environment: 'dev' });

    const listRes = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(listRes.status).toBe(200);
    expect(listRes.body.result.tools.some((t: { name: string }) => t.name === 'wayfinder_route')).toBe(true);
    expect(listRes.body.result.tools.some((t: { name: string }) => t.name === 'wayfinder_cache_stats')).toBe(false);

    const callRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${created.token}`)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'wayfinder_route',
          arguments: {
            prompt: 'Write unit tests for this function',
          },
        },
      });

    expect(callRes.status).toBe(200);
    expect(callRes.body.result.structuredContent.primary.model).toBeTypeOf('string');
    expect(callRes.body.result.structuredContent.alternate.model).toBeTypeOf('string');
    expect(callRes.body.result.structuredContent.request_id).toBeTypeOf('string');

    const invalidTokenCallRes = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer wf_invalid')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'wayfinder_route',
          arguments: {
            prompt: 'hello',
          },
        },
      });

    expect(invalidTokenCallRes.status).toBe(200);
    expect(invalidTokenCallRes.body.error.code).toBe(-32001);
  });
});
