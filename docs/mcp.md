# MCP Endpoint (`/mcp`)

Wayfinder exposes a remote MCP-compatible JSON-RPC endpoint at `POST /mcp`.

This endpoint allows agent runtimes to:
- discover tools (`tools/list`)
- call tools (`tools/call`)
- initialize MCP sessions (`initialize`)

## Endpoint Summary

- **Discovery**: `GET /mcp`
- **RPC Transport**: `POST /mcp`
- **Content-Type**: `application/json`
- **Protocol Style**: JSON-RPC 2.0 envelopes

Related discovery files:
- `/prompt.txt`
- `/llms.txt`
- `/.well-known/mcp.json`
- `/.well-known/ai-plugin.json`

## Supported Methods

### `initialize`
Returns protocol metadata, server info, and capabilities.

### `tools/list`
Returns available tools and input schemas.

### `tools/call`
Executes a tool by name.

### `notifications/initialized`
Handled as a notification and returns **204 No Content**.

## Available Tools

### 1) `wayfinder_route`
Routes a prompt via Wayfinder and returns the recommended `primary` and `alternate` models.

**Arguments**:
- `prompt` (required)
- `token` (optional; can also be passed via headers)
- `router_model` (optional)
- `prefer_model` (optional)
- `context` (optional object)
- `metadata` (optional object)

### 2) `wayfinder_cache_stats`
Returns semantic cache stats and connection status.

**Arguments**:
- `admin_api_key` (required when `ADMIN_API_KEY` is configured)

## Authentication

For `wayfinder_route`, token extraction priority is:
1. `X-Wayfinder-Token` header
2. `Authorization: Bearer <token>` header
3. `params.arguments.token`

This priority is intentionally aligned with MCP rate-limiter keying.

## Rate Limiting

`/mcp` is rate-limited using the same routing limits as `/route`:
- `RATE_LIMIT_ROUTING_WINDOW_MS`
- `RATE_LIMIT_ROUTING_MAX`

Limiter keying follows the same token extraction priority as above, then falls back to client IP.

## Error Semantics

- Protocol and validation errors return JSON-RPC error envelopes.
- Internal dependency/runtime failures are wrapped as JSON-RPC `-32603` errors.
- Notification messages (`notifications/initialized`) return HTTP 204 with no response body.

## Example: `tools/list`

```bash
curl -sS https://wyfndr.ai/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Example: `wayfinder_route`

```bash
curl -sS https://wyfndr.ai/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WAYFINDER_TOKEN" \
  -d '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/call",
    "params":{
      "name":"wayfinder_route",
      "arguments":{
        "prompt":"Write a SQL query to find churned users this month"
      }
    }
  }'
```
