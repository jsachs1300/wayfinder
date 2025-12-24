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

Required: `ADMIN_API_KEY`

Optional:
- `PORT` (default: 3000)
- `REDIS_ENABLED` / `REDIS_URL` (falls back to in-memory if disabled)
- `LOG_LEVEL` (debug, info, warn, error)
- `KNOWLEDGE_DECAY_LAMBDA`, `MIN_VOTES_FOR_STRONG_CONFIDENCE`

## Testing

Tests use Vitest with supertest for HTTP assertions. Test files mirror source structure in `test/`. Edge case tests are separated (e.g., `policy-edge-cases.test.ts`).
