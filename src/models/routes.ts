import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../logging/logger';
import type { ModelRegistry } from './registry';
import type { RegistryMode } from '../types';
import type { User } from '../users/types';
import type { ModelRegistrySyncService } from './providers';

interface AuthenticatedRequest extends Request {
  user?: User;
}

const RegistryModeSchema = z.enum(['augment', 'override']);

const ModelMetadataSchema = z.object({
  id: z.string().min(1),
  provider: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  cost_tier: z.enum(['low', 'medium', 'high']).optional(),
  speed_tier: z.enum(['fast', 'medium', 'slow']).optional(),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  available: z.boolean().optional(),
  status: z.enum(['active', 'deprecated', 'disabled']).optional(),
  global_eligible: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  cost: z.object({
    input_per_1k: z.number().nonnegative().optional(),
    output_per_1k: z.number().nonnegative().optional(),
    currency: z.string().optional(),
    source: z.enum(['provider', 'curated', 'inferred', 'user']).optional(),
  }).optional(),
  performance: z.object({
    quality_tier: z.enum(['low', 'medium', 'high']).optional(),
    latency_tier: z.enum(['fast', 'medium', 'slow']).optional(),
    strengths: z.array(z.string()).optional(),
    weaknesses: z.array(z.string()).optional(),
  }).optional(),
  capability_flags: z.object({
    tool_use: z.boolean().optional(),
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    json_mode: z.boolean().optional(),
  }).optional(),
});

const PatchMetadataSchema = ModelMetadataSchema.omit({ id: true }).partial();

export function createAdminModelRegistryRoutes(
  modelRegistry: ModelRegistry,
  logger: Logger,
  registrySyncService?: ModelRegistrySyncService
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response): void => {
    const models = modelRegistry.getAllModels();
    res.json({
      models,
      count: models.length,
      default: modelRegistry.getDefaultModel(),
    });
  });

  router.post('/refresh', async (_req: Request, res: Response): Promise<void> => {
    if (!registrySyncService || !registrySyncService.hasProviders()) {
      res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'No model catalog providers configured for registry refresh',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const summary = await registrySyncService.syncAll();
      res.status(200).json({
        ...summary,
        configured_providers: registrySyncService.getProviderNames(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to refresh model registry',
        details: { error: errorMessage },
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/', (req: Request, res: Response): void => {
    const parsed = ModelMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid request body',
        details: parsed.error.errors,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const id = parsed.data.id.trim();
    if (!id) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Model id must not be empty',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const { id: _ignoredId, ...metadata } = parsed.data;
    modelRegistry.setSystemCuratedOverride(id, metadata);

    logger.info('System model registry override created', { model_id: id });

    const model = modelRegistry.getModel(id);
    res.status(201).json({
      model,
      timestamp: new Date().toISOString(),
    });
  });

  router.patch('/:id', (req: Request<{ id: string }>, res: Response): void => {
    const { id } = req.params;
    const parsed = PatchMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid request body',
        details: parsed.error.errors,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    modelRegistry.setSystemCuratedOverride(id, parsed.data);

    logger.info('System model registry override updated', { model_id: id });

    const model = modelRegistry.getModel(id);
    res.json({
      model,
      timestamp: new Date().toISOString(),
    });
  });

  router.delete('/:id', (req: Request<{ id: string }>, res: Response): void => {
    const { id } = req.params;
    const removed = modelRegistry.clearSystemCuratedOverride(id);

    if (!removed) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Registry override not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('System model registry override removed', { model_id: id });

    res.status(204).send();
  });

  return router;
}

export function createUserModelRegistryRoutes(modelRegistry: ModelRegistry, logger: Logger): Router {
  const router = Router();

  router.get('/', (req: AuthenticatedRequest, res: Response): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const mode = modelRegistry.getUserRegistryMode(req.user.id);
    const models = modelRegistry.getEffectiveModelsForUser(req.user.id);

    res.json({
      registry_mode: mode,
      models,
      count: models.length,
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/mode', (req: AuthenticatedRequest, res: Response): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const parsed = z.object({ mode: RegistryModeSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid request body',
        details: parsed.error.errors,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const mode: RegistryMode = parsed.data.mode;
    modelRegistry.setUserRegistryMode(req.user.id, mode);

    logger.info('User registry mode updated', {
      user_id: req.user.id,
      registry_mode: mode,
    });

    res.json({
      registry_mode: mode,
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/', (req: AuthenticatedRequest, res: Response): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const parsed = ModelMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid request body',
        details: parsed.error.errors,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const id = parsed.data.id.trim();
    if (!id) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Model id must not be empty',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const { id: _ignoredId, ...metadata } = parsed.data;
    modelRegistry.setUserModelOverlay(req.user.id, id, metadata);

    logger.info('User registry model overlay created', {
      user_id: req.user.id,
      model_id: id,
    });

    const model = modelRegistry.getEffectiveModelForUser(id, req.user.id);
    res.status(201).json({
      model,
      timestamp: new Date().toISOString(),
    });
  });

  router.patch('/:id', (req: AuthenticatedRequest & Request<{ id: string }>, res: Response): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { id } = req.params;
    const parsed = PatchMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid request body',
        details: parsed.error.errors,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    modelRegistry.setUserModelOverlay(req.user.id, id, parsed.data);

    logger.info('User registry model overlay updated', {
      user_id: req.user.id,
      model_id: id,
    });

    const model = modelRegistry.getEffectiveModelForUser(id, req.user.id);
    res.json({
      model,
      timestamp: new Date().toISOString(),
    });
  });

  router.delete('/:id', (req: AuthenticatedRequest & Request<{ id: string }>, res: Response): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { id } = req.params;
    const removed = modelRegistry.clearUserModelOverlay(req.user.id, id);
    if (!removed) {
      res.status(404).json({
        error: 'NotFound',
        message: 'User model overlay not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('User registry model overlay removed', {
      user_id: req.user.id,
      model_id: id,
    });

    res.status(204).send();
  });

  return router;
}
