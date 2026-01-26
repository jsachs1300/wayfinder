/**
 * User Management Routes
 *
 * Implements user registration, login, and profile management endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { UserStore } from './store';
import type { User } from './types';
import { TokenStore } from '../tokens/store';
import { validateEmail, validatePassword } from './validation';
import { logTokenEvent, logUserLoggedIn, logUserRegistered } from '../observability/events';
import { recordTokenCreated, recordUserLoggedIn, recordUserRegistered } from '../observability/metrics';
import { verifyPassword, DUMMY_PASSWORD_HASH } from './password';
import type { Logger } from '../logging/logger';
import { sanitizeUser } from './sanitize';
import { sanitizeToken } from '../tokens/sanitize';
import type { UserVerificationStore } from './verification-store';
import type { Mailer } from '../email';

/**
 * Zod schema for user registration
 */
const UserRegisterSchema = z.object({
  email: z.string().min(1, 'Email is required'),
});

/**
 * Zod schema for user login
 */
const UserLoginSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

const EmailTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

const CompleteRegistrationSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(1, 'Password is required'),
});

const ForgotPasswordSchema = z.object({
  email: z.string().min(1, 'Email is required'),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(1, 'Password is required'),
});

function getFrontendBaseUrl(): string {
  return process.env.FRONTEND_BASE_URL ?? 'http://localhost:3000';
}

