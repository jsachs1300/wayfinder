import { Router, Request, Response } from 'express';
import { FeedbackHandler } from './handler';
import { FeedbackRequest } from '../types';
import { ModelRegistry, ModelValidationError } from '../models';
import { createLogger } from '../logging';
import { z } from 'zod';

const logger = createLogger(process.env.LOG_LEVEL);

const FeedbackRequestSchema = z.object({
  request_id: z.string().min(1, 'Request ID is required'),
  selected_model: z.string().min(1, 'Selected model is required'),
  intent_label: z.enum([
    'code_review',
    'coding',
    'legal',
    'summarization',
    'reasoning',
    'creative',
    'support',
    'other',
  ]),
  rating: z.enum(['positive', 'negative', 'neutral']).optional(),
  preferred_model: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Create feedback routes
 */
export function createFeedbackRoutes(
  feedbackHandler: FeedbackHandler,
  modelRegistry: ModelRegistry
): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = FeedbackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid request body',
          details: parsed.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Token config is set by auth middleware
      if (!req.tokenConfig) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Token config not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const feedbackRequest: FeedbackRequest = parsed.data;

      // Validate model identifiers
      try {
        // Validate selected_model
        modelRegistry.assertModelExists(feedbackRequest.selected_model, 'feedback');
        modelRegistry.assertModelActive(feedbackRequest.selected_model, 'feedback');
        modelRegistry.assertModelAllowedForToken(
          feedbackRequest.selected_model,
          req.tokenConfig,
          'feedback'
        );

        // Validate preferred_model if specified
        if (feedbackRequest.preferred_model) {
          modelRegistry.assertModelExists(feedbackRequest.preferred_model, 'feedback');
          modelRegistry.assertModelActive(feedbackRequest.preferred_model, 'feedback');
          modelRegistry.assertModelAllowedForToken(
            feedbackRequest.preferred_model,
            req.tokenConfig,
            'feedback'
          );
        }
      } catch (error) {
        if (error instanceof ModelValidationError) {
          // Log the validation failure
          logger.warn('Feedback rejected due to invalid model', {
            request_id: feedbackRequest.request_id,
            token_id: req.tokenConfig.id,
            selected_model: feedbackRequest.selected_model,
            preferred_model: feedbackRequest.preferred_model,
            error: error.message,
          });

          res.status(400).json({
            error: error.name,
            message: error.message,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        throw error;
      }

      const response = await feedbackHandler.processFeedback(
        feedbackRequest,
        req.tokenConfig
      );

      res.json(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to process feedback',
        details: { error: errorMessage },
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
