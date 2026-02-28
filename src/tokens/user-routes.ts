import { Router, Request, Response } from 'express';
import { TokenStore } from './store';
import type { TokenMetricsStore } from './metrics';
import { TokenConfigExtended } from './types';
import {
  TokenConfig,
  TokenCreateRequest,
  TokenUpdateRequest,
  VALID_ROUTER_MODEL_PREFERENCES,
  type RouterModelPreference,
} from '../types';
import { ModelRegistry, ModelValidationError } from '../models';
import type { DefaultTokenProfileStore } from './default-profile-store';
import { isDefaultToken, resolveEligibleModels, selectDefaultEligibleModelIds } from './utils';
import { User } from '../users/types';
import { z } from 'zod';
import { logTokenEvent } from '../observability/events';
import { recordTokenCreated, recordTokenDeleted, recordTokenRotated } from '../observability/metrics';
import type { Logger } from '../logging/logger';

interface IdParams {
  id: string;
}

const PolicyRuleSchema = z.object({
  type: z.enum(['ForceModelByIntent', 'RestrictModelsByIntent', 'AllowModelsGlobal', 'DenyModelsGlobal']),
  intent: z.enum(['code_review', 'coding', 'legal', 'summarization', 'reasoning', 'creative', 'support', 'other']).optional(),
  models: z.array(z.string()),
  priority: z.number().optional(),
});

const RouterModelPreferenceSchema = z.enum(
  [...VALID_ROUTER_MODEL_PREFERENCES] as [RouterModelPreference, ...RouterModelPreference[]]
);

const UserTokenCreateSchema = z.object({
  name: z.string().optional(),
  trusted_anchor_model: z.string().optional(),
  allowed_models: z.array(z.string()).optional(),
  denied_models: z.array(z.string()).optional(),
  eligible_models: z.array(z.string()).optional(),
  policy_rules: z.array(PolicyRuleSchema).optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  logging_level: z.enum(['normal', 'verbose']).optional(),
  environment: z.enum(['prod', 'dev']).optional(),
  knowledge_scope: z.enum(['global', 'token', 'org', 'hybrid']).optional(),
  router_model_preference: RouterModelPreferenceSchema.optional(),
});

const MAX_TOKENS_PER_USER = parseInt(process.env.MAX_TOKENS_PER_USER || '10', 10);

/**
 * Extended request with user context
 */
interface AuthenticatedRequest extends Request {
  user?: User;
  tokenConfig?: TokenConfig;
}

/**
 * Create user-facing routes for token management
 */
