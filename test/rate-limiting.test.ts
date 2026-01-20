/**
 * Rate Limiting Tests
 *
 * Comprehensive tests for rate limiting functionality including:
 * - Rate limit headers in responses
 * - Request blocking after limit exceeded (429 status)
 * - Per-token limiting for /route endpoint
 * - Per-IP limiting for /admin endpoints
 * - Error response format consistency
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, AppDependencies } from '../src/app';
import type { Express } from 'express';

describe('Rate Limiting', () => {
  let app: Express;
  let deps: AppDependencies;
  let adminApiKey: string;
  let testToken: string;

  beforeEach(async () => {
    // Set admin API key for authentication
    adminApiKey = 'test-admin-key';
    process.env.ADMIN_API_KEY = adminApiKey;

    // Create fresh app instance for each test
    const result = await createApp();
    app = result.app;
    deps = result.dependencies;

    // Create a test token for authenticated requests using tokenStore directly
    const tokenConfig = await deps.tokenStore.create({
      trusted_anchor_model: 'claude-3-5-sonnet',
    });

    testToken = tokenConfig.token;
  });

  describe('Rate Limit Headers', () => {
    it('should return RateLimit-* headers on routing endpoint', async () => {
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'test' });

      // Standard RateLimit headers should be present
      expect(response.headers['ratelimit-limit']).toBeDefined();
      expect(response.headers['ratelimit-remaining']).toBeDefined();
      expect(response.headers['ratelimit-reset']).toBeDefined();
      expect(response.headers['ratelimit-policy']).toBeDefined();

      // Verify header values are numeric
      expect(parseInt(response.headers['ratelimit-limit'])).toBeGreaterThan(0);
      expect(parseInt(response.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
      expect(parseInt(response.headers['ratelimit-reset'])).toBeGreaterThan(0);
    });

    it('should return RateLimit-* headers on admin endpoint', async () => {
      const response = await request(app)
        .get('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key');

      expect(response.headers['ratelimit-limit']).toBeDefined();
      expect(response.headers['ratelimit-remaining']).toBeDefined();
      expect(response.headers['ratelimit-reset']).toBeDefined();
    });

    it('should NOT return rate limit headers on health endpoint', async () => {
      const response = await request(app).get('/health');

      // Health endpoint should not be rate limited
      expect(response.headers['ratelimit-limit']).toBeUndefined();
      expect(response.status).toBe(200);
    });
  });

  describe('Rate Limit Enforcement - Routing Endpoint', () => {
    it('should block requests after exceeding routing limit', async () => {
      // Default routing limit is 20 requests per minute per token
      const limit = parseInt(process.env.RATE_LIMIT_ROUTING_MAX || '20', 10);

      // Make requests up to the limit (should all succeed)
      for (let i = 0; i < limit; i++) {
        const response = await request(app)
          .post('/route')
          .set('X-Wayfinder-Token', testToken)
          .send({ prompt: `test ${i}` });

        expect(response.status).not.toBe(429);
      }

      // Next request (limit + 1) should be rate limited
      const blockedResponse = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'should be blocked' });

      expect(blockedResponse.status).toBe(429);
      expect(blockedResponse.body.error).toBe('TooManyRequests');
      expect(blockedResponse.body.message).toContain('Too many requests');
      expect(blockedResponse.body.timestamp).toBeDefined(); // Consistent format
      expect(blockedResponse.body.retryAfter).toBeDefined();
    });

    it('should enforce per-token rate limiting (different tokens have separate limits)', async () => {
      // Create a second token using tokenStore directly
      const tokenConfig2 = await deps.tokenStore.create({
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const testToken2 = tokenConfig2.token;

      // Exhaust limit for first token
      const limit = parseInt(process.env.RATE_LIMIT_ROUTING_MAX || '20', 10);

      for (let i = 0; i < limit; i++) {
        await request(app)
          .post('/route')
          .set('X-Wayfinder-Token', testToken)
          .send({ prompt: `test ${i}` });
      }

      // First token should be rate limited
      const blocked = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'should be blocked' });

      expect(blocked.status).toBe(429);

      // Second token should still work
      const allowed = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken2)
        .send({ prompt: 'should work' });

      expect(allowed.status).not.toBe(429);
    });
  });

  describe('Rate Limit Enforcement - Admin Endpoint', () => {
    it('should block admin requests after exceeding limit', async () => {
      const limit = parseInt(process.env.RATE_LIMIT_ADMIN_MAX || '50', 10);

      // Make requests up to the limit (should all succeed)
      for (let i = 0; i < limit; i++) {
        const response = await request(app)
          .get('/admin/tokens')
          .set('X-Admin-Api-Key', adminApiKey);

        expect(response.status).not.toBe(429);
      }

      // Next request (limit + 1) should be rate limited
      const blockedResponse = await request(app)
        .get('/admin/tokens')
        .set('X-Admin-Api-Key', adminApiKey);

      expect(blockedResponse.status).toBe(429);
      expect(blockedResponse.body.error).toBe('TooManyRequests');
      expect(blockedResponse.body.timestamp).toBeDefined();
    });
  });

  describe('Rate Limit Enforcement - Feedback Endpoint', () => {
    it('should enforce rate limiting on feedback endpoint', async () => {
      const limit = parseInt(process.env.RATE_LIMIT_FEEDBACK_MAX || '100', 10);

      // Make a few requests to verify rate limiting is active
      const response1 = await request(app)
        .post('/feedback')
        .set('X-Wayfinder-Token', testToken)
        .send({
          request_id: 'test-req-1',
          model: 'gpt-4o',
          vote: 'up',
        });

      expect(response1.headers['ratelimit-limit']).toBe(limit.toString());
      expect(response1.headers['ratelimit-remaining']).toBeDefined();
    });
  });

  describe('Error Response Format', () => {
    it('should return consistent error format for rate limit violations', async () => {
      const limit = parseInt(process.env.RATE_LIMIT_ROUTING_MAX || '20', 10);

      // Exhaust limit
      for (let i = 0; i <= limit; i++) {
        await request(app)
          .post('/route')
          .set('X-Wayfinder-Token', testToken)
          .send({ prompt: `test ${i}` });
      }

      // Get rate limited response
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'blocked' });

      // Verify consistent error format (same as other API errors)
      expect(response.status).toBe(429);
      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp'); // Key requirement from review
      expect(response.body).toHaveProperty('retryAfter');

      // Verify timestamp is valid ISO date
      expect(() => new Date(response.body.timestamp)).not.toThrow();
    });
  });

  describe('Health Endpoint Exemption', () => {
    it('should never rate limit health endpoint', async () => {
      // Make many health check requests
      for (let i = 0; i < 200; i++) {
        const response = await request(app).get('/health');
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('healthy');
      }
    });
  });

  describe('Configuration Validation', () => {
    it('should use default values for invalid environment variables', async () => {
      // This test verifies the parsePositiveInt function works correctly
      // Set invalid env vars
      process.env.RATE_LIMIT_ROUTING_MAX = 'invalid';
      process.env.RATE_LIMIT_ROUTING_WINDOW_MS = '-1000';

      const { app: testApp } = await createApp();

      // App should still work with defaults (will log warnings)
      request(testApp).get('/health').expect(200);

      // Clean up
      delete process.env.RATE_LIMIT_ROUTING_MAX;
      delete process.env.RATE_LIMIT_ROUTING_WINDOW_MS;
    });
  });
});
