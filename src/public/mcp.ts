import { timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { RoutingEngine } from '../routing';
import { projectRouteResponse } from '../routing/projection';
import type { SemanticCache } from '../cache';
import type { TokenStore } from '../tokens/store';
import type { UserStore } from '../users/store';
import type { RouteRequest, RouterModelPreference } from '../types';
import { VALID_ROUTER_MODEL_PREFERENCES } from '../types';
import { hashToken } from '../auth';

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
  token: z.string().min(1).optional(),
  prompt: z.string().min(1),
  router_model: z.enum([...VALID_ROUTER_MODEL_PREFERENCES] as [RouterModelPreference, ...RouterModelPreference[]]).optional(),
  prefer_model: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const CacheStatsToolArgsSchema = z.object({
  admin_api_key: z.string().optional(),
});


function jsonRpcResult(id: string | number | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: string | number | undefined, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function extractToken(req: Request, argsToken?: string): string | undefined {
  const tokenHeader = req.headers['x-wayfinder-token'];
  if (typeof tokenHeader === 'string' && tokenHeader.length > 0) {
    return tokenHeader;
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token.length > 0) {
      return token;
    }
  }

  if (argsToken) {
    return argsToken;
  }

  return undefined;
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

function sendRpc(res: Response, payload: Record<string, unknown>): void {
  res.status(200).json(payload);
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
      protocol_version: '2025-03-26',
      transport: 'jsonrpc',
      endpoint: '/mcp',
      methods: ['initialize', 'tools/list', 'tools/call'],
      tools: ['wayfinder_route', 'wayfinder_cache_stats'],
    });
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const parsed = JsonRpcRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          sendRpc(res, jsonRpcError(undefined, -32600, 'Invalid Request'));
          return;
        }

        const { id, method } = parsed.data;

        if (method === 'initialize') {
          sendRpc(res, jsonRpcResult(id, {
            protocolVersion: '2025-03-26',
            serverInfo: {
              name: 'wayfinder-mcp',
              version: '1.1.0',
            },
            capabilities: {
              tools: {},
            },
          }));
          return;
        }

        if (method === 'notifications/initialized') {
          res.status(204).end();
          return;
        }

        if (method === 'tools/list') {
          sendRpc(res, jsonRpcResult(id, {
            tools: [
              {
                name: 'wayfinder_route',
                description: 'Route a prompt through Wayfinder and return recommended primary/alternate models.',
                inputSchema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    token: { type: 'string', description: 'Optional Wayfinder API token (wf_...). Prefer Authorization: Bearer.' },
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

        if (method !== 'tools/call') {
          sendRpc(res, jsonRpcError(id, -32601, `Method not found: ${method}`));
          return;
        }

        const toolCallParsed = ToolCallSchema.safeParse(parsed.data.params);
        if (!toolCallParsed.success) {
          sendRpc(res, jsonRpcError(id, -32602, 'Invalid params'));
          return;
        }

        const { name, arguments: rawArguments } = toolCallParsed.data;

        if (name === 'wayfinder_route') {
          const routeArgs = RouteToolArgsSchema.safeParse(rawArguments ?? {});
          if (!routeArgs.success) {
            sendRpc(res, jsonRpcError(id, -32602, 'Invalid route arguments', routeArgs.error.flatten()));
            return;
          }

          const providedToken = extractToken(req, routeArgs.data.token);
          if (!providedToken) {
            sendRpc(res, jsonRpcError(id, -32001, 'Missing Wayfinder token (token arg, Authorization Bearer, or X-Wayfinder-Token header)'));
            return;
          }

          const tokenConfig = await tokenStore.getByHash(hashToken(providedToken));
          if (!tokenConfig) {
            sendRpc(res, jsonRpcError(id, -32001, 'Invalid Wayfinder token'));
            return;
          }

          let userContext: { user: unknown; userTier: string } | undefined;
          const tokenWithUser = tokenConfig as { user_id?: string };
          if (tokenWithUser.user_id && userStore) {
            const user = await userStore.getById(tokenWithUser.user_id);
            if (!user || user.status !== 'active') {
              sendRpc(res, jsonRpcError(id, -32003, 'Token owner is not active'));
              return;
            }
            userContext = { user, userTier: user.tier };
          }

          const requestId = req.requestId || `mcp-${Date.now()}`;
          const routeRequest: RouteRequest = {
            prompt: routeArgs.data.prompt,
            router_model: routeArgs.data.router_model,
            prefer_model: routeArgs.data.prefer_model,
            context: routeArgs.data.context,
            metadata: routeArgs.data.metadata,
          };

          const result = await routingEngine.route(routeRequest, tokenConfig, requestId, userContext);
          const response = projectRouteResponse(
            result.decision,
            requestId,
            result.router_model_used || routeArgs.data.router_model || tokenConfig.router_model_preference || 'consensus',
            result.cache_hit || false,
          );

          sendRpc(res, jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(response) }],
            structuredContent: response,
          }));
          return;
        }

        if (name === 'wayfinder_cache_stats') {
          if (!cache) {
            sendRpc(res, jsonRpcError(id, -32004, 'Semantic cache is not enabled'));
            return;
          }

          const cacheArgs = CacheStatsToolArgsSchema.safeParse(rawArguments ?? {});
          if (!cacheArgs.success) {
            sendRpc(res, jsonRpcError(id, -32602, 'Invalid cache arguments'));
            return;
          }

          if (!isAdminKeyValid(cacheArgs.data.admin_api_key)) {
            sendRpc(res, jsonRpcError(id, -32002, 'Invalid admin API key'));
            return;
          }

          const stats = await cache.getStats();
          const status = cache.getConnectionStatus();
          const payload = { ...stats, connection: status };

          sendRpc(res, jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
          }));
          return;
        }

        sendRpc(res, jsonRpcError(id, -32601, `Unknown tool: ${name}`));
    } catch (error) {
      sendRpc(res, jsonRpcError(undefined, -32603, 'Internal error', {
        message: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
  });

  return router;
}
