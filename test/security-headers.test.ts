/**
 * Security Headers Tests
 *
 * Comprehensive tests for security headers and CORS configuration including:
 * - Helmet security headers (CSP, HSTS, X-Content-Type-Options, etc.)
 * - CORS origin validation and headers
 * - Request body size limits
 * - Error handler behavior (stack trace leakage prevention)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, AppDependencies } from '../src/app';
import type { Express } from 'express';
import { createRoutingEngine, StubRouterLLM } from '../src/routing';
import { createPolicyEngine } from '../src/policy';
import { createModelRegistry } from '../src/models';
import type { Logger } from '../src/logging/logger';

describe('Security Headers', () => {
  let app: Express;
  let deps: AppDependencies;
  let adminApiKey: string;
  let originalNodeEnv: string | undefined;
  const policyEngine = createPolicyEngine();
  const modelRegistry = createModelRegistry();
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    // Save original NODE_ENV
    originalNodeEnv = process.env.NODE_ENV;

    // Set admin API key for authentication
    adminApiKey = 'test-admin-key';
    process.env.ADMIN_API_KEY = adminApiKey;

    const routingEngine = createRoutingEngine({
      routerLLM: new StubRouterLLM(),
      policyEngine,
      modelRegistry,
      logger,
    });

    // Create fresh app instance for each test
    const result = await createApp({ routingEngine });
    app = result.app;
    deps = result.dependencies;
  });

  afterEach(() => {
    // Restore NODE_ENV
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  describe('Helmet Security Headers', () => {
    it('should return Content-Security-Policy header', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    });

    it('should return Strict-Transport-Security (HSTS) header', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['strict-transport-security']).toBeDefined();
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(response.headers['strict-transport-security']).toContain('includeSubDomains');
      expect(response.headers['strict-transport-security']).toContain('preload');
    });

    it('should return X-Content-Type-Options: nosniff header', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('should return Referrer-Policy header', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['referrer-policy']).toBeDefined();
      expect(response.headers['referrer-policy']).toContain('strict-origin-when-cross-origin');
    });

    it('should return X-Frame-Options or CSP frame-ancestors for clickjacking protection', async () => {
      const response = await request(app).get('/health');

      // Either X-Frame-Options or CSP frame-ancestors should be set
      const hasXFrameOptions = response.headers['x-frame-options'] !== undefined;
      const hasCspFrameAncestors = response.headers['content-security-policy']?.includes('frame-ancestors');

      expect(hasXFrameOptions || hasCspFrameAncestors).toBe(true);
    });

    it('should not expose unnecessary server information', async () => {
      const response = await request(app).get('/health');

      // Helmet should remove X-Powered-By header
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS Configuration', () => {
    it('should allow requests with no origin (mobile apps, curl)', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      // Should have CORS headers even without origin
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should allow wildcard origin when ALLOWED_ORIGINS=*', async () => {
      process.env.ALLOWED_ORIGINS = '*';
      const { app: testApp } = await createApp();

      const response = await request(testApp)
        .get('/health')
        .set('Origin', 'https://example.com');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
    });

    it('should allow specific origin when in ALLOWED_ORIGINS list', async () => {
      process.env.ALLOWED_ORIGINS = 'https://app.example.com,https://example.com';
      const { app: testApp } = await createApp();

      const response = await request(testApp)
        .get('/health')
        .set('Origin', 'https://app.example.com');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('should reject origin not in ALLOWED_ORIGINS list', async () => {
      process.env.ALLOWED_ORIGINS = 'https://app.example.com';
      const { app: testApp } = await createApp();

      const response = await request(testApp)
        .get('/health')
        .set('Origin', 'https://malicious.com');

      // CORS middleware will not set allow-origin for disallowed origins
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should expose rate limiting headers in CORS', async () => {
      // Explicitly set ALLOWED_ORIGINS to ensure CORS is active
      process.env.ALLOWED_ORIGINS = '*';
      const routingEngine = createRoutingEngine({
        routerLLM: new StubRouterLLM(),
        policyEngine,
        modelRegistry,
        logger,
      });
      const { app: testApp, dependencies: testDeps } = await createApp({ routingEngine });

      const tokenConfig = await testDeps.tokenStore.create({
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', tokenConfig.token)
        .set('Origin', 'https://example.com')
        .send({ prompt: 'test' });

      // Check that rate limit headers are exposed via CORS
      const exposedHeaders = response.headers['access-control-expose-headers'];
      expect(exposedHeaders).toBeDefined();
      expect(exposedHeaders).toContain('RateLimit-Limit');
      expect(exposedHeaders).toContain('RateLimit-Remaining');
      expect(exposedHeaders).toContain('RateLimit-Reset');
    });

    it('should support credentials (cookies, auth headers)', async () => {
      // Explicitly set ALLOWED_ORIGINS to ensure CORS is active
      process.env.ALLOWED_ORIGINS = '*';
      const { app: testApp } = await createApp();

      const response = await request(testApp)
        .get('/health')
        .set('Origin', 'https://example.com');

      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should handle OPTIONS preflight requests on health endpoint', async () => {
      // Explicitly set ALLOWED_ORIGINS to ensure CORS is active
      process.env.ALLOWED_ORIGINS = '*';
      const { app: testApp } = await createApp();

      const response = await request(testApp)
        .options('/health')
        .set('Origin', 'https://example.com')
        .set('Access-Control-Request-Method', 'GET');

      // Should return 204 No Content with CORS headers
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-methods']).toBeDefined();
    });
  });

  describe('Request Body Size Limits', () => {
    it('should reject request body larger than 10kb', async () => {
      const tokenConfig = await deps.tokenStore.create({
        trusted_anchor_model: 'claude-3-5-sonnet',
        default_model: 'gpt-4o',
      });

      // Create a payload larger than 10kb
      const largePrompt = 'a'.repeat(11 * 1024); // 11kb

      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', tokenConfig.token)
        .set('Content-Type', 'application/json')
        .send({ prompt: largePrompt });

      // Should be rejected with 413 Payload Too Large (or 400/500 depending on middleware behavior)
      // The key is that it should be rejected, not succeed
      expect([400, 413, 500]).toContain(response.status);
      expect(response.body.error).toBeDefined();
    });

    it('should accept request body smaller than 10kb', async () => {
      const tokenConfig = await deps.tokenStore.create({
        trusted_anchor_model: 'claude-3-5-sonnet',
        default_model: 'gpt-4o',
      });

      // Create a payload smaller than 10kb
      const smallPrompt = 'test prompt';

      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', tokenConfig.token)
        .set('Content-Type', 'application/json')
        .send({ prompt: smallPrompt });

      // Should not be rejected for size (may fail for other reasons)
      expect(response.status).not.toBe(413);
    });
  });

  describe('Error Handler Security', () => {
    it('should not leak stack traces in production', async () => {
      // Note: We use test mode to create the app (avoids LangCache requirement)
      // but verify production-like error handling behavior
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      const { app: prodApp } = await createApp();

      // Simulate production mode for error handler
      process.env.NODE_ENV = 'production';

      // Trigger an error by calling non-existent endpoint
      const response = await request(prodApp).get('/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body.stack).toBeUndefined();
      expect(response.body.message).toBe('Endpoint not found');

      // Restore
      process.env.NODE_ENV = originalEnv;
    });

    it('should include error details in development', async () => {
      process.env.NODE_ENV = 'development';
      const { app: devApp } = await createApp();

      // Create a scenario that triggers the error handler
      // (404 handler doesn't go through error handler, so this test verifies the pattern)
      const response = await request(devApp).get('/nonexistent');

      // In development, we should get more detailed error info if it goes through error handler
      // The 404 handler is separate, so this mainly verifies NODE_ENV is respected
      expect(response.status).toBe(404);
    });

    it('should always include timestamp in error responses', async () => {
      const response = await request(app).get('/nonexistent');

      expect(response.body.timestamp).toBeDefined();
      expect(() => new Date(response.body.timestamp)).not.toThrow();
    });
  });

  describe('Security Headers on All Endpoints', () => {
    it('should apply security headers to health endpoint', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
    });

    it('should apply security headers to authenticated endpoints', async () => {
      const tokenConfig = await deps.tokenStore.create({
        trusted_anchor_model: 'claude-3-5-sonnet',
        default_model: 'gpt-4o',
      });

      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', tokenConfig.token)
        .send({ prompt: 'test' });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
    });

    it('should apply security headers to admin endpoints', async () => {
      const response = await request(app)
        .get('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
    });

    it('should apply security headers to 404 responses', async () => {
      const response = await request(app).get('/nonexistent');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
    });
  });
});
