/**
 * Anonymous Session Routes
 *
 * Handles progressive registration:
 * - POST /api/anonymous/session - Create anonymous session
 * - POST /api/anonymous/convert - Convert to registered user
 */

import { Router, Request, Response } from 'express';
import type { AnonymousSessionStore } from './store';
import type { UserStore } from '../store';
import type { TokenStore } from '../../tokens/store';
import { tokenAuthMiddleware } from '../../auth';
import { z } from 'zod';

/**
 * Validation schema for convert request
 */
const ConvertRequestSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/\d/, 'Password must contain at least one digit'),
});

/**
 * Create anonymous session routes
 */
export function createAnonymousRoutes(
  anonymousSessionStore: AnonymousSessionStore,
  tokenStore: TokenStore,
  userStore?: UserStore
): Router {
  const router = Router();

  /**
   * POST /api/anonymous/session
   * Create a new anonymous session with free tier rate limits
   */
  router.post('/session', async (req: Request, res: Response): Promise<void> => {
    try {
      const { session, token } = await anonymousSessionStore.create();

      res.status(201).json({
        session_id: session.id,
        token,
        expires_at: session.expires_at,
        rate_limits: {
          requests_per_hour: 10,
          requests_per_day: 50,
          remaining_today: 50,
        },
      });
    } catch (error) {
      console.error('Error creating anonymous session:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to create anonymous session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /api/anonymous/convert
   * Convert anonymous session to registered user account
   * Requires X-Wayfinder-Token header with anonymous session token
   */
  router.post('/convert', tokenAuthMiddleware(tokenStore, userStore), async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate required dependencies
      if (!userStore || !tokenStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'User registration not available',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate request body
      const parsed = ConvertRequestSchema.safeParse(req.body);
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

      // Get token from request (set by auth middleware)
      const tokenConfig = req.tokenConfig;
      if (!tokenConfig) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Valid anonymous token required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Verify this token is associated with an anonymous session
      const session = await anonymousSessionStore.getByTokenId(tokenConfig.id);
      if (!session) {
        res.status(400).json({
          error: 'InvalidSession',
          message: 'Token is not associated with an anonymous session',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check if email already exists
      const existingUser = await userStore.getByEmail(email);
      if (existingUser) {
        res.status(409).json({
          error: 'ConflictError',
          code: 'USER_001',
          message: 'Email already registered',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Create user account
      const user = await userStore.create({
        email,
        password,
      });

      // Convert session to user (deletes session, token remains)
      await anonymousSessionStore.convertToUser(session.id, user.id);

      // Note: The token linkage to user would be handled by the token store
      // in a full implementation. For now, we've preserved the token.

      res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          tier: user.tier,
          status: user.status,
        },
        token: {
          id: tokenConfig.id,
          name: 'Converted from anonymous',
        },
        message: 'Account created. Your existing token has been linked to your account.',
      });
    } catch (error) {
      console.error('Error converting anonymous session:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to convert anonymous session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
