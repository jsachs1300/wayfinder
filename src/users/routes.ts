/**
 * User Management Routes
 *
 * Implements user registration, login, and profile management endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { UserStore } from './store';
import { TokenStore } from '../tokens/store';
import { validateEmail, validatePassword } from './validation';
import { logTokenEvent, logUserLoggedIn, logUserRegistered } from '../observability/events';
import { recordTokenCreated, recordUserLoggedIn, recordUserRegistered } from '../observability/metrics';
import { verifyPassword } from './password';
import type { Logger } from '../logging/logger';
import { sanitizeUser } from './sanitize';
import { sanitizeToken } from '../tokens/sanitize';

/**
 * Zod schema for user registration
 */
const UserRegisterSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Zod schema for user login
 */
const UserLoginSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Zod schema for user profile update
 */
const UserUpdateSchema = z.object({
  email: z.string().optional(),
  password: z.string().optional(),
}).refine(data => data.email || data.password, {
  message: 'At least one field (email or password) must be provided',
});

/**
 * Create user routes
 */
export function createUserRoutes(
  userStore: UserStore,
  tokenStore: TokenStore,
  logger: Logger,
  userAuth?: (req: Request, res: Response, next: () => void) => void
): Router {
  const router = Router();

  /**
   * POST /api/users/register
   * Create a new user account
   */
  router.post('/register', async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request body schema
      const parsed = UserRegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'VAL_003',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { email, password } = parsed.data;

      // Validate email format
      if (!validateEmail(email)) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'VAL_001',
          message: 'Invalid email format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate password requirements
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'VAL_002',
          message: 'Password does not meet requirements',
          details: passwordValidation.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Create user (password will be hashed internally by store)
      let user: User;
      try {
        user = await userStore.create({
          email,
          password,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'Email already registered') {
          res.status(409).json({
            error: 'ConflictError',
            code: 'USER_001',
            message: 'Email already registered',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        throw error;
      }

      // Create primary token for user
      const tokenResult = await tokenStore.createForUser(
        user.id,
        'Default Token',
        {
          environment: 'dev',
          confidence_threshold: 0.6,
          logging_level: 'normal',
          knowledge_scope: 'global',
        }
      );

      logger.info('User registered', {
        user_id: user.id,
        email: user.email,
        tier: user.tier,
        timestamp: new Date().toISOString(),
      });
      logUserRegistered(logger, { user_id: user.id, email: user.email });
      recordUserRegistered();

      res.status(201).json({
        user: sanitizeUser(user),
        token: {
          id: tokenResult.id,
          token: tokenResult.token,
          name: tokenResult.config.name || 'Default Token',
          is_primary: tokenResult.config.is_primary || true,
        },
      });
      logTokenEvent(logger, {
        event_type: 'token_created',
        token_id: tokenResult.id,
        user_id: user.id,
        is_primary: tokenResult.config.is_primary || true,
        eligible_models: tokenResult.config.eligible_models,
      });
      recordTokenCreated();
    } catch (error) {
      logger.error('User registration failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });

      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to register user',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /api/users/login
   * Authenticate user and return user data + tokens
   */
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request body schema
      const parsed = UserLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'VAL_003',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { email, password } = parsed.data;

      // Get user by email
      const user = await userStore.getByEmail(email);

      // Always verify password to prevent timing attacks
      // Use a dummy hash if user doesn't exist (bcrypt hash format with work factor 12)
      const hashToVerify = user?.password_hash ??
        '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5jtRBzC3yRqb.'; // "password"
      const isValidPassword = await verifyPassword(password, hashToVerify);

      // Generic error message for both non-existent user and wrong password
      if (!user || !isValidPassword) {
        if (!user) {
          logger.warn('Login attempt with non-existent email', {
            email,
            timestamp: new Date().toISOString(),
          });
        } else {
          logger.warn('Failed login attempt', {
            user_id: user.id,
            email: user.email,
            timestamp: new Date().toISOString(),
          });
        }

        res.status(401).json({
          error: 'AuthenticationError',
          code: 'AUTH_001',
          message: 'Invalid email or password',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check if account is suspended
      if (user.status === 'suspended') {
        logger.warn('Login attempt for suspended account', {
          user_id: user.id,
          email: user.email,
          timestamp: new Date().toISOString(),
        });

        res.status(403).json({
          error: 'ForbiddenError',
          code: 'AUTH_002',
          message: 'Account suspended',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Note: authenticate() already updates last_login_at in the store

      // Get user's tokens
      const tokens = await tokenStore.listByUser(user.id);

      logger.info('User logged in', {
        user_id: user.id,
        email: user.email,
        timestamp: new Date().toISOString(),
      });
      logUserLoggedIn(logger, { user_id: user.id, email: user.email });
      recordUserLoggedIn();

      res.status(200).json({
        user: sanitizeUser(user),
        tokens: tokens.map(sanitizeToken),
      });
    } catch (error) {
      logger.error('User login failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });

      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to login',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * GET /api/users/me
   * Get current user profile (requires authentication)
   */
  router.get('/me', userAuth ?? ((_req, _res, next) => next()), async (req: Request, res: Response): Promise<void> => {
    try {
      // User should be attached by auth middleware
      const userId = (req as any).user?.id;

      if (!userId) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'AUTH_003',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const user = await userStore.getById(userId);

      if (!user) {
        res.status(404).json({
          error: 'NotFound',
          code: 'USER_002',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json(sanitizeUser(user));
    } catch (error) {
      logger.error('Failed to get user profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });

      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get user profile',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * PATCH /api/users/me
   * Update current user profile (requires authentication)
   */
  router.patch('/me', userAuth ?? ((_req, _res, next) => next()), async (req: Request, res: Response): Promise<void> => {
    try {
      // User should be attached by auth middleware
      const userId = (req as any).user?.id;

      if (!userId) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'AUTH_003',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate request body schema
      const parsed = UserUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'VAL_003',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { email, password } = parsed.data;

      // Validate email if provided
      if (email && !validateEmail(email)) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'VAL_001',
          message: 'Invalid email format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate password if provided
      if (password) {
        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
          res.status(400).json({
            error: 'ValidationError',
            code: 'VAL_002',
            message: 'Password does not meet requirements',
            details: passwordValidation.errors,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      // Hash password if provided
      const updateRequest: any = {};
      if (email) {
        updateRequest.email = email;
      }
      if (password) {
        // Password will be hashed internally by store
        updateRequest.password = password;
      }

      // Update user
      let updatedUser: User | null;
      try {
        updatedUser = await userStore.update(userId, updateRequest);
      } catch (error) {
        if (error instanceof Error && error.message === 'Email already registered') {
          res.status(409).json({
            error: 'ConflictError',
            code: 'USER_001',
            message: 'Email already registered',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        throw error;
      }

      if (!updatedUser) {
        res.status(404).json({
          error: 'NotFound',
          code: 'USER_002',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      logger.info('User profile updated', {
        user_id: userId,
        fields_updated: Object.keys(updateRequest),
        timestamp: new Date().toISOString(),
      });

      res.status(200).json(sanitizeUser(updatedUser));
    } catch (error) {
      logger.error('Failed to update user profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });

      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to update user profile',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
