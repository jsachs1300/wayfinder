import { Request, Response, NextFunction } from 'express';
import { TokenStore } from '../tokens/store';
import { UserStore } from '../users/store';
import type { SessionStore } from '../sessions/store';
import { TokenConfigExtended } from '../tokens/types';
import { UserTier } from '../users/types';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const WAYFINDER_TOKEN_HEADER = 'x-wayfinder-token';
const ADMIN_API_KEY_HEADER = 'x-admin-api-key';
const SESSION_TOKEN_HEADER = 'x-session-token';

/**
 * Hash a token for secure storage comparison
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Middleware to authenticate requests using X-Wayfinder-Token header
 * Enhanced to support user authentication and tier determination
 */
export function tokenAuthMiddleware(tokenStore: TokenStore, userStore?: UserStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = req.headers[WAYFINDER_TOKEN_HEADER] as string | undefined;

    if (!token) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing X-Wayfinder-Token header',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const tokenHash = hashToken(token);
    const tokenConfig = await tokenStore.getByHash(tokenHash);

    if (!tokenConfig) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Attach token config to request
    req.tokenConfig = tokenConfig;
    req.requestId = uuidv4();

    // Check if token has user association (new user tokens)
    const tokenExtended = tokenConfig as TokenConfigExtended;

    if (tokenExtended.user_id && userStore) {
      // Token is associated with a user - load full user object
      const user = await userStore.getById(tokenExtended.user_id);

      if (!user) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'User not found for token',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check if user account is suspended
      if (user.status === 'suspended') {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Account suspended',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check if user account is deleted
      if (user.status === 'deleted') {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Account deleted',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Attach user and tier to request
      req.user = user;
      req.userTier = user.tier;
    } else {
      // Legacy admin token (no user_id) - apply admin tier
      req.userTier = 'admin';
    }

    next();
  };
}

/**
 * Middleware to authenticate requests using X-Session-Token header
 * Attaches user and session context for frontend sessions.
 */
export function sessionAuthMiddleware(sessionStore: SessionStore, userStore: UserStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sessionToken = req.headers[SESSION_TOKEN_HEADER] as string | undefined;

    if (!sessionToken) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing X-Session-Token header',
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
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not found for session',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (user.status === 'suspended') {
      await sessionStore.delete(sessionToken);
      res.status(403).json({
        error: 'Forbidden',
        message: 'Account suspended',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (user.status === 'deleted') {
      await sessionStore.delete(sessionToken);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Account deleted',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    req.user = user;
    req.userTier = user.tier;
    req.session = session;
    req.requestId = uuidv4();

    next();
  };
}

/**
 * Middleware to authenticate either session or token for user routes
 */
export function userAuthMiddleware(
  tokenStore: TokenStore,
  userStore: UserStore,
  sessionStore?: SessionStore
) {
  const tokenAuth = tokenAuthMiddleware(tokenStore, userStore);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sessionToken = req.headers[SESSION_TOKEN_HEADER] as string | undefined;
    if (sessionToken && sessionStore) {
      return sessionAuthMiddleware(sessionStore, userStore)(req, res, next);
    }
    return tokenAuth(req, res, next);
  };
}

/**
 * Middleware to authenticate admin requests using ADMIN_API_KEY
 */
export function adminAuthMiddleware(sessionStore?: SessionStore, userStore?: UserStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const adminKey = req.headers[ADMIN_API_KEY_HEADER] as string | undefined;
    const expectedKey = process.env.ADMIN_API_KEY;
    const sessionToken = req.headers[SESSION_TOKEN_HEADER] as string | undefined;

    if (!expectedKey && !sessionStore) {
      res.status(500).json({
        error: 'ConfigurationError',
        message: 'ADMIN_API_KEY not configured',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (adminKey && expectedKey) {
      if (!timingSafeEqual(adminKey, expectedKey)) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid admin key',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      req.requestId = uuidv4();
      next();
      return;
    }

    if (sessionToken && sessionStore && userStore) {
      const session = await sessionStore.getByToken(sessionToken);
      if (session?.is_admin) {
        const user = await userStore.getById(session.user_id);
        if (user && user.status === 'active') {
          req.user = user;
          req.userTier = 'admin';
          req.session = session;
        } else {
          await sessionStore.delete(sessionToken);
          res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or suspended admin session',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        req.requestId = uuidv4();
        next();
        return;
      }
    }

    res.status(401).json({
      error: 'Unauthorized',
      message: adminKey
        ? 'Invalid admin key'
        : 'Missing X-Admin-Api-Key or X-Session-Token header',
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Timing-safe string comparison
 */
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

/**
 * Middleware to add request ID to all requests
 */
export function requestIdMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.requestId) {
      req.requestId = uuidv4();
    }
    next();
  };
}

/**
 * Middleware to require authenticated user (must have user object attached)
 * Use after tokenAuthMiddleware to ensure user routes are protected
 */
export function requireUserAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
