import { createHash, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { RoutingEngine } from '../routing';
import { projectRouteResponse } from '../routing/projection';
import type { TokenStore } from '../tokens/store';
import type { SemanticCache } from '../cache';
import type { UserStore } from '../users/store';
import type { RouterModelPreference, RouteRequest } from '../types';
import { VALID_ROUTER_MODEL_PREFERENCES } from '../types';

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const ToolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).optional(),
});

const RouteToolArgsSchema = z.object({
  token: z.string().min(1),
  prompt: z.string().min(1),
  router_model: z.enum([...VALID_ROUTER_MODEL_PREFERENCES] as [RouterModelPreference, ...RouterModelPreference[]]).optional(),
  prefer_model: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const CacheStatsToolArgsSchema = z.object({
  admin_api_key: z.string().optional(),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function jsonRpcResult(id: string | number | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function isAdminKeyValid(provided: string | undefined): boolean {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return true;
  }
  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function createMcpRoutes(
  routingEngine: RoutingEngine,
  tokenStore: TokenStore,
  cache?: SemanticCache,
  userStore?: UserStore,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      protocol: 'mcp',
      version: '2025-03-26',
      transport: 'jsonrpc',
      endpoint: '/mcp',
      tools: ['wayfinder_route', 'wayfinder_cache_stats'],
    });
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = JsonRpcRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jsonRpcError(undefined, -32600, 'Invalid Request'));
      return;
    }

    const { id, method } = parsed.data;

    if (method === 'initialize') {
      res.json(jsonRpcResult(id, {
        protocolVersion: '2025-03-26',
        serverInfo: {
          name: 'wayfinder-mcp',
          version: '1.0.0',
        },
        capabilities: {
          tools: {},
        },
      }));
      return;
    }

    if (method === 'tools/list') {
      res.json(jsonRpcResult(id, {
        tools: [
          {
            name: 'wayfinder_route',
            description: 'Route a prompt through Wayfinder and return recommended primary/alternate models.',
            inputSchema: {
              type: 'object',
              required: ['token', 'prompt'],
              properties: {
                token: { type: 'string', description: 'Wayfinder API token value (wf_...)' },
                prompt: { type: 'string', description: 'User prompt to route.' },
                router_model: { type: 'string', enum: VALID_ROUTER_MODEL_PREFERENCES },
                prefer_model: { type: 'string' },
                context: { type: 'object', additionalProperties: true },
                metadata: { type: 'object', additionalProperties: true },
              },
            },
          },
          {
            name: 'wayfinder_cache_stats',
            description: 'Get semantic cache statistics and connection status.',
            inputSchema: {
              type: 'object',
              properties: {
                admin_api_key: { type: 'string', description: 'Required when ADMIN_API_KEY is configured.' },
              },
            },
          },
        ],
      }));
      return;
    }

    if (method === 'tools/call') {
      const toolCallParsed = ToolCallSchema.safeParse(parsed.data.params);
      if (!toolCallParsed.success) {
        res.status(400).json(jsonRpcError(id, -32602, 'Invalid params'));
        return;
      }

      const { name, arguments: rawArguments } = toolCallParsed.data;

      if (name === 'wayfinder_route') {
        const routeArgs = RouteToolArgsSchema.safeParse(rawArguments ?? {});
        if (!routeArgs.success) {
          res.status(400).json(jsonRpcError(id, -32602, 'Invalid route arguments', routeArgs.error.flatten()));
          return;
        }

        const tokenHash = hashToken(routeArgs.data.token);
        const tokenConfig = await tokenStore.getByHash(tokenHash);
        if (!tokenConfig) {
          res.status(401).json(jsonRpcError(id, -32001, 'Invalid Wayfinder token'));
          return;
        }

        let userContext: { user: unknown; userTier: string } | undefined;
        const tokenWithUser = tokenConfig as { user_id?: string };
        if (tokenWithUser.user_id && userStore) {
          const user = await userStore.getById(tokenWithUser.user_id);
          if (!user || user.status !== 'active') {
            res.status(403).json(jsonRpcError(id, -32003, 'Token owner is not active'));
            return;
          }
          userContext = { user, userTier: user.tier };
        }

        const routeRequest: RouteRequest = {
          prompt: routeArgs.data.prompt,
          router_model: routeArgs.data.router_model,
          prefer_model: routeArgs.data.prefer_model,
          context: routeArgs.data.context,
          metadata: routeArgs.data.metadata,
        };

        const result = await routingEngine.route(routeRequest, tokenConfig, `mcp-${Date.now()}`, userContext);
        const response = projectRouteResponse(
          result.decision,
          `mcp-${Date.now()}`,
          result.router_model_used || routeArgs.data.router_model || tokenConfig.router_model_preference || 'consensus',
          result.cache_hit || false,
        );

        res.json(jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response),
            },
          ],
          structuredContent: response,
        }));
        return;
      }

      if (name === 'wayfinder_cache_stats') {
        if (!cache) {
          res.status(503).json(jsonRpcError(id, -32004, 'Semantic cache is not enabled'));
          return;
        }

        const cacheArgs = CacheStatsToolArgsSchema.safeParse(rawArguments ?? {});
        if (!cacheArgs.success) {
          res.status(400).json(jsonRpcError(id, -32602, 'Invalid cache arguments'));
          return;
        }

        if (!isAdminKeyValid(cacheArgs.data.admin_api_key)) {
          res.status(401).json(jsonRpcError(id, -32002, 'Invalid admin API key'));
          return;
        }

        const stats = await cache.getStats();
        const status = cache.getConnectionStatus();

        res.json(jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...stats, connection: status }),
            },
          ],
          structuredContent: {
            ...stats,
            connection: status,
          },
        }));
        return;
      }

      res.status(404).json(jsonRpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }

    if (method === 'notifications/initialized') {
      res.status(202).json(jsonRpcResult(id, {}));
      return;
    }

    res.status(404).json(jsonRpcError(id, -32601, `Method not found: ${method}`));
  });

  return router;
}
