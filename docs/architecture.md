# Architecture

_Extracted from the previous README. This page contains architecture and component layout._

## Architecture

### Core Design

Wayfinder architecture centers on the router LLM as the decision maker, with policy as a constraint layer:

```
User Request
    ↓
Authentication (Token validation)
    ↓
Policy Engine (Filter eligible models)
    ↓
Router LLM (Make routing decision)
    ↓
Response Validation & Projection
    ↓
User Response (primary, alternate, request_id)
```

### Project Structure

```
src/
├── server.ts          # Entry point, starts Express server
├── app.ts             # Express app setup and route mounting
├── types/             # TypeScript type definitions
│   └── index.ts       # Core types (RouteDecision, TokenConfig, etc.)
├── auth/              # Authentication middleware
│   ├── index.ts       # Auth middleware exports
│   └── middleware.ts  # Token & admin auth validation
├── tokens/            # Token management
│   ├── index.ts       # Token store exports
│   ├── store.ts       # Token storage (in-memory & Redis)
│   └── routes.ts      # Admin token endpoints
├── policy/            # Policy evaluation engine
│   ├── index.ts       # Policy engine exports
│   └── engine.ts      # Policy rule evaluation logic
├── routing/           # LLM-driven routing
│   ├── engine.ts      # Orchestrates routing flow
│   ├── config.ts      # Router LLM configuration loading
│   ├── routes.ts      # /route endpoint
│   ├── validation.ts  # Canonical schema validation
│   ├── projection.ts  # Response projection (drops intent)
│   └── router-llm/    # Router LLM implementations
│       ├── default-router-llm.ts    # Production LLM provider
│       ├── stub-router-llm.ts       # Testing stub
│       ├── config.ts                # Configuration types
│       ├── prompt-builder.ts        # Prompt construction
│       ├── response-parser.ts       # Response parsing
│       ├── errors.ts                # Error types
│       └── providers/               # Provider clients
│           ├── openai-client.ts     # OpenAI API
│           ├── anthropic-client.ts  # Anthropic API (unused)
│           └── types.ts             # Provider interface
├── knowledge/         # Knowledge store (observational telemetry)
│   ├── index.ts       # Knowledge store exports
│   └── store.ts       # Vote recording and consensus calculation
├── models/            # Model registry
│   ├── index.ts       # Registry exports
│   ├── registry.ts    # Model definitions
│   └── errors.ts      # Model validation errors
├── feedback/          # Feedback handling
│   ├── index.ts       # Feedback handler exports
│   ├── handler.ts     # Feedback processing logic
│   └── routes.ts      # /feedback endpoint
├── polling/           # Opinion polling (stub)
│   ├── index.ts       # Polling exports
│   └── stub.ts        # Placeholder for future polling
└── logging/           # Structured logging
    ├── index.ts       # Logger exports
    ├── logger.ts      # Console-based logger
    └── routing-decision.ts # Routing decision logging
```

### Component Responsibilities

- **Auth**: Validates tokens, loads token config, enforces per-request authentication
- **Routing Engine**: Orchestrates policy evaluation and router LLM invocation
- **Router LLM**: Makes actual routing decisions (external LLM call)
- **Policy Engine**: Constrains eligible models based on token rules
- **Tokens**: CRUD operations for token configurations (policy boundaries)
- **Knowledge Store**: Records feedback, calculates consensus (observational only)
- **Model Registry**: Validates model identifiers, tracks availability and status
- **Feedback**: Processes user ratings to update knowledge
- **Logging**: Structured logging of decisions for observability