export function createUserTokenRoutes(
  tokenStore: TokenStore,
  modelRegistry: ModelRegistry,
  logger: Logger,
  metricsStore?: TokenMetricsStore,
  cache?: { clearByScope: (tokenId: string) => Promise<void> },
  defaultTokenProfileStore?: DefaultTokenProfileStore
): Router {
  const router = Router();

  const resolveDefaultEligibleModelIds = async (
    availableModels: ReturnType<ModelRegistry['getAvailableModels']>
  ): Promise<readonly string[]> => {
    if (!defaultTokenProfileStore) {
      return selectDefaultEligibleModelIds(availableModels);
    }
    const resolved = await defaultTokenProfileStore.resolveForModels(availableModels);
    return resolved.effective_model_ids;
  };

  // List user's tokens
  router.get('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'AUTH_003',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const tokens = await tokenStore.listByUser(req.user.id);
      const availableModels = modelRegistry.getAvailableModels();
      const availableModelIds = availableModels.map((model) => model.id);
      const defaultEligibleModelIds = await resolveDefaultEligibleModelIds(availableModels);
      const metrics = metricsStore
        ? await metricsStore.getMetricsBulk(tokens.map((t) => t.id))
        : {};

      res.json({
        tokens: tokens.map((t) => ({
          id: t.id,
          name: t.name,
          environment: t.environment,
          eligible_models: resolveEligibleModels(t, availableModelIds, defaultEligibleModelIds),
          created_at: t.created_at,
          updated_at: t.updated_at,
          rotated_at: t.rotated_at,
          metrics: metrics[t.id] ?? { route_requests: 0, cache_hits: 0, throttled_requests: 0 },
        })),
        count: tokens.length,
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to list tokens',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Create new token for user
  router.post('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'AUTH_003',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const parsed = UserTokenCreateSchema.safeParse(req.body);
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

      // Check token limit
      const existingTokens = await tokenStore.listByUser(req.user.id);
      if (existingTokens.length >= MAX_TOKENS_PER_USER) {
        res.status(400).json({
          error: 'TokenLimitExceeded',
          code: 'TOKEN_004',
          message: `Token limit exceeded. Maximum ${MAX_TOKENS_PER_USER} tokens per user allowed.`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const request: TokenCreateRequest = {
        ...parsed.data,
        eligible_models:
          parsed.data.eligible_models && parsed.data.eligible_models.length > 0
            ? parsed.data.eligible_models
            : modelRegistry
              .getEffectiveModelsForUser(req.user.id)
              .filter((model) => model.available)
              .map((model) => model.id),
      };

      // Validate all model identifiers against the registry
      try {
        modelRegistry.validateTokenConfig(request, req.user.id);
      } catch (error) {
        if (error instanceof ModelValidationError) {
          res.status(400).json({
            error: error.name,
            message: error.message,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        throw error;
      }

      // Create token with user_id
      const result = await tokenStore.createForUser(req.user.id, parsed.data.name ?? null, request);

      res.status(201).json({
        id: result.id,
        token: result.token,
        name: result.config.name,
        config: {
          ...result.config,
          token_hash: undefined, // Never expose hash
          user_id: undefined, // Don't expose user_id in response
        },
      });
      logTokenEvent(logger, {
        event_type: 'token_created',
        token_id: result.id,
        user_id: req.user.id,
        eligible_models: result.config.eligible_models,
      });
      recordTokenCreated();
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to create token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Delete user's token
  router.delete('/:id', async (req: Request<IdParams> & AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'AUTH_003',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { id } = req.params;
      const existing = await tokenStore.getById(id);
      const result = await tokenStore.deleteUserToken(req.user.id, id);
      if (!result.deleted) {
        if (result.reason === 'not_found') {
          res.status(404).json({
            error: 'NotFound',
            code: 'TOKEN_001',
            message: 'Token not found',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        if (result.reason === 'not_owner') {
          res.status(403).json({
            error: 'Forbidden',
            code: 'TOKEN_003',
            message: 'Token does not belong to user',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        if (result.reason === 'last_token') {
          res.status(403).json({
            error: 'Forbidden',
            code: 'TOKEN_005',
            message: 'Cannot delete the last remaining token',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      if (metricsStore) {
        try {
          await metricsStore.deleteMetrics(id);
        } catch (metricsError) {
          console.error('Failed to clear metrics for token:', id, metricsError);
        }
      }

      // Clear cache only after successful deletion.
      // Skip scoped clear for default tokens because they use global cache scope.
      if (cache && (!existing || !isDefaultToken(existing))) {
        try {
          await cache.clearByScope(id);
        } catch (cacheError) {
          // Log but don't fail deletion if cache clear fails
          console.error('Failed to clear cache for token:', id, cacheError);
        }
      }

      res.status(204).send();
      logTokenEvent(logger, {
        event_type: 'token_deleted',
        token_id: id,
        user_id: req.user.id,
      });
      recordTokenDeleted();
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to delete token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Rotate token
  router.post('/:id/rotate', async (req: Request<IdParams> & AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'AUTH_003',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { id } = req.params;
      const token = await tokenStore.getById(id) as TokenConfigExtended | null;

      if (!token) {
        res.status(404).json({
          error: 'NotFound',
          code: 'TOKEN_001',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Verify user owns the token
      if (token.user_id !== req.user.id) {
        res.status(403).json({
          error: 'Forbidden',
          code: 'TOKEN_003',
          message: 'Token does not belong to user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await tokenStore.rotate(id);

      if (!result) {
        res.status(404).json({
          error: 'NotFound',
          code: 'TOKEN_001',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        token: result.token,
        rotated_at: result.config.rotated_at,
      });
      logTokenEvent(logger, {
        event_type: 'token_rotated',
        token_id: id,
        user_id: req.user.id,
      });
      recordTokenRotated();
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to rotate token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
