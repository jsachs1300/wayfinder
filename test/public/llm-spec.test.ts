import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis-mock';

type EnvSnapshot = {
  featureUserSelfService?: string;
  llmKeyEncryptionKey?: string;
  adminApiKey?: string;
};

const envSnapshot: EnvSnapshot = {
  featureUserSelfService: process.env.FEATURE_USER_SELF_SERVICE,
  llmKeyEncryptionKey: process.env.LLM_KEY_ENCRYPTION_KEY,
  adminApiKey: process.env.ADMIN_API_KEY,
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
}

async function createTestApp(userSelfService: boolean) {
  process.env.FEATURE_USER_SELF_SERVICE = userSelfService ? 'true' : 'false';
  process.env.ADMIN_API_KEY = 'test-admin-key';
  process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(64);
  vi.resetModules();
  const { createApp } = await import('../../src/app');
  const redis = new Redis();
  const { app } = await createApp({ redis });
  return app;
}

describe('Public LLM Spec Endpoints', () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('returns /llm-spec as OpenAPI JSON with cache headers', async () => {
    const app = await createTestApp(false);
    const response = await request(app).get('/llm-spec');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toContain('max-age=300');
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.info.title).toBe('Wayfinder API');
    expect(response.body.paths['/route']).toBeDefined();
    expect(response.body.paths['/mcp']).toBeDefined();
  });

  it('returns /llms.txt as UTF-8 text with cache headers', async () => {
    const app = await createTestApp(false);
    const response = await request(app).get('/llms.txt');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain; charset=utf-8');
    expect(response.headers['cache-control']).toContain('max-age=300');
    expect(response.text).toContain('## /route Contract');
    expect(response.text).toContain('## Cache Behavior');
  });

  it('keeps /llm-integration-spec and /llms.txt content aligned for endpoint paths', async () => {
    const app = await createTestApp(false);
    const jsonRes = await request(app).get('/llm-integration-spec');
    const textRes = await request(app).get('/llms.txt');

    expect(jsonRes.status).toBe(200);
    expect(textRes.status).toBe(200);

    const jsonEndpoints = [
      ...jsonRes.body.core_endpoints,
      ...jsonRes.body.admin_endpoints,
    ] as Array<{ method: string; path: string }>;

    for (const endpoint of jsonEndpoints) {
      expect(textRes.text).toContain(`${endpoint.method} ${endpoint.path}`);
    }
  });

  it('reflects user self-service feature flag in /llm-integration-spec output', async () => {
    const appDisabled = await createTestApp(false);
    const disabledRes = await request(appDisabled).get('/llm-integration-spec');
    expect(disabledRes.status).toBe(200);
    expect(disabledRes.body.user_self_service.enabled).toBe(false);

    const appEnabled = await createTestApp(true);
    const enabledRes = await request(appEnabled).get('/llm-integration-spec');
    expect(enabledRes.status).toBe(200);
    expect(enabledRes.body.user_self_service.enabled).toBe(true);
    expect(Array.isArray(enabledRes.body.user_self_service.endpoints)).toBe(true);
    expect(enabledRes.body.user_self_service.endpoints.length).toBeGreaterThan(0);
  });
});
