import { Router, Request, Response } from 'express';
import { TokenStore } from './store';
import {
  TokenCreateRequest,
  TokenUpdateRequest,
  VALID_ROUTER_MODEL_PREFERENCES,
  type RouterModelPreference,
} from '../types';
import { ModelRegistry, ModelValidationError } from '../models';
import { z } from 'zod';

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

const TokenCreateSchema = z.object({
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

const TokenUpdateSchema = TokenCreateSchema.partial();

/**
 * Create admin routes for token management
 */
export function createAdminRoutes(
  tokenStore: TokenStore,
  modelRegistry: ModelRegistry,
  cache?: { clearByScope: (tokenId: string) => Promise<void> }
): Router {
  const router = Router();

  // Create a new token
  router.post('/tokens', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = TokenCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const request: TokenCreateRequest = parsed.data;

      // Validate all model identifiers against the registry
      try {
        modelRegistry.validateTokenConfig(request);
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

      const result = await tokenStore.create(request);

      res.status(201).json({
        id: result.id,
        token: result.token,
        config: {
          ...result.config,
          token_hash: undefined, // Never expose hash
        },
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to create token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Get token by ID
  router.get('/tokens/:id', async (req: Request<IdParams>, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const config = await tokenStore.getById(id);

      if (!config) {
        res.status(404).json({
          error: 'NotFound',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        ...config,
        token_hash: undefined, // Never expose hash
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Update token
  router.patch('/tokens/:id', async (req: Request<IdParams>, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const parsed = TokenUpdateSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const request: TokenUpdateRequest = parsed.data;

      // eligible_models is immutable - cannot be changed after token creation
      if (request.eligible_models !== undefined) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'eligible_models cannot be modified after token creation. This field is immutable to ensure cache consistency.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Get existing token to merge with updates for validation
      const existing = await tokenStore.getById(id);
      if (!existing) {
        res.status(404).json({
          error: 'NotFound',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Merge existing config with updates for validation
      const mergedConfig = { ...existing, ...request };

      // Validate the merged configuration
      try {
        modelRegistry.validateTokenConfig(mergedConfig);
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

      const updated = await tokenStore.update(id, request);

      if (!updated) {
        res.status(404).json({
          error: 'NotFound',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        ...updated,
        token_hash: undefined, // Never expose hash
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to update token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Rotate token
  router.post('/tokens/:id/rotate', async (req: Request<IdParams>, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await tokenStore.rotate(id);

      if (!result) {
        res.status(404).json({
          error: 'NotFound',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        token: result.token,
        config: {
          ...result.config,
          token_hash: undefined, // Never expose hash
        },
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to rotate token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // List all tokens (admin only)
  router.get('/tokens', async (_req: Request, res: Response): Promise<void> => {
    try {
      const tokens = await tokenStore.list();
      res.json({
        tokens: tokens.map((t) => ({
          ...t,
          token_hash: undefined, // Never expose hash
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

  // Delete token
  router.delete('/tokens/:id', async (req: Request<IdParams>, res: Response): Promise<void> => {
    try {
      const { id } = req.params;

      // Clear cache for this token before deletion
      if (cache) {
        try {
          await cache.clearByScope(id);
        } catch (cacheError) {
          // Log but don't fail deletion if cache clear fails
          console.error('Failed to clear cache for token:', id, cacheError);
        }
      }

      const deleted = await tokenStore.delete(id);

      if (!deleted) {
        res.status(404).json({
          error: 'NotFound',
          message: 'Token not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(204).send();
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to delete token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
