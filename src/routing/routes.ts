/**
 * Routing API Routes
 *
 * Handles POST /route requests:
 * 1. Validates request body
 * 2. Invokes routing engine to get RouteDecision
 * 3. Projects RouteDecision to user-facing RouteResponse (drops intent)
 * 4. Returns response to user
 *
 * Intent is logged for internal analysis but excluded from HTTP response.
 */

import { Router, Request, Response } from 'express';
import { RoutingEngine } from './engine.js';
import { projectRouteResponse } from './projection.js';
import type { RouteRequest } from '../types/index.js';
import { z, ZodError } from 'zod';

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

      // Get routing decision from engine (includes intent)
      const decision = await routingEngine.route(
        routeRequest,
        req.tokenConfig,
        req.requestId,
      );

      // TODO: Log intent for internal analysis
      // Intent is advisory only and not used for routing logic
      console.log(`[INTENT] Request ${req.requestId}: ${decision.intent}`);

      // Project to user-facing response (drops intent)
      const response = projectRouteResponse(decision, req.requestId || 'unknown');

      res.json(response);
    } catch (error) {
      // Handle validation errors from router LLM response
      if (error instanceof ZodError) {
        res.status(500).json({
          error: 'RouterLLMContractViolation',
          message: 'Router LLM response violated canonical schema',
          details: error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
