/**
 * User Session Routes
 *
 * - POST /api/sessions/login: Create a session
 * - POST /api/sessions/validate: Validate a session
 * - POST /api/sessions/logout: Clear a session
 * - POST /api/sessions/elevate: Elevate session to admin
 */

import { Router, Request, Response } from 'express';
import type { SessionStore } from './store';
import type { UserStore } from '../users/store';
import type { TokenStore } from '../tokens/store';
import type { TokenMetricsStore } from '../tokens/metrics';
import type { ModelRegistry } from '../models';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '../users/password';
import { sanitizeUser } from '../users/sanitize';
import { sanitizeToken } from '../tokens/sanitize';
import { selectDefaultEligibleModelIds } from '../tokens/utils';
import { z } from 'zod';
import type { Logger } from '../logging/logger';
import { validate as validateUuid } from 'uuid';

const SESSION_TOKEN_HEADER = 'x-session-token';

const SessionLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const SessionElevateSchema = z.object({
  admin_api_key: z.string().min(1),
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function createSessionRoutes(
  sessionStore: SessionStore,
  userStore: UserStore,
  tokenStore: TokenStore,
  modelRegistry: ModelRegistry,
  logger: Logger,
  metricsStore?: TokenMetricsStore
): Router {
  const router = Router();

  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = SessionLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { email, password } = parsed.data;
      const user = await userStore.getByEmail(email);

      const hashToVerify = user?.password_hash ?? DUMMY_PASSWORD_HASH;
      const isValidPassword = await verifyPassword(password, hashToVerify);

      if (!user || !isValidPassword) {
        res.status(401).json({
          error: 'AuthenticationError',
          message: 'Invalid email or password',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (user.status === 'pending') {
        res.status(403).json({
          error: 'ForbiddenError',
          message: 'Email not verified',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (user.status === 'suspended') {
        res.status(403).json({
          error: 'ForbiddenError',
          message: 'Account suspended',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (user.status === 'deleted') {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Account deleted',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { session, token } = await sessionStore.create(user.id);
      const tokens = await tokenStore.listByUser(user.id);
      const availableModels = modelRegistry.getAvailableModels();
      const allModelIds = availableModels.map((model) => model.id);
      const defaultEligibleModelIds = selectDefaultEligibleModelIds(availableModels);
      const metrics = metricsStore
        ? await metricsStore.getMetricsBulk(tokens.map((t) => t.id))
        : {};

      logger.info('User session created', {
        user_id: user.id,
        email: user.email,
        session_id: session.id,
      });

      res.status(200).json({
        session_token: token,
        session: session,
        user: sanitizeUser(user),
        tokens: tokens.map((token) => ({
          ...sanitizeToken(token, allModelIds, defaultEligibleModelIds),
          metrics: metrics[token.id] ?? { route_requests: 0, cache_hits: 0, throttled_requests: 0 },
        })),
      });
    } catch (error) {
      logger.error('Session login failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });

      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to create session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/validate', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionToken = req.headers[SESSION_TOKEN_HEADER] as string | undefined;
      if (!sessionToken) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing X-Session-Token header',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (!validateUuid(sessionToken)) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid session token format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const session = await sessionStore.getByToken(sessionToken);
      if (!session) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or expired session',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const user = await userStore.getById(session.user_id);
      if (!user) {
        res.status(404).json({
          error: 'NotFound',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (user.status !== 'active') {
        await sessionStore.delete(sessionToken);
        res.status(403).json({
          error: 'Forbidden',
          message: 'Account is not active',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const tokens = await tokenStore.listByUser(user.id);
      const availableModels = modelRegistry.getAvailableModels();
      const allModelIds = availableModels.map((model) => model.id);
      const defaultEligibleModelIds = selectDefaultEligibleModelIds(availableModels);
      const metrics = metricsStore
        ? await metricsStore.getMetricsBulk(tokens.map((t) => t.id))
        : {};

      res.status(200).json({
        session,
        user: sanitizeUser(user),
        tokens: tokens.map((token) => ({
          ...sanitizeToken(token, allModelIds, defaultEligibleModelIds),
          metrics: metrics[token.id] ?? { route_requests: 0, cache_hits: 0, throttled_requests: 0 },
        })),
      });
    } catch (error) {
      logger.error('Session validation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to validate session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/logout', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionToken = req.headers[SESSION_TOKEN_HEADER] as string | undefined;
      if (!sessionToken) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing X-Session-Token header',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (!validateUuid(sessionToken)) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid session token format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      await sessionStore.delete(sessionToken);
      res.status(200).json({
        message: 'Session cleared',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Session logout failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to clear session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/elevate', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionToken = req.headers[SESSION_TOKEN_HEADER] as string | undefined;
      if (!sessionToken) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing X-Session-Token header',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (!validateUuid(sessionToken)) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid session token format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const parsed = SessionElevateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const expectedKey = process.env.ADMIN_API_KEY;
      if (!expectedKey) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'ADMIN_API_KEY not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!timingSafeEqual(parsed.data.admin_api_key, expectedKey)) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid admin key',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const elevated = await sessionStore.elevate(sessionToken);
      if (!elevated) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or expired session',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        session_token: elevated.token,
        session: elevated.session,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Session elevation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to elevate session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
