import express, { Express, Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import helmet from 'helmet';
import cors from 'cors';

import { tokenAuthMiddleware, adminAuthMiddleware, requestIdMiddleware, userAuthMiddleware, sessionAuthMiddleware, hashToken } from './auth';
import {
  createTokenStore,
  createAdminRoutes,
  createTokenMetricsStore,
  createDefaultTokenProfileStore,
  TokenStore,
} from './tokens';
import type { TokenMetricsStore } from './tokens/metrics';
import type { DefaultTokenProfileStore } from './tokens/default-profile-store';
import { createPolicyEngine, PolicyEngine } from './policy';
import { createKnowledgeStore, KnowledgeStore } from './knowledge';
import {
  createModelRegistry,
  createPersistentModelRegistry,
  DefaultModelRegistry,
  createAdminModelRegistryRoutes,
  createUserModelRegistryRoutes,
  createModelCatalogProvidersFromEnv,
  ModelRegistrySyncService,
  ModelValidationError,
} from './models';
import { createRoutingEngine, createRoutingRoutes, RoutingEngine, StubRouterLLM, MultiProviderRouterLLM } from './routing';
import { createFeedbackHandler, createFeedbackRoutes, FeedbackHandler } from './feedback';
import { createOpinionPoller, OpinionPoller } from './polling';
import { createLogger, Logger } from './logging';
import { createRateLimiters, createTierRateLimiter } from './middleware';
import { SemanticCache, loadCacheConfig } from './cache';
import { FEATURE_FLAGS } from './config';
import { createUserStore, type UserStore } from './users';
import { createAnonymousSessionStore, type AnonymousSessionStore } from './users/anonymous';
import { createUserLLMKeyStore, type UserLLMKeyStore } from './users/llm-keys';
import { validateEncryptionKeyAtStartup } from './users/llm-keys/encryption';
import { createSessionStore, type SessionStore } from './sessions';
import { createUserVerificationStore, type UserVerificationStore } from './users/verification-store';
import { ConsoleMailer, PostmarkMailer, type Mailer } from './email';
import { getSharedRedis } from './redis/shared';
import { buildLLMIntegrationSpec, renderLLMSpecText } from './public/llm-spec';
import { createMcpRoutes } from './public/mcp';
import { sessionRouteTokenMiddleware } from './tokens/session-route-middleware';

/**
 * Application dependencies container
 */
export interface AppDependencies {
  redis?: Redis;
  tokenStore: TokenStore;
  tokenMetricsStore?: TokenMetricsStore;
  defaultTokenProfileStore?: DefaultTokenProfileStore;
  userStore?: UserStore;
  userLLMKeyStore?: UserLLMKeyStore;
  anonymousSessionStore?: AnonymousSessionStore;
  sessionStore?: SessionStore;
  verificationStore?: UserVerificationStore;
  mailer?: Mailer;
  policyEngine: PolicyEngine;
  knowledgeStore: KnowledgeStore;
  modelRegistry: DefaultModelRegistry;
  modelRegistrySyncService?: ModelRegistrySyncService;
  routingEngine: RoutingEngine;
  feedbackHandler: FeedbackHandler;
  opinionPoller: OpinionPoller;
  logger: Logger;
}

function createRouteThrottleMetricsMiddleware(
  tokenStore: TokenStore,
  metricsStore?: TokenMetricsStore,
  logger?: Logger
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      if (res.statusCode !== 429 || !metricsStore) {
        return;
      }
      const tokenHeader = req.headers['x-wayfinder-token'] as string | undefined;
      const tokenId = req.tokenConfig?.id;
      if (tokenId) {
        void metricsStore.incrementThrottled(tokenId).catch((error) => {
          logger?.warn('Failed to update throttled token metrics', {
            token_id: tokenId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      if (!tokenHeader) {
        return;
      }
      const tokenHash = hashToken(tokenHeader);
      void tokenStore.getByHash(tokenHash)
        .then((config) => {
          if (config) {
            return metricsStore.incrementThrottled(config.id);
          }
          return undefined;
        })
        .catch((error) => {
          logger?.warn('Failed to update throttled token metrics', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    next();
  };
}

function createSessionRouteAuditMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('Session route request completed', {
        user_id: req.user?.id,
        token_id: req.tokenConfig?.id ?? req.params.token_id,
        request_id: req.requestId,
        status: res.statusCode,
        latency_ms: Date.now() - start,
      });
    });
    next();
  };
}

/**
 * Create and configure the Express application
 */
export async function createApp(deps?: Partial<AppDependencies>): Promise<{
  app: Express;
  dependencies: AppDependencies;
}> {
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
    allowedHeaders: ['Content-Type', 'X-Wayfinder-Token', 'X-Admin-Api-Key', 'X-Session-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    credentials: true,
    maxAge: 86400, // 24 hours - how long browsers cache preflight responses
  }));

  // Initialize dependencies
  const logger = deps?.logger ?? createLogger(process.env.LOG_LEVEL);

  // Initialize Redis connection if enabled
  // Connect immediately to prevent auto-connection later (Issue #53)
  const redis = deps?.redis ?? await getSharedRedis(logger);

  // Check if we're in test/dev mode (allows bypassing requirements for testing)
  const isTestMode = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

  // Initialize semantic cache (REQUIRED for production, optional for test/dev)
  let cache: SemanticCache | undefined;
  const langCacheEnabled = process.env.LANGCACHE_ENABLED === 'true';

  if (!langCacheEnabled && !isTestMode) {
    const errorMsg =
      'LANGCACHE_ENABLED must be set to "true" for production use.\n\n' +
      'Wayfinder requires semantic caching to optimize router LLM costs and latency.\n' +
      'To enable caching, set these environment variables:\n' +
      '  LANGCACHE_ENABLED=true\n' +
      '  LANGCACHE_HOST=your-cache-id.langcache.redis.io\n' +
      '  LANGCACHE_CACHE_ID=your-cache-id\n' +
      '  LANGCACHE_API_KEY=your-api-key\n\n' +
      'Get your LangCache credentials at: https://redis.io/langcache/\n\n' +
      'For testing/development, set NODE_ENV=development or NODE_ENV=test';
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  if (langCacheEnabled) {
    try {
      const cacheConfig = loadCacheConfig();
      cache = new SemanticCache(cacheConfig);
      logger.info('Semantic cache initialized', {
        host: cacheConfig.serverURL,
        similarity_threshold: cacheConfig.similarityThreshold,
        ttl: cacheConfig.ttl,
        timeout_ms: cacheConfig.timeoutMs,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to initialize cache', { error: errorMsg });

      // In production, cache initialization failure is fatal
      if (!isTestMode) {
        throw new Error(`Cache initialization failed: ${errorMsg}`);
      }

      logger.warn('Continuing without cache in test/dev mode');
    }
  } else if (isTestMode) {
    logger.warn('Running in test/dev mode without semantic cache - this is not suitable for production');
  }
  const tokenStore = deps?.tokenStore ?? createTokenStore(redis);
  const tokenMetricsStore = deps?.tokenMetricsStore ?? createTokenMetricsStore(redis);
  const defaultTokenProfileStore = deps?.defaultTokenProfileStore ?? createDefaultTokenProfileStore(redis, logger);

  // Initialize user-related stores if user self-service feature is enabled
  let userStore: UserStore | undefined;
  let userLLMKeyStore: UserLLMKeyStore | undefined;
  let anonymousSessionStore: AnonymousSessionStore | undefined;
  let sessionStore: SessionStore | undefined;
  let verificationStore: UserVerificationStore | undefined;
  const mailer = (() => {
    if (deps?.mailer) {
      return deps.mailer;
    }
    if (process.env.POSTMARK_API_KEY) {
      const emailFrom = process.env.EMAIL_FROM || 'user-ops@wyfndr.ai';
      return new PostmarkMailer({
        apiKey: process.env.POSTMARK_API_KEY,
        from: emailFrom,
        replyTo: process.env.EMAIL_REPLY_TO,
      }, logger);
    }
    return new ConsoleMailer(logger);
  })();

  if (FEATURE_FLAGS.USER_SELF_SERVICE) {
    // Validate encryption key at startup
    try {
      validateEncryptionKeyAtStartup();
      logger.info('Encryption key validation passed');
    } catch (error) {
      logger.error('Encryption key validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Fatal error - app cannot start without valid encryption key
    }

    userStore = deps?.userStore ?? createUserStore(redis);
    userLLMKeyStore = deps?.userLLMKeyStore ?? createUserLLMKeyStore(redis);
    anonymousSessionStore = deps?.anonymousSessionStore ?? createAnonymousSessionStore(tokenStore, redis);
    sessionStore = deps?.sessionStore ?? createSessionStore(redis);
    verificationStore = deps?.verificationStore ?? createUserVerificationStore(redis);

    logger.info('User self-service features enabled', {
      userStore: userStore ? 'initialized' : 'not available',
      userLLMKeyStore: userLLMKeyStore ? 'initialized' : 'not available',
      anonymousSessionStore: anonymousSessionStore ? 'initialized' : 'not available',
      sessionStore: sessionStore ? 'initialized' : 'not available',
      verificationStore: verificationStore ? 'initialized' : 'not available',
    });
  }

  const policyEngine = deps?.policyEngine ?? createPolicyEngine();
  const modelRegistry = deps?.modelRegistry ?? (
    redis
      ? await createPersistentModelRegistry(redis, logger)
      : createModelRegistry()
  );
  const modelRegistrySyncService = deps?.modelRegistrySyncService ?? (() => {
    const providers = createModelCatalogProvidersFromEnv();
    if (providers.length === 0) {
      return undefined;
    }
    return new ModelRegistrySyncService(modelRegistry, logger, providers);
  })();

  const modelRegistrySyncOnStartup = process.env.MODEL_REGISTRY_SYNC_ON_STARTUP
    ? process.env.MODEL_REGISTRY_SYNC_ON_STARTUP === 'true'
    : process.env.NODE_ENV !== 'test';
  if (modelRegistrySyncOnStartup && modelRegistrySyncService?.hasProviders()) {
    try {
      const summary = await modelRegistrySyncService.syncAll();
      logger.info('Startup model registry sync completed', {
        imported_total: summary.imported_total,
        providers: summary.providers,
      });
    } catch (error) {
      logger.warn('Startup model registry sync failed; continuing with existing registry', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const knowledgeStore = deps?.knowledgeStore ?? createKnowledgeStore(redis, modelRegistry);
  const opinionPoller = deps?.opinionPoller ?? createOpinionPoller(knowledgeStore, modelRegistry);
  const feedbackHandler = deps?.feedbackHandler ?? createFeedbackHandler(knowledgeStore);

  // Initialize router LLM (REQUIRED for production, optional for test/dev)
  // Note: loadRouterLLMConfig() (called by MultiProviderRouterLLM constructor) validates
  // that at least one provider is enabled in production mode, so no need for redundant checks here
  let routerLLM;
  try {
    routerLLM = new MultiProviderRouterLLM(undefined, console);
    const config = routerLLM.getConfig();
    const enabledProviders = [];
    if (config.openai.enabled) enabledProviders.push('OpenAI');
    if (config.gemini.enabled) enabledProviders.push('Gemini');

    if (enabledProviders.length === 0 && isTestMode) {
      logger.warn('No router LLM providers enabled in test/dev mode, using stub router', {
        message: 'Set ROUTER_LLM_*_ENABLED=true to exercise real providers in tests.',
      });
      routerLLM = new StubRouterLLM();
    } else {
      logger.info(`Router LLM initialized with providers: ${enabledProviders.join(' + ')}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // In production, router LLM initialization failure is fatal
    if (!isTestMode) {
      logger.error('Router LLM initialization failed', { error: errorMsg });
      throw new Error(`Router LLM initialization failed: ${errorMsg}`);
    }

    // In test/dev mode, fall back to stub
    logger.warn('Failed to initialize Router LLM, falling back to stub for test/dev mode', {
      error: errorMsg,
    });
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
      defaultTokenProfileStore,
      userLLMKeyStore, // Pass UserLLMKeyStore for BYOLLM support
    });

  const dependencies: AppDependencies = {
    redis,
    tokenStore,
    tokenMetricsStore,
    defaultTokenProfileStore,
    userStore,
    userLLMKeyStore,
    anonymousSessionStore,
    sessionStore,
    verificationStore,
    mailer,
    policyEngine,
    knowledgeStore,
    modelRegistry,
    modelRegistrySyncService,
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
    const cacheStatus = cache?.getConnectionStatus();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      redis_connected: redis?.status === 'ready',
      langcache_enabled: langCacheEnabled,
      langcache_connected: cacheStatus?.connected ?? false,
      ...(cacheStatus?.last_error ? { langcache_last_error: cacheStatus.last_error } : {}),
      ...(cacheStatus?.last_error_at ? { langcache_last_error_at: cacheStatus.last_error_at } : {}),
      ...(cacheStatus?.last_success_at ? { langcache_last_success_at: cacheStatus.last_success_at } : {}),
    });
  });

  // Public LLM integration spec endpoint (no auth)
  app.get('/llm-spec', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
    res.json(buildLLMIntegrationSpec(FEATURE_FLAGS.USER_SELF_SERVICE));
  });

  // Plain text alias for direct LLM consumption (no auth)
  app.get('/llms.txt', (_req: Request, res: Response) => {
    const spec = buildLLMIntegrationSpec(FEATURE_FLAGS.USER_SELF_SERVICE);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(renderLLMSpecText(spec));
  });

  app.get('/prompt.txt', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(
      'You are connected to Wayfinder, an LLM routing service.\n' +
      'Prefer using the MCP tools when available:\n' +
      '- wayfinder_route: get primary and alternate model recommendations for a prompt.\n' +
      '- wayfinder_cache_stats: inspect semantic cache health and hit rates (requires admin key when configured).\n\n' +
      'Guidelines:\n' +
      '1. Call wayfinder_route before selecting a model for user prompts.\n' +
      '2. Respect returned model ranking and rationale.\n' +
      '3. Treat request_id as trace metadata for logs/feedback.\n' +
      '4. Never expose API tokens or admin keys in outputs.\n'
    );
  });


  app.get('/.well-known/mcp.json', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
    res.json({
      name: 'wayfinder-mcp',
      description: 'Remote MCP server for Wayfinder routing and cache tools.',
      protocol: 'jsonrpc',
      endpoint: '/mcp',
      prompt: '/prompt.txt',
      llms: '/llms.txt',
      tools: ['wayfinder_route', 'wayfinder_cache_stats'],
    });
  });
  app.get('/.well-known/ai-plugin.json', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
    res.json({
      schema_version: 'v1',
      name_for_human: 'Wayfinder MCP',
      name_for_model: 'wayfinder_mcp',
      description_for_human: 'Route prompts across LLM providers with semantic cache support.',
      description_for_model: 'Use the /mcp endpoint for tool discovery and calls to Wayfinder routing and cache tools.',
      auth: { type: 'none' },
      api: {
        type: 'openapi',
        url: '/llm-spec',
      },
      logo_url: '',
      contact_email: '',
      legal_info_url: '',
    });
  });

  app.use('/mcp', createMcpRoutes(routingEngine, tokenStore, cache, userStore));

  // Admin routes (require admin auth + rate limiting)
  const adminRouter = express.Router();
  adminRouter.use(rateLimiters.admin);
  adminRouter.use(adminAuthMiddleware(sessionStore, userStore));
  adminRouter.use(createAdminRoutes(
    tokenStore,
    modelRegistry,
    tokenMetricsStore,
    cache,
    defaultTokenProfileStore
  ));

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

  adminRouter.get('/default-token-profile', async (_req: Request, res: Response): Promise<void> => {
    try {
      const availableModels = modelRegistry.getAvailableModels();
      const resolved = await defaultTokenProfileStore.resolveForModels(availableModels);
      res.json({
        profile: resolved.profile,
        effective_model_ids: resolved.effective_model_ids,
        missing_model_ids: resolved.missing_model_ids,
        cache_scope: resolved.cache_scope,
        recommended_model_ids: defaultTokenProfileStore.recommendModelIds(availableModels),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to load default token profile',
        details: { error: errorMessage },
        timestamp: new Date().toISOString(),
      });
    }
  });

  adminRouter.put('/default-token-profile', async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as { model_ids?: unknown } | undefined;
      if (!body || !Array.isArray(body.model_ids)) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'model_ids must be an array of model identifiers',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const modelIds = body.model_ids
        .filter((value): value is string => typeof value === 'string')
        .map((modelId) => modelId.trim())
        .filter((modelId) => modelId.length > 0);
      if (modelIds.length === 0) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'model_ids must include at least one model identifier',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const uniqueModelIds = [...new Set(modelIds)];
      for (const modelId of uniqueModelIds) {
        modelRegistry.assertModelExists(modelId, 'token_config');
        modelRegistry.assertModelActive(modelId, 'token_config');
        modelRegistry.assertModelGlobalEligible(modelId, 'token_config');
      }

      const updatedBy =
        typeof req.user?.id === 'string' && req.user.id.length > 0
          ? req.user.id
          : 'admin';

      const profile = await defaultTokenProfileStore.setModelIds(uniqueModelIds, updatedBy);
      const resolved = await defaultTokenProfileStore.resolveForModels(modelRegistry.getAvailableModels());

      res.status(200).json({
        profile,
        effective_model_ids: resolved.effective_model_ids,
        missing_model_ids: resolved.missing_model_ids,
        cache_scope: resolved.cache_scope,
        cache_flush_recommended: true,
        cache_flush_hint:
          'Default-token cache scope advanced. Clear global cache if you want immediate cleanup of stale entries from previous profile versions.',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ModelValidationError) {
        res.status(400).json({
          error: error.name,
          message: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to update default token profile',
        details: { error: errorMessage },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Model registry management (admin only)
  adminRouter.use('/registry', createAdminModelRegistryRoutes(modelRegistry, logger, modelRegistrySyncService));

  // Update user tier (admin only) - for testing/support purposes
  if (userStore) {
    adminRouter.patch('/users/:userId/tier', async (req: Request, res: Response) => {
      try {
        const { userId } = req.params;
        if (!userId) {
          res.status(400).json({
            error: 'ValidationError',
            message: 'Missing userId parameter',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        const { tier } = req.body;

        if (!tier || !['free', 'paid_system', 'paid_byollm', 'admin'].includes(tier)) {
          res.status(400).json({
            error: 'ValidationError',
            message: 'Invalid tier. Must be one of: free, paid_system, paid_byollm, admin',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const user = await userStore.getById(userId);
        if (!user) {
          res.status(404).json({
            error: 'NotFound',
            message: 'User not found',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const updated = await userStore.update(userId, { tier });
        if (!updated) {
          res.status(500).json({
            error: 'InternalError',
            message: 'Failed to update user tier',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        res.json({
          id: updated.id,
          email: updated.email,
          tier: updated.tier,
          status: updated.status,
          updated_at: updated.updated_at,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to update user tier',
          details: { error: errorMessage },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

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

  // Create tier-aware rate limiter for routing endpoint (if user self-service enabled)
  const tierRateLimiter = FEATURE_FLAGS.USER_SELF_SERVICE
    ? createTierRateLimiter(redis, logger)
    : (_req: Request, _res: Response, next: NextFunction) => next(); // No-op if feature disabled

  // Routing endpoint: Apply both standard rate limiter and tier-aware limiter
  app.use('/route',
    createRouteThrottleMetricsMiddleware(tokenStore, tokenMetricsStore, logger),
    rateLimiters.routing,
    tokenAuthMiddleware(tokenStore, userStore),
    tierRateLimiter,
    createRoutingRoutes(routingEngine, logger, tokenMetricsStore)
  );

  // Session-based route endpoint for first-party console UX.
  // Allows selecting a token by id without exposing token secrets in frontend responses.
  if (FEATURE_FLAGS.USER_SELF_SERVICE && sessionStore && userStore) {
    app.use('/api/tokens/:token_id/route',
      sessionAuthMiddleware(sessionStore, userStore),
      sessionRouteTokenMiddleware(tokenStore),
      createSessionRouteAuditMiddleware(logger),
      createRouteThrottleMetricsMiddleware(tokenStore, tokenMetricsStore, logger),
      rateLimiters.routingByTokenId,
      tierRateLimiter,
      createRoutingRoutes(routingEngine, logger, tokenMetricsStore, { validationStatusCode: 422 })
    );
  }

  app.use('/feedback',
    rateLimiters.feedback,
    tokenAuthMiddleware(tokenStore, userStore),
    createFeedbackRoutes(feedbackHandler, modelRegistry)
  );

  // User self-service routes (feature-flagged)
  if (FEATURE_FLAGS.USER_SELF_SERVICE && userStore && userLLMKeyStore && anonymousSessionStore) {
    logger.info('Mounting user self-service routes');

    // Import route creators dynamically to avoid errors if modules don't exist
    try {
      const { createUserRoutes } = require('./users/routes');
      const { createAdminUserRoutes } = require('./users/admin-routes');
      const { createAnonymousRoutes } = require('./users/anonymous/routes');
      const { createUserTokenRoutes } = require('./tokens/user-routes');
      const { createLLMKeyRoutes } = require('./users/llm-keys/routes');
      const { createSessionRoutes } = require('./sessions/routes');

      // Public routes (no auth required)
      app.use('/api/users', createUserRoutes(
        userStore,
        tokenStore,
        modelRegistry,
        logger,
        verificationStore,
        sessionStore,
        userAuthMiddleware(tokenStore, userStore, sessionStore),
        mailer,
        tokenMetricsStore,
        defaultTokenProfileStore
      ));
      if (sessionStore) {
        app.use(
          '/api/sessions',
          rateLimiters.auth,
          createSessionRoutes(
            sessionStore,
            userStore,
            tokenStore,
            modelRegistry,
            logger,
            tokenMetricsStore,
            defaultTokenProfileStore
          )
        );
      } else {
        logger.warn('Session routes not mounted because Redis is unavailable');
      }
      app.use('/api/anonymous', createAnonymousRoutes(anonymousSessionStore, tokenStore, userStore, logger));

      // Protected routes (require user auth)
      app.use('/api/tokens',
        userAuthMiddleware(tokenStore, userStore, sessionStore),
        createUserTokenRoutes(
          tokenStore,
          modelRegistry,
          logger,
          tokenMetricsStore,
          cache,
          defaultTokenProfileStore
        )
      );

      app.use('/api/llm-keys',
        userAuthMiddleware(tokenStore, userStore, sessionStore),
        createLLMKeyRoutes(userLLMKeyStore)
      );

      app.use('/api/registry',
        userAuthMiddleware(tokenStore, userStore, sessionStore),
        createUserModelRegistryRoutes(modelRegistry, logger)
      );

      logger.info('User self-service routes mounted successfully');

      // Admin user routes (require admin auth)
      adminRouter.use('/users', createAdminUserRoutes(userStore, sessionStore, logger));
    } catch (error) {
      logger.error('Failed to mount user self-service routes', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
