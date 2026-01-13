/**
 * LLM Key Management Routes
 *
 * User-facing API for managing BYOLLM API keys (OpenAI, Gemini).
 * Requires 'paid_byollm' tier.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { User } from '../types';
import type { UserLLMKeyStore } from './store';
import type { UserLLMKeyCreateRequest, LLMProvider } from './types';
import { validateLLMKeyFormat, validateLLMKeyLive } from './validation';

interface ProviderParams {
  provider: string;
}

/**
 * Extended request with user context
 */
interface AuthenticatedRequest extends Request {
  user?: User;
}

const LLMKeyCreateSchema = z.object({
  provider: z.enum(['openai', 'gemini']),
  api_key: z.string().min(1),
});

/**
 * Create LLM key management routes
 */
export function createLLMKeyRoutes(llmKeyStore: UserLLMKeyStore): Router {
  const router = Router();

  // Middleware to check BYOLLM tier
  const requireBYOLLMTier = (req: AuthenticatedRequest, res: Response, next: () => void) => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        code: 'AUTH_003',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.user.tier !== 'paid_byollm') {
      res.status(403).json({
        error: 'Forbidden',
        code: 'BYOLLM_001',
        message: 'BYOLLM requires paid_byollm tier',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };

  // List user's configured LLM provider keys (metadata only, no actual keys)
  router.get('/', requireBYOLLMTier, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

      const keys = await llmKeyStore.getKeys(req.user.id);

      // Check if consensus routing is possible (need at least 2 providers)
      const consensusRoutingEnabled = keys.length >= 2;

      res.json({
        keys: keys.map((k) => ({
          id: k.id,
          provider: k.provider,
          is_active: k.is_active,
          validation_status: k.validation_status,
          created_at: k.created_at,
          last_used_at: k.last_used_at,
          // Never return encrypted_key, iv, or auth_tag
        })),
        consensus_routing_enabled: consensusRoutingEnabled,
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to list LLM keys',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Add or update LLM provider API key
  router.post('/', requireBYOLLMTier, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

      const parsed = LLMKeyCreateSchema.safeParse(req.body);
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

      const request: UserLLMKeyCreateRequest = {
        provider: parsed.data.provider,
        api_key: parsed.data.api_key,
      };

      // Validate API key format
      const formatValidation = validateLLMKeyFormat(request.provider, request.api_key);
      if (!formatValidation.valid) {
        res.status(400).json({
          error: 'ValidationError',
          code: 'BYOLLM_003',
          message: `API key format invalid: ${formatValidation.error}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Store the key (encrypted)
      const key = await llmKeyStore.setKey(req.user.id, request);

      res.status(201).json({
        id: key.id,
        provider: key.provider,
        is_active: key.is_active,
        validation_status: key.validation_status,
        message: 'Key stored. Validation will occur on first use.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to store LLM key',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Delete LLM provider key
  router.delete('/:provider', requireBYOLLMTier, async (req: Request<ProviderParams> & AuthenticatedRequest, res: Response): Promise<void> => {
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

      const { provider } = req.params;

      // Validate provider
      if (provider !== 'openai' && provider !== 'gemini') {
        res.status(400).json({
          error: 'ValidationError',
          code: 'BYOLLM_002',
          message: 'Invalid provider. Supported: openai, gemini',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const deleted = await llmKeyStore.deleteKey(req.user.id, provider as LLMProvider);

      if (!deleted) {
        res.status(404).json({
          error: 'NotFound',
          message: 'LLM key not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(204).send();
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to delete LLM key',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Validate LLM key against provider API
  router.post('/:provider/validate', requireBYOLLMTier, async (req: Request<ProviderParams> & AuthenticatedRequest, res: Response): Promise<void> => {
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

      const { provider } = req.params;

      // Validate provider
      if (provider !== 'openai' && provider !== 'gemini') {
        res.status(400).json({
          error: 'ValidationError',
          code: 'BYOLLM_002',
          message: 'Invalid provider. Supported: openai, gemini',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Get decrypted key
      const keys = await llmKeyStore.getDecryptedKeys(req.user.id);
      const key = keys.find((k) => k.provider === provider);

      if (!key) {
        res.status(404).json({
          error: 'NotFound',
          message: 'LLM key not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate against provider API
      const validation = await validateLLMKeyLive(provider as LLMProvider, key.api_key);
      const now = new Date().toISOString();

      // Update validation status in store
      await llmKeyStore.updateValidationStatus(
        req.user.id,
        provider as LLMProvider,
        validation.valid ? 'valid' : 'invalid',
        validation.error
      );

      res.json({
        provider,
        validation_status: validation.valid ? 'valid' : 'invalid',
        validation_error: validation.error ?? null,
        validated_at: now,
      });
    } catch (error) {
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to validate LLM key',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
