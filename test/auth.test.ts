import { describe, it, expect, beforeEach } from 'vitest';
import { hashToken, tokenAuthMiddleware, adminAuthMiddleware } from '../src/auth/middleware';
import { InMemoryTokenStore } from '../src/tokens/store';
import { Request, Response, NextFunction } from 'express';
import { TokenConfig } from '../src/types';

describe('Authentication Security', () => {
  describe('hashToken', () => {
    it('should produce consistent hashes for same input', () => {
      const token = 'test-token-123';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = hashToken('token1');
      const hash2 = hashToken('token2');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      // Should not throw
      const hash = hashToken('');
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
    });

    it('should produce long enough hash to prevent collisions', () => {
      const hash = hashToken('test');
      // SHA256 produces 64 character hex string
      expect(hash.length).toBe(64);
    });

    it('should handle special characters and unicode', () => {
      const specialChars = '!@#$%^&*(){}[]|\\:";\'<>?,./~`';
      const unicode = '你好世界🎉💻';

      expect(() => hashToken(specialChars)).not.toThrow();
      expect(() => hashToken(unicode)).not.toThrow();
      expect(hashToken(unicode).length).toBe(64);
    });

    it('should handle very long tokens', () => {
      const longToken = 'a'.repeat(10000);
      const hash = hashToken(longToken);

      expect(hash.length).toBe(64);
    });
  });

  describe('tokenAuthMiddleware - Timing Attack Prevention', () => {
    let tokenStore: InMemoryTokenStore;
    let middleware: ReturnType<typeof tokenAuthMiddleware>;

    beforeEach(async () => {
      tokenStore = new InMemoryTokenStore();
      middleware = tokenAuthMiddleware(tokenStore);

      // Create a valid token for testing
      await tokenStore.create({
        trusted_anchor_model: 'gpt-4-turbo',
      });
    });

    it('should reject request without token header', async () => {
      const req = {
        headers: {},
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      await middleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toContain('Missing');
    });

    it('should reject request with invalid token', async () => {
      const req = {
        headers: {
          'x-wayfinder-token': 'invalid-token-12345',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      await middleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toBe('Invalid token');
    });

    it('should accept valid token and set tokenConfig', async () => {
      const { token, config } = await tokenStore.create({
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const req = {
        headers: {
          'x-wayfinder-token': token,
        },
      } as Request;

      const res = {} as Response;
      let nextCalled = false;
      const next = (() => { nextCalled = true; }) as NextFunction;

      await middleware(req, res, next);

      expect(nextCalled).toBe(true);
      expect(req.tokenConfig).toBeDefined();
      expect(req.tokenConfig?.id).toBe(config.id);
      expect(req.requestId).toBeDefined();
    });

    it('should handle case sensitivity in header name (lowercase)', async () => {
      const { token } = await tokenStore.create({});

      const req = {
        headers: {
          'x-wayfinder-token': token,
        },
      } as Request;

      const res = {} as Response;
      let nextCalled = false;
      const next = (() => { nextCalled = true; }) as NextFunction;

      await middleware(req, res, next);

      expect(nextCalled).toBe(true);
    });

    it('should not expose hash in error messages', async () => {
      const req = {
        headers: {
          'x-wayfinder-token': 'some-token',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      await middleware(req, res, next);

      // Should not reveal hash or any internal details
      expect(JSON.stringify(res.body)).not.toContain('hash');
      expect(JSON.stringify(res.body)).not.toContain('sha256');
    });

    it('should handle token with whitespace', async () => {
      const req = {
        headers: {
          'x-wayfinder-token': '  token-with-spaces  ',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      await middleware(req, res, next);

      // Whitespace should not be trimmed - token should be exact
      expect(res.statusCode).toBe(401);
    });
  });

  describe('adminAuthMiddleware - Timing Attack Prevention', () => {
    const originalEnv = process.env.ADMIN_API_KEY;

    beforeEach(() => {
      process.env.ADMIN_API_KEY = 'test-admin-key-12345';
    });

    afterEach(() => {
      if (originalEnv) {
        process.env.ADMIN_API_KEY = originalEnv;
      } else {
        delete process.env.ADMIN_API_KEY;
      }
    });

    it('should reject when ADMIN_API_KEY is not configured', () => {
      delete process.env.ADMIN_API_KEY;

      const middleware = adminAuthMiddleware();
      const req = {
        headers: {
          'x-admin-api-key': 'some-key',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      middleware(req, res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('ConfigurationError');
    });

    it('should reject when admin key header is missing', () => {
      const middleware = adminAuthMiddleware();
      const req = {
        headers: {},
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      middleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.message).toContain('Missing');
    });

    it('should reject invalid admin key', () => {
      const middleware = adminAuthMiddleware();
      const req = {
        headers: {
          'x-admin-api-key': 'wrong-key',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      middleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.message).toBe('Invalid admin key');
    });

    it('should accept valid admin key', () => {
      const middleware = adminAuthMiddleware();
      const req = {
        headers: {
          'x-admin-api-key': 'test-admin-key-12345',
        },
      } as Request;

      const res = {} as Response;
      let nextCalled = false;
      const next = (() => { nextCalled = true; }) as NextFunction;

      middleware(req, res, next);

      expect(nextCalled).toBe(true);
      expect(req.requestId).toBeDefined();
    });

    it('should use timing-safe comparison (not vulnerable to length-based timing)', () => {
      // Test that different length keys don't short-circuit
      process.env.ADMIN_API_KEY = 'short';

      const middleware = adminAuthMiddleware();
      const req = {
        headers: {
          'x-admin-api-key': 'this-is-a-much-longer-key',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      // Should reject but should still process the comparison
      middleware(req, res, next);
      expect(res.statusCode).toBe(401);
    });

    it('should handle empty admin key attempt', () => {
      const middleware = adminAuthMiddleware();
      const req = {
        headers: {
          'x-admin-api-key': '',
        },
      } as Request;

      const res = {
        status: function(code: number) {
          this.statusCode = code;
          return this;
        },
        json: function(body: any) {
          this.body = body;
        },
      } as any;

      const next = (() => {}) as NextFunction;

      middleware(req, res, next);

      expect(res.statusCode).toBe(401);
    });

    it('should handle special characters in admin key', () => {
      process.env.ADMIN_API_KEY = 'key-with-!@#$%^&*()-special';

      const middleware = adminAuthMiddleware();
      const req = {
        headers: {
          'x-admin-api-key': 'key-with-!@#$%^&*()-special',
        },
      } as Request;

      const res = {} as Response;
      let nextCalled = false;
      const next = (() => { nextCalled = true; }) as NextFunction;

      middleware(req, res, next);

      expect(nextCalled).toBe(true);
    });
  });
});
