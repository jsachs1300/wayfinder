import express, { Express, Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import helmet from 'helmet';
import cors from 'cors';

import { tokenAuthMiddleware, adminAuthMiddleware, requestIdMiddleware } from './auth';
import { createTokenStore, createAdminRoutes, TokenStore } from './tokens';
import { createPolicyEngine, PolicyEngine } from './policy';
import { createKnowledgeStore, KnowledgeStore } from './knowledge';
import { createModelRegistry, DefaultModelRegistry } from './models';
import { createRoutingEngine, createRoutingRoutes, RoutingEngine, StubRouterLLM, DefaultRouterLLM } from './routing';
import { createFeedbackHandler, createFeedbackRoutes, FeedbackHandler } from './feedback';
import { createOpinionPoller, OpinionPoller } from './polling';
import { createLogger, Logger } from './logging';
import { createRateLimiters } from './middleware';
import { SemanticCache, loadCacheConfig } from './cache';

/**
 * Application dependencies container
 */
export interface AppDependencies {
  redis?: Redis;
  tokenStore: TokenStore;
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

  // Trust first proxy for correct IP detection (required for rate limiting behind reverse proxy)
  // Without this, all requests appear to come from the proxy IP, defeating IP-based rate limits
  app.set('trust proxy', true);

  // Security headers - Helmet.js
  // Protects against common web vulnerabilities: XSS, clickjacking, MIME sniffing, etc.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        frameAncestors: ["'none'"], // Prevent clickjacking
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
        upgradeInsecureRequests: [], // Upgrade HTTP to HTTPS
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true, // X-Content-Type-Options: nosniff
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xssFilter: true, // Legacy XSS protection (modern browsers use CSP)
  }));

  // CORS configuration
  // Parse allowed origins from environment variable (comma-separated)
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
    : ['*']; // Default: allow all origins (should be restricted in production)

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) {
        return callback(null, true);
      }

      // Check if origin is in allowed list or if wildcard is set
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // Reject CORS request - callback(null, false) is the correct way
        // (throwing an error can cause unexpected behavior in Express)
        callback(null, false);
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Wayfinder-Token', 'X-Admin-Api-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    credentials: true,
    maxAge: 86400, // 24 hours - how long browsers cache preflight responses
  }));

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

  // Initialize semantic cache if enabled
  let cache: SemanticCache | undefined;
  if (process.env.LANGCACHE_ENABLED === 'true') {
    try {
      const cacheConfig = loadCacheConfig();
      cache = new SemanticCache(cacheConfig);
      logger.info('Semantic cache initialized', {
        host: cacheConfig.serverURL,
        similarity_threshold: cacheConfig.similarityThreshold,
        ttl: cacheConfig.ttl,
      });
    } catch (err) {
      logger.error('Failed to initialize cache, continuing without caching', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const tokenStore = deps?.tokenStore ?? createTokenStore(redis);
  const policyEngine = deps?.policyEngine ?? createPolicyEngine();
  const modelRegistry = deps?.modelRegistry ?? createModelRegistry();
  const knowledgeStore = deps?.knowledgeStore ?? createKnowledgeStore(redis, modelRegistry);
  const opinionPoller = deps?.opinionPoller ?? createOpinionPoller(knowledgeStore, modelRegistry);
  const feedbackHandler = deps?.feedbackHandler ?? createFeedbackHandler(knowledgeStore);

  // Initialize router LLM (use DefaultRouterLLM if configured, otherwise StubRouterLLM)
  let routerLLM;
  if (process.env.ROUTER_LLM_API_KEY) {
    try {
      routerLLM = new DefaultRouterLLM(undefined, console);
      logger.info('Router LLM initialized with real provider');
    } catch (error) {
      logger.warn('Failed to initialize Router LLM, falling back to stub', {
        error: error instanceof Error ? error.message : String(error),
      });
      routerLLM = new StubRouterLLM();
    }
  } else {
    logger.info('Router LLM API key not configured, using stub implementation');
    routerLLM = new StubRouterLLM();
  }

  const routingEngine =
    deps?.routingEngine ??
    createRoutingEngine({
      routerLLM,
      policyEngine,
      modelRegistry,
      logger,
      cache,
    });

  const dependencies: AppDependencies = {
    redis,
    tokenStore,
    policyEngine,
    knowledgeStore,
    modelRegistry,
    routingEngine,
    feedbackHandler,
    opinionPoller,
    logger,
  };

  // Create rate limiters (uses Redis if available for distributed rate limiting)
  const rateLimiters = createRateLimiters(redis);

  // Middleware
  // Body size limits (prevent large payload DoS attacks)
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
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

  // Health check endpoint (no auth or rate limiting required)
  // IMPORTANT: This endpoint is defined before rate limiters are applied to routes.
  // Do not move it after route-specific rate limiters or health checks may be rate limited,
  // which would break monitoring and alerting systems.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      redis_connected: redis?.status === 'ready',
    });
  });

  // Admin routes (require admin auth + rate limiting)
  const adminRouter = express.Router();
  adminRouter.use(rateLimiters.admin);
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

  // Cache management endpoints (admin only)
  if (cache) {
    adminRouter.get('/cache/stats', async (_req: Request, res: Response) => {
      try {
        const stats = await cache.getStats();
        res.json(stats);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to get cache stats',
          details: { error: errorMessage },
          timestamp: new Date().toISOString(),
        });
      }
    });

    adminRouter.post('/cache/clear', async (req: Request, res: Response) => {
      try {
        const { token_id } = req.body;

        // Note: Cache is global (no token isolation), so this clears all cached routing decisions
        if (token_id) {
          logger.warn('Cache clear requested for specific token, but cache is global. Clearing entire cache.', {
            token_id,
          });
        }

        await cache.clear();
        res.json({
          message: 'Global cache cleared',
          note: token_id
            ? 'Cache is global (no token isolation). All cached routing decisions have been cleared.'
            : undefined,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to clear cache',
          details: { error: errorMessage },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  app.use('/admin', adminRouter);

  // Protected routes (require token auth + rate limiting)
  // Mount routers at their specific paths
  app.use('/route', rateLimiters.routing, tokenAuthMiddleware(tokenStore), createRoutingRoutes(routingEngine, logger));
  app.use('/feedback', rateLimiters.feedback, tokenAuthMiddleware(tokenStore), createFeedbackRoutes(feedbackHandler, modelRegistry));

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

    // In production, hide error details to prevent information leakage
    // In development, include details for debugging
    const errorResponse: any = {
      error: 'InternalError',
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
      timestamp: new Date().toISOString(),
    };

    // Only include stack trace in development
    if (process.env.NODE_ENV !== 'production') {
      errorResponse.stack = err.stack;
    }

    res.status(500).json(errorResponse);
  });

  return { app, dependencies };
}
