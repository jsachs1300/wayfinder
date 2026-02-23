# MCP Endpoint (`/mcp`)

Wayfinder exposes a remote MCP-compatible JSON-RPC endpoint at `POST /mcp`.

This endpoint allows agent runtimes to:
- discover tools (`tools/list`)
- call tools (`tools/call`)
- initialize MCP sessions (`initialize`)

## Endpoint Summary

- **Discovery**: `GET /mcp` (Wayfinder convenience endpoint; not an MCP standard discovery format)
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

### 2) `wayfinder_cache_stats` (temporarily unavailable)
This admin-oriented MCP command has been removed from the active `/mcp` tool list for now.
We will revisit admin MCP commands in a future iteration.

## Authentication

For `wayfinder_route`, token extraction priority is:
1. `X-Wayfinder-Token` header
2. `Authorization: Bearer <token>` header
3. `params.arguments.token`

This priority is intentionally aligned with MCP rate-limiter keying.

Future admin MCP commands (including cache/admin operations) should treat secret fields like `admin_api_key` as sensitive: inject from environment/secret manager and avoid logging full MCP request payloads.

## Rate Limiting

`/mcp` uses **layered** rate limiting:

1. **MCP endpoint limiter** (all non-notification `POST /mcp` requests)
   - Shares the same config as `/route`:
     - `RATE_LIMIT_ROUTING_WINDOW_MS`
     - `RATE_LIMIT_ROUTING_MAX`
   - Keying follows the same token extraction priority as above, then falls back to client IP.

2. **Tier limiter** (`wayfinder_route` tool calls only)
   - Applies tier-based burst/hour/day limits when user self-service is enabled.
   - Tier is resolved from the token owner when available; legacy/no-user tokens are treated as `free`.

`notifications/initialized` bypasses the MCP endpoint limiter and returns `204 No Content`.

## Error Semantics

- **JSON-RPC error envelopes** are used for protocol/tool-handler errors (examples: invalid request/params, unknown method/tool, invalid token, inactive token owner, internal handler failures).
- **Plain HTTP JSON errors** can be returned by upstream middleware before the JSON-RPC handler runs, including:
  - `429` from MCP endpoint or tier rate limiting
  - `503` from tier rate limiter backend failures for free-tier traffic
- Notification messages (`notifications/initialized`) return HTTP `204` with no response body.

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
