import { Router, Request, Response } from 'express';
import { RoutingEngine } from './engine';
import { RouteRequest } from '../types';
import { z } from 'zod';
import {
  emitRoutingDecisionLog,
  createRoutingDecisionLog,
} from '../logging/routing-decision';

const RouteRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  context: z.record(z.unknown()).optional(),
  prefer_model: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Create routing routes
 */
export function createRoutingRoutes(routingEngine: RoutingEngine): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request body
      const parsed = RouteRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Ensure token config exists (should be set by auth middleware)
      if (!req.tokenConfig) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Token configuration not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const routeRequest: RouteRequest = parsed.data;
      const response = await routingEngine.route(
        routeRequest,
        req.tokenConfig,
        req.requestId
      );

      // Emit routing decision log
      const decisionLog = createRoutingDecisionLog(response, req.tokenConfig);
      emitRoutingDecisionLog(decisionLog);

      // Strip internal context before sending response
      const { _internal, ...publicResponse } = response;

      res.json(publicResponse);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to route request',
        details: { error: errorMessage },
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
