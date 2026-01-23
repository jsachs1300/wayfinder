/**
 * Admin user management routes
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { UserStore } from './store';
import type { SessionStore } from '../sessions/store';
import type { Logger } from '../logging/logger';
import type { UserStatus, UserTier } from './types';
import { sanitizeUser } from './sanitize';

const StatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'deleted']),
});

const TierSchema = z.object({
  tier: z.enum(['free', 'paid_system', 'paid_byollm', 'admin']),
});

export function createAdminUserRoutes(
  userStore: UserStore,
  sessionStore: SessionStore | undefined,
  logger: Logger
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const users = await userStore.list();
      res.status(200).json({
        users: users.map(sanitizeUser),
        count: users.length,
      });
    } catch (error) {
      logger.error('Failed to list users', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to list users',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.patch('/:id/status', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = StatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const userId = req.params.id as string;
      const status = parsed.data.status as UserStatus;
      const updated = await userStore.updateStatus(userId, status);
      if (!updated) {
        res.status(404).json({
          error: 'NotFound',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (status === 'suspended' || status === 'deleted') {
        await sessionStore?.deleteAllByUserId(userId);
      }

      res.status(200).json(sanitizeUser(updated));
    } catch (error) {
      logger.error('Failed to update user status', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to update user status',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.patch('/:id/tier', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = TierSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const userId = req.params.id as string;
      const tier = parsed.data.tier as UserTier;
      const updated = await userStore.updateTier(userId, tier);
      if (!updated) {
        res.status(404).json({
          error: 'NotFound',
          message: 'User not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json(sanitizeUser(updated));
    } catch (error) {
      logger.error('Failed to update user tier', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to update user tier',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
