import { Request, Response, NextFunction } from 'express';
import { TokenStore } from '../tokens/store';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const WAYFINDER_TOKEN_HEADER = 'x-wayfinder-token';
const ADMIN_API_KEY_HEADER = 'x-admin-api-key';

/**
 * Hash a token for secure storage comparison
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Middleware to authenticate requests using X-Wayfinder-Token header
 */
export function tokenAuthMiddleware(tokenStore: TokenStore) {
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

    req.tokenConfig = tokenConfig;
    req.requestId = uuidv4();
    next();
  };
}

/**
 * Middleware to authenticate admin requests using ADMIN_API_KEY
 */
export function adminAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const adminKey = req.headers[ADMIN_API_KEY_HEADER] as string | undefined;
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey) {
      res.status(500).json({
        error: 'ConfigurationError',
        message: 'ADMIN_API_KEY not configured',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!adminKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing X-Admin-Api-Key header',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Constant-time comparison to prevent timing attacks
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
