import express, { Express, Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';

import { tokenAuthMiddleware, adminAuthMiddleware, requestIdMiddleware } from './auth';
import { createTokenStore, createAdminRoutes, TokenStore } from './tokens';
import { createIntentClassifier, IntentClassifier } from './intent';
import { createPolicyEngine, PolicyEngine } from './policy';
import { createKnowledgeStore, KnowledgeStore } from './knowledge';
import { createModelRegistry, DefaultModelRegistry } from './models';
import { createRoutingEngine, createRoutingRoutes, RoutingEngine } from './routing';
import { createFeedbackHandler, createFeedbackRoutes, FeedbackHandler } from './feedback';
import { createOpinionPoller, OpinionPoller } from './polling';
import { createLogger, Logger } from './logging';

/**
 * Application dependencies container
 */
export interface AppDependencies {
  redis?: Redis;
  tokenStore: TokenStore;
  intentClassifier: IntentClassifier;
  policyEngine: PolicyEngine;
  knowledgeStore: KnowledgeStore;
  modelRegistry: DefaultModelRegistry;
  routingEngine: RoutingEngine;
  feedbackHandler: FeedbackHandler;
  opinionPoller: OpinionPoller;
  logger: Logger;
}

/**
 * Create and configure the Express application
 */
export function createApp(deps?: Partial<AppDependencies>): {
  app: Express;
  dependencies: AppDependencies;
} {
  const app = express();

  // Initialize Redis connection if enabled
  let redis: Redis | undefined;
  if (process.env.REDIS_ENABLED === 'true' && process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  // Initialize dependencies
  const logger = deps?.logger ?? createLogger(process.env.LOG_LEVEL);
  const tokenStore = deps?.tokenStore ?? createTokenStore(redis);
  const intentClassifier = deps?.intentClassifier ?? createIntentClassifier();
  const policyEngine = deps?.policyEngine ?? createPolicyEngine();
  const modelRegistry = deps?.modelRegistry ?? createModelRegistry();
  const knowledgeStore = deps?.knowledgeStore ?? createKnowledgeStore(redis, modelRegistry);
  const opinionPoller = deps?.opinionPoller ?? createOpinionPoller(knowledgeStore, modelRegistry);
  const feedbackHandler = deps?.feedbackHandler ?? createFeedbackHandler(knowledgeStore);

  const routingEngine =
    deps?.routingEngine ??
    createRoutingEngine({
      intentClassifier,
      policyEngine,
      knowledgeStore,
      modelRegistry,
    });

  const dependencies: AppDependencies = {
    redis,
    tokenStore,
    intentClassifier,
    policyEngine,
    knowledgeStore,
    modelRegistry,
    routingEngine,
    feedbackHandler,
    opinionPoller,
    logger,
  };

  // Middleware
  app.use(express.json());
  app.use(requestIdMiddleware());

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('Request completed', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        request_id: req.requestId,
      });
    });
    next();
  });

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      redis_connected: redis?.status === 'ready',
    });
  });

  // Admin routes (require admin auth)
  const adminRouter = express.Router();
  adminRouter.use(adminAuthMiddleware());
  adminRouter.use(createAdminRoutes(tokenStore, modelRegistry));

  // Knowledge stats endpoint (admin only)
  // Optional query params: ?scope=global|token&token_id=xxx
  adminRouter.get('/knowledge/stats', async (req: Request, res: Response) => {
    try {
      const scope = req.query.scope as string | undefined;
      const tokenId = req.query.token_id as string | undefined;

      let scopeContext: any = undefined;
      if (scope) {
        scopeContext = {
          scope,
          token_id: scope === 'token' ? tokenId : undefined,
        };
      }

      const stats = await knowledgeStore.getStats(scopeContext);
      res.json(stats);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get knowledge stats',
        details: { error: errorMessage },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Manual decay endpoint removed in favor of lazy, read-time decay. Kept for backward compatibility.
  adminRouter.post('/knowledge/decay', async (_req: Request, res: Response) => {
    res.status(410).json({
      error: 'Deprecated',
      message: 'Decay is applied lazily at read time; manual decay is no longer available.',
      timestamp: new Date().toISOString(),
    });
  });

  // Models endpoint (admin only)
  adminRouter.get('/models', (_req: Request, res: Response) => {
    res.json({
      models: modelRegistry.getAllModels(),
      count: modelRegistry.getAllModels().length,
      default: modelRegistry.getDefaultModel(),
    });
  });

  app.use('/admin', adminRouter);

  // Protected routes (require token auth)
  // Mount routers at their specific paths
  app.use('/route', tokenAuthMiddleware(tokenStore), createRoutingRoutes(routingEngine));
  app.use('/feedback', tokenAuthMiddleware(tokenStore), createFeedbackRoutes(feedbackHandler, modelRegistry));

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'NotFound',
      message: 'Endpoint not found',
      timestamp: new Date().toISOString(),
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({
      error: 'InternalError',
      message: 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
    });
  });

  return { app, dependencies };
}