function shouldReturnDebugToken(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function getVerificationTtlSeconds(): number {
  const value = Number(process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 24);
  if (Number.isNaN(value) || value <= 0) {
    return 24 * 60 * 60;
  }
  return Math.floor(value * 60 * 60);
}

function getResetTtlSeconds(): number {
  const value = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30);
  if (Number.isNaN(value) || value <= 0) {
    return 30 * 60;
  }
  return Math.floor(value * 60);
}

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
  verificationStore?: UserVerificationStore,
  sessionStore?: { deleteAllByUserId: (userId: string) => Promise<void> },
  userAuth?: (req: Request, res: Response, next: () => void) => void,
  mailer?: Mailer
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

      const { email } = parsed.data;

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

      if (!verificationStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'Email verification is not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const existing = await userStore.getByEmail(email);
      if (existing) {
        if (existing.status === 'active') {
          res.status(200).json({
            message: 'If an account exists, a verification email has been sent.',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const verificationToken = await verificationStore.createEmailVerification(
          existing.id,
          existing.email,
          getVerificationTtlSeconds()
        );
        const verifyLink = `${getFrontendBaseUrl()}/verify-email?token=${verificationToken}`;
        logger.info('User verification resend requested', {
          user_id: existing.id,
          email: existing.email,
          timestamp: new Date().toISOString(),
        });
        try {
          await mailer?.sendEmailVerification(existing.email, verifyLink);
        } catch (emailError) {
          logger.error('Failed to send verification email', {
            user_id: existing.id,
            error: emailError instanceof Error ? emailError.message : String(emailError),
          });
        }

        res.status(200).json({
          message: 'If an account exists, a verification email has been sent.',
          ...(shouldReturnDebugToken() ? { verification_token: verificationToken } : {}),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      let user: User;
      try {
        user = await userStore.createPending({ email });
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

      const verificationToken = await verificationStore.createEmailVerification(
        user.id,
        user.email,
        getVerificationTtlSeconds()
      );
      const verifyLink = `${getFrontendBaseUrl()}/verify-email?token=${verificationToken}`;
      logger.info('User registration initiated', {
        user_id: user.id,
        email: user.email,
        timestamp: new Date().toISOString(),
      });
      try {
        await mailer?.sendEmailVerification(user.email, verifyLink);
      } catch (emailError) {
        logger.error('Failed to send verification email', {
          user_id: user.id,
          error: emailError instanceof Error ? emailError.message : String(emailError),
        });
      }

      res.status(200).json({
        message: 'If an account exists, a verification email has been sent.',
        ...(shouldReturnDebugToken() ? { verification_token: verificationToken } : {}),
        timestamp: new Date().toISOString(),
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

      // Always verify password to prevent timing attacks
      // Use a dummy hash if user doesn't exist (bcrypt hash format with work factor 12)
      const hashToVerify = user?.password_hash ?? DUMMY_PASSWORD_HASH;
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

      if (user.status === 'pending') {
        res.status(403).json({
          error: 'Forbidden',
          code: 'AUTH_002',
          message: 'Email not verified',
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
   * POST /api/users/verify-email
   * Validate an email verification token (non-consuming).
   */
  router.post('/verify-email', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = EmailTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!verificationStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'Email verification is not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const record = await verificationStore.getEmailVerification(parsed.data.token);
      if (!record) {
        res.status(400).json({
          error: 'InvalidToken',
          message: 'Verification token is invalid or expired',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        valid: true,
        email: record.email,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Email verification check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to verify email',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /api/users/complete-registration
   * Consume verification token, set password, and activate user.
   */
  router.post('/complete-registration', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = CompleteRegistrationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const passwordValidation = validatePassword(parsed.data.password);
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

      if (!verificationStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'Email verification is not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const record = await verificationStore.consumeEmailVerification(parsed.data.token);
      if (!record) {
        res.status(400).json({
          error: 'InvalidToken',
          message: 'Verification token is invalid or expired',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const user = await userStore.getById(record.user_id);
      if (!user) {
        res.status(404).json({
          error: 'NotFound',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (user.status === 'active') {
        res.status(409).json({
          error: 'ConflictError',
          message: 'Email is already verified',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const updated = await userStore.update(user.id, {
        password: parsed.data.password,
        status: 'active',
      });
      if (!updated) {
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to activate user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const tokenResult = await tokenStore.createForUser(
        updated.id,
        'Default Token',
        {
          environment: 'dev',
          confidence_threshold: 0.6,
          logging_level: 'normal',
          knowledge_scope: 'global',
        }
      );

      logger.info('User registration completed', {
        user_id: updated.id,
        email: updated.email,
        tier: updated.tier,
        timestamp: new Date().toISOString(),
      });
      logUserRegistered(logger, { user_id: updated.id, email: updated.email });
      recordUserRegistered();

      res.status(201).json({
        user: sanitizeUser(updated),
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
        user_id: updated.id,
        is_primary: tokenResult.config.is_primary || true,
        eligible_models: tokenResult.config.eligible_models,
      });
      recordTokenCreated();
    } catch (error) {
      logger.error('Complete registration failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to complete registration',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /api/users/password/forgot
   * Request a password reset link (always 200).
   */
  router.post('/password/forgot', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = ForgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { email } = parsed.data;
      if (!validateEmail(email)) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid email format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!verificationStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'Password reset is not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const user = await userStore.getByEmail(email);
      if (user && user.status === 'active') {
        const resetToken = await verificationStore.createPasswordReset(
          user.id,
          user.email,
          getResetTtlSeconds()
        );
        const resetLink = `${getFrontendBaseUrl()}/reset-password?token=${resetToken}`;
        logger.info('Password reset requested', {
          user_id: user.id,
          email: user.email,
          timestamp: new Date().toISOString(),
        });
        try {
          await mailer?.sendPasswordReset(user.email, resetLink);
        } catch (emailError) {
          logger.error('Failed to send password reset email', {
            user_id: user.id,
            error: emailError instanceof Error ? emailError.message : String(emailError),
          });
        }

        res.status(200).json({
          message: 'If an account exists, a reset link has been sent.',
          ...(shouldReturnDebugToken() ? { reset_token: resetToken } : {}),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        message: 'If an account exists, a reset link has been sent.',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Password reset request failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to request password reset',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /api/users/password/validate
   * Validate a password reset token.
   */
  router.post('/password/validate', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = EmailTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!verificationStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'Password reset is not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const record = await verificationStore.getPasswordReset(parsed.data.token);
      if (!record) {
        res.status(400).json({
          error: 'InvalidToken',
          message: 'Reset token is invalid or expired',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        valid: true,
        email: record.email,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Password reset token validation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to validate reset token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /api/users/password/reset
   * Reset password using a valid token.
   */
  router.post('/password/reset', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = ResetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const passwordValidation = validatePassword(parsed.data.password);
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

      if (!verificationStore) {
        res.status(500).json({
          error: 'ConfigurationError',
          message: 'Password reset is not configured',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const record = await verificationStore.consumePasswordReset(parsed.data.token);
      if (!record) {
        res.status(400).json({
          error: 'InvalidToken',
          message: 'Reset token is invalid or expired',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const user = await userStore.getById(record.user_id);
      if (!user) {
        res.status(404).json({
          error: 'NotFound',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (user.status !== 'active') {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Account is not active',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const updated = await userStore.update(user.id, { password: parsed.data.password });
      if (!updated) {
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to reset password',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      await sessionStore?.deleteAllByUserId(user.id);

      res.status(200).json({
        message: 'Password updated.',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Password reset failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to reset password',
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
