# Wayfinder

Wayfinder is an LLM routing service. It accepts a prompt and returns ranked model recommendations (`primary` and `alternate`) based on token policy, model registry constraints, and learned knowledge.

Wayfinder can be used:
- directly from your app backend via the `/route` API
- from the Wayfinder web app (`https://wyfndr.ai`) for admin/user operations and route testing

## Quick Start

### UI Quick Start (`https://wyfndr.ai`)
1. Open `https://wyfndr.ai`.
2. Register and verify your email.
3. Complete registration, set your password, and sign in.
4. Go to token management in the console and create/rotate a token.
5. Use Route Playground to test routing, or copy the token for API usage.

### API Quick Start (`POST https://wyfndr.ai/route`)
1. Get a Wayfinder token from the UI (or from an admin).
2. Export it locally:

```bash
export WAYFINDER_TOKEN="wf_your_token_here"
```

3. Send a route request:

```bash
curl -sS https://wyfndr.ai/route \
  -H "Content-Type: application/json" \
  -H "X-Wayfinder-Token: $WAYFINDER_TOKEN" \
  -d '{
    "prompt": "Write a TypeScript function to deduplicate an array of objects by id",
    "router_model": "consensus"
  }'
```

Expected response shape:

```json
{
  "primary": { "model": "...", "score": 0, "reason": "..." },
  "alternate": { "model": "...", "score": 0, "reason": "..." },
  "request_id": "...",
  "router_model_used": "consensus",
  "from_cache": false
}
```

## API Reference

Complete backend API reference:
- `docs/api-reference.md`

Frontend-oriented API spec:
- `docs/frontend-api-spec.md`

## Documentation

- `docs/index.md` - Documentation index
- `docs/local-integration-testing.md` - Full local integration workflow (recommended pre-PR gate)
- `docs/quick-start.md` - Expanded setup and local dev
- `docs/core-concepts.md` - Routing/policy/cache/model concepts
- `docs/configuration.md` - Environment and runtime config
- `docs/examples.md` - Curl and workflow examples
- `docs/mcp.md` - MCP endpoint, tools, auth, and JSON-RPC behavior
- `docs/architecture.md` - Service architecture and structure
- `docs/troubleshooting.md` - Troubleshooting guide
- `PRODUCTION.md` - Deployment and production operations

## Pre-PR Checklist

Before opening a PR, run the local full integration workflow:

```bash
npm run local:deps:up
npm run test:integration:local-full
```

Setup details are in `docs/local-integration-testing.md`.

## License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`). See `LICENSE`.
