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
import { createHash } from 'crypto';
import { RoutingEngine } from './engine.js';
import { projectRouteResponse } from './projection.js';
import type { RouteRequest, RoutingDecisionLogEvent, RoutingErrorLogEvent } from '../types/index.js';
import type { Logger } from '../logging/logger.js';
import { z, ZodError } from 'zod';

/**
 * Create SHA256 hash of prompt for privacy-safe logging
 */
function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

const RouteRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  context: z.record(z.unknown()).optional(),
  prefer_model: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Create routing routes
 */
export function createRoutingRoutes(
  routingEngine: RoutingEngine,
  logger: Logger
): Router {
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
      // The engine handles policy evaluation and logging internally
      const decision = await routingEngine.route(
        routeRequest,
        req.tokenConfig,
        req.requestId,
      );

      // Structured logging for routing decision per REQUIREMENTS.md §12
      // Note: Policy details are logged by the routing engine during evaluation
      const logEvent: RoutingDecisionLogEvent = {
        event_type: 'routing_decision',
        timestamp: new Date().toISOString(),
        request_id: req.requestId || 'unknown',
        token_id: req.tokenConfig.id,
        prompt_length: routeRequest.prompt.length,
        prompt_hash: hashPrompt(routeRequest.prompt),
        primary_model: decision.primary.model,
        primary_score: decision.primary.score,
        primary_reason: decision.primary.reason,
        alternate_model: decision.alternate.model,
        alternate_score: decision.alternate.score,
        alternate_reason: decision.alternate.reason,
        intent: decision.intent,
        policy_applied: req.tokenConfig.policy_rules !== undefined && req.tokenConfig.policy_rules.length > 0,
        forced_model: null, // Determined by engine, not known here
        eligible_models_count: 0, // Determined by engine, not known here
        knowledge_scope: req.tokenConfig.knowledge_scope || 'global',
        environment: req.tokenConfig.environment,
      };

      logger.info('Routing decision completed', logEvent);

      // Project to user-facing response (drops intent)
      const response = projectRouteResponse(decision, req.requestId || 'unknown');

      res.json(response);
    } catch (error) {
      const routeRequest = RouteRequestSchema.safeParse(req.body);
      const prompt = routeRequest.success ? routeRequest.data.prompt : '';

      // Structured error logging
      const errorLogEvent: RoutingErrorLogEvent = {
        event_type: 'routing_error',
        timestamp: new Date().toISOString(),
        request_id: req.requestId || 'unknown',
        token_id: req.tokenConfig?.id || 'unknown',
        error_type: error instanceof ZodError ? 'RouterLLMContractViolation' : 'InternalError',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        prompt_length: prompt.length,
        prompt_hash: prompt ? hashPrompt(prompt) : '',
        stage: error instanceof ZodError ? 'response_validation' : 'unknown',
      };

      logger.error('Routing request failed', errorLogEvent);

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
