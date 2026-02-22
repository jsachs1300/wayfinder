export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string }>;
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
}

export function buildOpenApiSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Wayfinder API',
      version: '1.0.0',
      description:
        'Machine-readable API contract for Wayfinder routing and MCP access. Behavioral guidance follows model-spec style constraints in system prompts and endpoint docs.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          responses: {
            '200': { description: 'Service health payload' },
          },
        },
      },
      '/route': {
        post: {
          summary: 'Get model routing decision for a prompt',
          parameters: [
            {
              in: 'header',
              name: 'X-Wayfinder-Token',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RouteRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Routing decision',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RouteResponse' },
                },
              },
            },
          },
        },
      },
      '/mcp': {
        get: {
          summary: 'Wayfinder MCP discovery convenience endpoint',
          responses: { '200': { description: 'MCP discovery payload' } },
        },
        post: {
          summary: 'Wayfinder MCP JSON-RPC endpoint',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JsonRpcRequest' },
              },
            },
          },
          responses: {
            '200': { description: 'JSON-RPC response' },
            '204': { description: 'No Content for notifications' },
          },
        },
      },
    },
    components: {
      schemas: {
        RouteRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            router_model: { type: 'string', enum: ['openai', 'gemini', 'consensus'] },
            prefer_model: { type: 'string' },
            context: { type: 'object', additionalProperties: true },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        RouteResponse: {
          type: 'object',
          properties: {
            primary: { type: 'object', additionalProperties: true },
            alternate: { type: 'object', additionalProperties: true },
            request_id: { type: 'string' },
            router_model_used: { type: 'string' },
            from_cache: { type: 'boolean' },
          },
        },
        JsonRpcRequest: {
          type: 'object',
          properties: {
            jsonrpc: { type: 'string', const: '2.0' },
            id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            method: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
          },
          required: ['jsonrpc', 'method'],
        },
      },
    },
  };
}
