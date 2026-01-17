# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start development server with hot reload
npm run build        # Compile TypeScript to dist/
npm start            # Run production build
npm test             # Run all tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run lint         # Run ESLint
```

To run a single test file:
```bash
npx vitest run test/routing.test.ts
```

Docker development:
```bash
docker-compose -f docker-compose.dev.yml up   # Development with Redis
docker-compose up --build                      # Production build
```

## Architecture Overview

Wayfinder is an **LLM routing control plane** that directs requests to appropriate models based on policy, trust preferences, and learned knowledge. It does not execute model requests—it only provides routing decisions.

### Core Routing Flow

```
Request → Auth → Apply Policy → Invoke Router LLM → Return Decision
```

The routing engine (`src/routing/engine.ts`) orchestrates this flow:
1. **Policy Evaluation**: Token-scoped rules determine eligible models (policy always enforced before routing)
2. **Router LLM Invocation**: LLM makes routing decision and infers intent from user prompt
3. **Response Validation**: Validates router LLM response against canonical schema
4. **Intent Logging**: Intent returned by router LLM is logged for analysis (not used for routing logic)

### Key Components

| Directory | Responsibility |
|-----------|---------------|
| `src/routing/` | Orchestrates routing decisions via `DefaultRoutingEngine` and router LLM |
| `src/policy/` | Evaluates token policy rules (ForceModelByIntent, RestrictModelsByIntent, etc.) |
| `src/knowledge/` | Stores model votes per intent, calculates agreement scores, applies decay |
| `src/tokens/` | Token CRUD operations, supports in-memory and Redis storage |
| `src/models/` | Registry of LLM models with metadata (provider, capabilities, cost/speed tiers) |
| `src/feedback/` | Processes user feedback to update knowledge store |

### Token-Scoped Policy Model

Each API token is a complete policy boundary with its own:
- Trusted anchor model (fallback for low confidence)
- Allowed/denied model lists
- Intent-specific policy rules
- Confidence threshold for knowledge-based routing

### Knowledge Store Behavior

The knowledge store is **not a cache**—it accumulates votes and calculates consensus:
- Records model votes per intent cluster
- Calculates agreement scores (consensus strength)
- Applies decay over time (reduces weight, never deletes)
- Confidence levels: strong (≥0.8 + min votes), moderate (≥0.6), low (<0.6)

## Environment Variables

### Required for Production

- `ADMIN_API_KEY` - Admin API key for token management
- **Router LLM** (at least one provider):
  - `ROUTER_LLM_OPENAI_ENABLED=true` + `ROUTER_LLM_OPENAI_API_KEY`
  - OR `ROUTER_LLM_GEMINI_ENABLED=true` + `ROUTER_LLM_GEMINI_API_KEY`
  - Both providers can be enabled for multi-provider ranking
- **LangCache** (semantic caching):
  - `LANGCACHE_ENABLED=true`
  - `LANGCACHE_HOST`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY`

### Test/Development Override

Set `NODE_ENV=development` or `NODE_ENV=test` to bypass router LLM and LangCache requirements. This allows tests to run without external dependencies.

### Optional

- `PORT` (default: 3000)
- `NODE_ENV` (development, test, production)
- `REDIS_ENABLED` / `REDIS_URL` (falls back to in-memory if disabled)
- `LOG_LEVEL` (debug, info, warn, error)
- `KNOWLEDGE_DECAY_RATE`, `MIN_VOTES_FOR_STRONG_CONFIDENCE`
- `ROUTER_LLM_TIMEOUT`, `ROUTER_LLM_MAX_RETRIES`, `ROUTER_LLM_TEMPERATURE`, `ROUTER_LLM_MAX_TOKENS`

## Testing

Tests use Vitest with supertest for HTTP assertions. Test files mirror source structure in `test/`. Edge case tests are separated (e.g., `policy-edge-cases.test.ts`).

## Known Technical Debt

### LangCache Type Definitions (Medium Priority)

**Location:** `src/cache/semantic-cache.ts:25-41`

**Issue:** Locally-defined types create potential for type drift and maintenance burden.

The `SearchStrategy`, `SearchResponse`, and `CacheEntry` types are defined locally to work around module resolution issues:

```typescript
// Local definitions - could drift from @redis-ai/langcache
type SearchStrategy = 'exact' | 'semantic';
const SearchStrategy = {
  Exact: 'exact' as const,
  Semantic: 'semantic' as const,
};

interface CacheEntry {
  response: string;
  similarity?: number;
  searchStrategy?: string;
}

interface SearchResponse {
  data: CacheEntry[];
}
```

**Root Cause:** The `@redis-ai/langcache` package uses modern package.json `exports` field for type definitions, which isn't supported by TypeScript's `moduleResolution: "node"` setting. Importing from `@redis-ai/langcache/models` fails at compile time.

**Risk:** If `@redis-ai/langcache` updates these types in a future version, this code won't catch the breaking change at compile time. Type mismatches will only be discovered at runtime.

**Mitigation Options:**
1. Upgrade to TypeScript `moduleResolution: "node16"` or `"bundler"` (requires changing `module` setting to `Node16` or ES modules)
2. Add integration tests that validate type compatibility with the actual LangCache package
3. Monitor `@redis-ai/langcache` releases and manually verify type compatibility
4. Extract types from the package's `.d.ts` files during build process

**Current Status:** Accepted technical debt. Runtime behavior is correct, but type safety could be improved.
