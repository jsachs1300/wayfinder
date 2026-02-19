import type { Request, Response, NextFunction } from 'express';
import type { TokenStore } from './store';
import type { TokenConfigExtended } from './types';

/**
 * Resolves :token_id for session-authenticated route playground requests.
 * Ensures the selected token exists and belongs to the authenticated user.
 */
export function sessionRouteTokenMiddleware(tokenStore: TokenStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tokenId = req.params.token_id;
    if (!tokenId) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Missing token_id route parameter',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!req.user?.id) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Session authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const token = await tokenStore.getById(tokenId) as TokenConfigExtended | null;
    if (!token) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Token not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Session route can only be used with user-owned tokens.
    if (!token.user_id || token.user_id !== req.user.id) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Token is not accessible for this session',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    req.tokenConfig = token;
    next();
  };
}
