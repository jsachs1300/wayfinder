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
import { hashPassword, verifyPassword } from './password';
import type { User } from './types';
import type { TokenConfigExtended } from '../tokens/types';
import type { Logger } from '../logging/logger';

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
 * Sanitize user object for API response (remove password_hash)
 */
function sanitizeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    tier: user.tier,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  };
}

/**
 * Sanitize token for API response (remove token_hash and sensitive fields)
 */
function sanitizeToken(token: TokenConfigExtended) {
  return {
    id: token.id,
    name: token.name || null,
    is_primary: token.is_primary || false,
    environment: token.environment,
    created_at: token.created_at,
    updated_at: token.updated_at,
  };
}

/**
 * Create user routes
 */
export function createUserRoutes(
  userStore: UserStore,
  tokenStore: TokenStore,
  logger: Logger
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

      // Hash password
      const password_hash = await hashPassword(password);

      // Create user
      let user: User;
      try {
        user = await userStore.create({
          email,
          password: password_hash,
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

      res.status(201).json({
        user: sanitizeUser(user),
        token: {
          id: tokenResult.id,
          token: tokenResult.token,
          name: tokenResult.config.name || 'Default Token',
          is_primary: tokenResult.config.is_primary || true,
        },
      });
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

      // If user doesn't exist, return generic error (don't reveal existence)
      if (!user) {
        logger.warn('Login attempt with non-existent email', {
          email,
          timestamp: new Date().toISOString(),
        });

        res.status(401).json({
          error: 'AuthenticationError',
          code: 'AUTH_001',
          message: 'Invalid email or password',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Verify password (constant-time comparison via bcrypt)
      const isValidPassword = await verifyPassword(password, user.password_hash);

      if (!isValidPassword) {
        logger.warn('Failed login attempt', {
          user_id: user.id,
          email: user.email,
          timestamp: new Date().toISOString(),
        });

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

      // Update last_login_at
      const now = new Date().toISOString();
      user.last_login_at = now;
      user.updated_at = now;
      await userStore.update(user.id, { });

      // Get user's tokens
      const tokens = await tokenStore.listByUser(user.id);

      logger.info('User logged in', {
        user_id: user.id,
        email: user.email,
        timestamp: new Date().toISOString(),
      });

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
  router.get('/me', async (req: Request, res: Response): Promise<void> => {
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
  router.patch('/me', async (req: Request, res: Response): Promise<void> => {
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
        updateRequest.password = await hashPassword(password);
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
