import { Router, Request, Response } from 'express';
import { z } from 'zod';
import packageJson from '../../package.json';
import type { RoutingEngine } from '../routing';
import { projectRouteResponse } from '../routing/projection';
import type { TokenStore } from '../tokens/store';
import type { UserStore } from '../users/store';
import type { RouteRequest, RouterModelPreference } from '../types';
import { VALID_ROUTER_MODEL_PREFERENCES } from '../types';
import { hashToken, extractWayfinderToken } from '../auth';
import { logRoutingUsage } from '../observability/events';
import { recordRoutingError, recordRoutingRequest } from '../observability/metrics';
import type { Logger } from '../logging/logger';
import type { TokenMetricsStore } from '../tokens/metrics';

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

function sendRpc(res: Response, payload: Record<string, unknown>): void {
  res.status(200).json(payload);
}

export function createMcpRoutes(
  routingEngine: RoutingEngine,
  tokenStore: TokenStore,
  userStore?: UserStore,
  logger?: Logger,
  metricsStore?: TokenMetricsStore,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      protocol: 'mcp',
      protocol_version: '2025-03-26',
      transport: 'jsonrpc',
      endpoint: '/mcp',
      methods: ['initialize', 'tools/list', 'tools/call'],
      tools: ['wayfinder_route'],
      note: 'This GET payload is a Wayfinder convenience response, not an MCP spec discovery primitive.',
    });
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = JsonRpcRequestSchema.safeParse(req.body);
    const requestId = parsed.success ? parsed.data.id : undefined;

    try {
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
            version: packageJson.version,
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
                  token: { type: 'string', description: 'Optional Wayfinder API token (wf_...). Prefer header auth.' },
                  prompt: { type: 'string', description: 'User prompt to route.' },
                  router_model: { type: 'string', enum: VALID_ROUTER_MODEL_PREFERENCES },
                  prefer_model: { type: 'string' },
                  context: { type: 'object', additionalProperties: true },
                  metadata: { type: 'object', additionalProperties: true },
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

        const providedToken = extractWayfinderToken(req, routeArgs.data.token);
        if (!providedToken) {
          sendRpc(res, jsonRpcError(id, -32001, 'Missing Wayfinder token (X-Wayfinder-Token, Authorization Bearer, or arguments.token)'));
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

        const routeRequest: RouteRequest = {
          prompt: routeArgs.data.prompt,
          router_model: routeArgs.data.router_model,
          prefer_model: routeArgs.data.prefer_model,
          context: routeArgs.data.context,
          metadata: routeArgs.data.metadata,
        };

        const requestedRouter = routeRequest.router_model || tokenConfig.router_model_preference || 'consensus';
        recordRoutingRequest({ router_model_requested: requestedRouter });

        const wfRequestId = req.requestId || `mcp-${Date.now()}`;
        const routingStart = Date.now();
        const result = await routingEngine.route(routeRequest, tokenConfig, wfRequestId, userContext);
        const routingDurationMs = Date.now() - routingStart;

        const response = projectRouteResponse(
          result.decision,
          wfRequestId,
          result.router_model_used || requestedRouter,
          result.cache_hit || false,
        );

        if (logger) {
          logRoutingUsage(logger, {
            request_id: wfRequestId,
            token_id: tokenConfig.id,
            user_id: (userContext?.user as { id?: string } | undefined)?.id,
            token_tier: userContext?.userTier,
            provider: response.router_model_used,
            router_model_requested: requestedRouter,
            router_model_used: response.router_model_used,
            cache_hit: result.cache_hit ?? false,
            llm_call: !(result.cache_hit ?? false),
            llm_latency_ms: result.cache_hit ? undefined : routingDurationMs,
            eligible_models_count: result.policyMetadata.eligibleModelsCount,
          });
        }

        if (metricsStore) {
          await metricsStore.incrementRouteRequest(tokenConfig.id, result.cache_hit ?? false);
        }

        sendRpc(res, jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response,
        }));
        return;
      }

      sendRpc(res, jsonRpcError(id, -32601, `Unknown tool: ${name}`));
    } catch (error) {
      logger?.error('MCP internal error', {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      recordRoutingError({ error_type: 'internal', router_model_requested: 'consensus' });
      sendRpc(res, jsonRpcError(requestId, -32603, 'Internal error'));
      return;
    }
  });

  return router;
}
