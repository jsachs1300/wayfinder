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
import { RoutingEngine } from './engine';
import { projectRouteResponse } from './projection';
import type { RouteRequest, RoutingDecisionLogEvent, RoutingErrorLogEvent, RouterModelPreference } from '../types/index';
import { VALID_ROUTER_MODEL_PREFERENCES } from '../types/index';
import type { Logger } from '../logging/logger';
import { z, ZodError } from 'zod';
import { logRoutingUsage } from '../observability/events';
import { recordRoutingFallback, recordRoutingRequest } from '../observability/metrics';

/**
 * Create SHA256 hash of prompt for privacy-safe logging
 */
function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

const RouterModelPreferenceSchema = z.enum(
  [...VALID_ROUTER_MODEL_PREFERENCES] as [RouterModelPreference, ...RouterModelPreference[]]
);

const RouteRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  context: z.record(z.unknown()).optional(),
  prefer_model: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  router_model: RouterModelPreferenceSchema.optional(),
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

      // Prepare user context for routing engine (if user is authenticated)
      const userContext = req.user ? {
        user: req.user,
        userTier: req.userTier,
      } : undefined;

      recordRoutingRequest({
        token_tier: req.userTier,
        router_model_requested: routeRequest.router_model ?? req.tokenConfig.router_model_preference ?? 'consensus',
      });

      // Get routing decision from engine (includes intent and policy metadata)
      // The engine handles policy evaluation and logging internally
      const routingStart = Date.now();
      const result = await routingEngine.route(
        routeRequest,
        req.tokenConfig,
        req.requestId,
        userContext,
      );
      const routingDurationMs = Date.now() - routingStart;

      // Structured logging for routing decision per REQUIREMENTS.md §12
      // Note: Policy details are logged by the routing engine during evaluation
      const logEvent: RoutingDecisionLogEvent = {
        event_type: 'routing_decision',
        timestamp: new Date().toISOString(),
        request_id: req.requestId || 'unknown',
        token_id: req.tokenConfig.id,
        prompt_length: routeRequest.prompt.length,
        prompt_hash: hashPrompt(routeRequest.prompt),
        primary_model: result.decision.primary.model,
        primary_score: result.decision.primary.score,
        primary_reason: result.decision.primary.reason,
        alternate_model: result.decision.alternate.model,
        alternate_score: result.decision.alternate.score,
        alternate_reason: result.decision.alternate.reason,
        intent: result.decision.intent,
        policy_applied: result.policyMetadata.forcedModel !== null ||
                       (req.tokenConfig.allowed_models !== undefined && req.tokenConfig.allowed_models.length > 0) ||
                       (req.tokenConfig.denied_models !== undefined && req.tokenConfig.denied_models.length > 0) ||
                       (req.tokenConfig.policy_rules !== undefined && req.tokenConfig.policy_rules.length > 0),
        forced_model: result.policyMetadata.forcedModel,
        eligible_models_count: result.policyMetadata.eligibleModelsCount,
        knowledge_scope: req.tokenConfig.knowledge_scope || 'global',
        environment: req.tokenConfig.environment,
      };

      logger.info('Routing decision completed', logEvent);

      // Determine if we fell back to a different router
      const requestedRouter = routeRequest.router_model || req.tokenConfig.router_model_preference || 'consensus';
      const usedRouter = result.router_model_used || 'consensus';
      const didFallback = requestedRouter !== usedRouter;
      if (didFallback) {
        recordRoutingFallback({
          token_tier: req.userTier,
          router_model_requested: requestedRouter,
          router_model_used: usedRouter,
        });
      }

      logRoutingUsage(logger, {
        request_id: req.requestId,
        token_id: req.tokenConfig.id,
        user_id: req.user?.id,
        token_tier: req.userTier,
        router_model_requested: requestedRouter,
        router_model_used: usedRouter,
        cache_hit: result.cache_hit ?? false,
        llm_call: !(result.cache_hit ?? false),
        llm_latency_ms: result.cache_hit ? undefined : routingDurationMs,
        eligible_models_count: result.policyMetadata.eligibleModelsCount,
      });

      // HTTP status: 200 for success, 203 for fallback to different provider
      const statusCode = didFallback ? 203 : 200;

      // Project to user-facing response (drops intent)
      const response = projectRouteResponse(
        result.decision,
        req.requestId || 'unknown',
        usedRouter,
        result.cache_hit || false
      );

      res.status(statusCode).json(response);
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
