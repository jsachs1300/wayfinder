# Wayfinder

Wayfinder is an AI navigation and routing service that directs user intent to the appropriate LLM based on policy, trust preferences, and an evolving knowledge store. It is a new infrastructure layer for intelligent model selection, not a chatbot or simple wrapper.

## What Wayfinder Does

Wayfinder acts as a **routing control plane** for LLM requests:

1. **Classifies Intent** - Analyzes prompts to determine the type of task (coding, legal, creative, etc.)
2. **Enforces Policy** - Applies token-scoped rules to determine which models are eligible
3. **Consults Knowledge** - Uses accumulated routing intelligence to find consensus on best models
4. **Makes Decisions** - Returns an explainable routing decision with confidence levels

Unlike a simple load balancer, Wayfinder learns from feedback and builds confidence in its routing decisions over time.

## Quick Start

Get Wayfinder running in 3 steps:

```bash
# 1. Clone and install
git clone <repository-url>
cd wayfinder
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set ADMIN_API_KEY

# 3. Run the server
npm run dev
```

Then create your first token and make a routing request:

```bash
# Create a token (save the returned token value)
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"default_model": "gpt-4o"}'

# Use the token to route a request
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: wf_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a function to reverse a string"}'
```

## Core Concepts

### Token-Scoped Policy Model

Every API token is a policy boundary. Each token can have its own:
- **Trusted Anchor Model** - Fallback for low-confidence routing
- **Allowed/Denied Models** - Global model restrictions
- **Policy Rules** - Intent-specific model requirements
- **Confidence Threshold** - Minimum confidence for knowledge-based routing

### Policy Enforcement

Policy is **always enforced before optimization**. The evaluation order is:
1. Global allow/deny lists
2. Intent-based restrictions (`RestrictModelsByIntent`)
3. Forced models (`ForceModelByIntent`)

### Knowledge Store

The knowledge store is **not a traditional cache**:
- Accumulates model votes per intent cluster
- Calculates agreement scores (consensus strength)
- Applies decay to reduce influence of old data
- **Never deletes entries** - only reduces their weight

### Knowledge Scope

Wayfinder supports **configurable knowledge scope** for flexibility between shared learning and isolation:

**Global Knowledge (Default)**
- Shared learning across all tokens
- Builds the primary knowledge flywheel
- Best for most use cases
- Default when `knowledge_scope` is not specified

**Token-Scoped Knowledge (Enterprise)**
- Isolated knowledge per token
- Completely separate from global knowledge
- Use for compliance, isolation, or custom learning
- Does NOT merge with global knowledge
- Set via `knowledge_scope: "token"` when creating a token

**Future Scopes (Planned)**
- **Org Scope**: Shared knowledge within an organization
- **Hybrid Scope**: Combination of global + scoped knowledge

**Key Design Decisions:**
- Global scope is the default and recommended for most users
- Token-scoped knowledge is opt-in for enterprise use cases
- Scopes are completely isolated—no cross-scope leakage
- Policy enforcement always takes precedence over knowledge scope
- Knowledge remains long-lived with decay; it is not a cache

**Tradeoffs:**
- **Global**: Maximum shared learning, network effects, best consensus
- **Token-scoped**: Isolation, compliance, custom tuning, but slower learning

### Confidence Levels

- **Strong** (≥0.8 agreement + minimum votes): High confidence in consensus
- **Moderate** (≥0.6 agreement): Reasonable confidence
- **Low** (<0.6 agreement or insufficient votes): Use trusted anchor

### Full Model Disagreement

When models completely disagree, this results in **low confidence**, not an error. The system falls back to the trusted anchor or default model.

### Model Registry & Validation

Wayfinder maintains a **curated model registry** that serves as the single source of truth for valid model identifiers. Only models in this registry can participate in routing, policy, feedback, or knowledge operations.

**Why Validation Matters**

The model registry is not just a convenience—it's a **foundational correctness feature** that:
- Prevents data corruption in the knowledge store
- Enforces deterministic routing behavior
- Protects against typos and configuration errors
- Enables lifecycle management (active, deprecated, disabled)

**Model Lifecycle States**

Every model has a status that determines how it can be used:

- **`active`** - Fully operational, can be used everywhere
- **`deprecated`** - Still functional but logs warnings; may be removed in future
- **`disabled`** - Cannot be used anywhere (config, policy, feedback, knowledge votes)

**Global Eligibility**

Models also have a `global_eligible` flag. Only globally-eligible models can participate in global knowledge scope. This ensures that shared learning only happens across curated, high-quality models.

**Validation Enforcement**

Model identifiers are validated at **every ingestion point**:

1. **Token Creation/Update** - All model references in token config are validated
2. **Policy Rules** - Models in `ForceModelByIntent`, `RestrictModelsByIntent`, etc.
3. **Feedback Ingestion** - Both `selected_model` and `preferred_model` fields
4. **Opinion Polling** - All models in poll requests (even stubbed)
5. **Knowledge Votes** - Before recording any vote in the knowledge store

**Validation Rules**

When you specify a model identifier, Wayfinder validates:
- ✅ Model exists in the registry
- ✅ Model is not disabled
- ✅ Model is globally-eligible (if using global knowledge scope)
- ✅ Model respects token's allowed/denied lists

**What Happens When Validation Fails**

Invalid model identifiers **fail fast and loudly**:
- Token creation/update returns `400 Bad Request` with clear error message
- Feedback with invalid models is rejected before altering votes
- Polling with unknown models throws `InvalidModelError`
- No silent coercion, aliasing, or fallback is permitted

**Example Error Messages**

```
InvalidModelError: Invalid model identifier: "gpt-5-ultra" (context: token_config).
Model does not exist in the registry.

DisabledModelError: Model "legacy-model" is disabled and cannot be used (context: feedback).
Disabled models are excluded from all routing, policy, and knowledge operations.

ModelConfigurationError: trusted_anchor_model "claude-3-opus" cannot be in denied_models
```

**Deprecated Model Behavior**

Deprecated models still work but log structured warnings:
```json
{
  "level": "warn",
  "message": "Deprecated model in use",
  "metadata": {
    "model_id": "gpt-3.5-turbo",
    "context": "token_config",
    "message": "Model 'gpt-3.5-turbo' is deprecated and may be removed in the future"
  }
}
```

**Available Models**

To see all currently registered models:
```bash
curl http://localhost:3000/admin/models \
  -H "X-Admin-Api-Key: your-admin-key"
```

Models are curated and include major providers (OpenAI, Anthropic, Google, Meta, Mistral). Future versions may support BYOM (Bring Your Own Model) for custom models.

## Routing Lifecycle

```
Request → Auth → Classify Intent → Apply Policy → Check Knowledge → Select Model
                                        ↓
                               [Forced by Policy?]
                                   ↓ Yes        ↓ No
                            Return Forced   [High Confidence?]
                                               ↓ Yes      ↓ No
                                         Use Consensus  [Has Anchor?]
                                                          ↓ Yes    ↓ No
                                                    Use Anchor  Use Default
```

## API Endpoints Summary

### Public Endpoints
- `GET /health` - Health check (no authentication required)

### User Endpoints (Token Auth Required)
- `POST /route` - Route a request to the appropriate model
- `POST /feedback` - Submit feedback on a routing decision

### Admin Endpoints (Admin Auth Required)

**Token Management**
- `POST /admin/tokens` - Create a new token
- `GET /admin/tokens` - List all tokens
- `GET /admin/tokens/:id` - Get token by ID
- `PATCH /admin/tokens/:id` - Update token configuration
- `POST /admin/tokens/:id/rotate` - Rotate token (generates new token string)
- `DELETE /admin/tokens/:id` - Delete a token

**Knowledge Store**
- `GET /admin/knowledge/stats` - Get knowledge store statistics
- `POST /admin/knowledge/decay` - Manually trigger decay on all knowledge entries

**Models**
- `GET /admin/models` - List all available models

## API Reference

### Authentication

All requests require authentication:
- **User requests**: `X-Wayfinder-Token` header (format: `wf_xxxxx`)
- **Admin requests**: `X-Admin-Api-Key` header

### Endpoints

#### Routing

```http
POST /route
X-Wayfinder-Token: wf_xxxxx
Content-Type: application/json

{
  "prompt": "Write a function to sort an array",
  "context": {},
  "metadata": {}
}
```

Response:
```json
{
  "selected_model": "gpt-4-turbo",
  "routing_decision": {
    "reason": "knowledge_consensus",
    "confidence": "strong",
    "agreement_score": 0.85,
    "eligible_models": ["gpt-4-turbo", "claude-3-5-sonnet", "gemini-1.5-pro"],
    "timestamp": "2025-12-17T10:30:00.123Z",
    "knowledge_used": true,
    "policy_forced": false
  },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

#### Feedback

```http
POST /feedback
X-Wayfinder-Token: wf_xxxxx
Content-Type: application/json

{
  "request_id": "uuid-from-route-response",
  "selected_model": "gpt-4-turbo",
  "intent_label": "coding",
  "rating": "positive",
  "preferred_model": null
}
```

#### Admin: Token Management

```http
# Create token
POST /admin/tokens
X-Admin-Api-Key: your-admin-key
Content-Type: application/json

{
  "trusted_anchor_model": "claude-3-5-sonnet",
  "allowed_models": ["gpt-4-turbo", "claude-3-5-sonnet"],
  "policy_rules": [
    {
      "type": "ForceModelByIntent",
      "intent": "legal",
      "models": ["claude-3-opus"]
    }
  ],
  "confidence_threshold": 0.6,
  "default_model": "gpt-4o"
}

# List all tokens
GET /admin/tokens

# Get token by ID
GET /admin/tokens/:id

# Update token
PATCH /admin/tokens/:id

# Rotate token
POST /admin/tokens/:id/rotate

# Delete token
DELETE /admin/tokens/:id
```

#### Admin: Knowledge Store

```http
# Get stats (all scopes)
GET /admin/knowledge/stats
X-Admin-Api-Key: your-admin-key

# Get stats for global scope only
GET /admin/knowledge/stats?scope=global
X-Admin-Api-Key: your-admin-key

# Get stats for specific token scope
GET /admin/knowledge/stats?scope=token&token_id=token_abc123
X-Admin-Api-Key: your-admin-key
```

Response:
```json
{
  "total_entries": 42,
  "entries_by_confidence": {
    "strong": 12,
    "moderate": 18,
    "low": 12
  },
  "average_agreement_score": 0.72,
  "entries_by_scope": {
    "global": 30,
    "token": 12,
    "org": 0,
    "hybrid": 0
  }
}
```

```http
# Trigger decay (all scopes)
POST /admin/knowledge/decay
X-Admin-Api-Key: your-admin-key

# Trigger decay for global scope only
POST /admin/knowledge/decay?scope=global
X-Admin-Api-Key: your-admin-key

# Trigger decay for specific token scope
POST /admin/knowledge/decay?scope=token&token_id=token_abc123
X-Admin-Api-Key: your-admin-key
```

Response:
```json
{
  "message": "Decay applied",
  "entries_affected": 42,
  "scope": "global",
  "timestamp": "2025-12-17T10:30:00.123Z"
}
```

#### Admin: Models

```http
# Get all available models
GET /admin/models
X-Admin-Api-Key: your-admin-key
```

Response:
```json
{
  "models": [
    {
      "id": "gpt-4-turbo",
      "provider": "openai",
      "capabilities": ["reasoning", "coding", "creative", "support"],
      "cost_tier": "high",
      "speed_tier": "medium",
      "context_window": 128000,
      "available": true
    }
  ],
  "count": 14,
  "default": "claude-3-5-sonnet"
}
```

#### Health Check

```http
GET /health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-12-17T10:30:00.123Z",
  "redis_connected": true
}
```

## Local Development

### Prerequisites

- Node.js 18+
- Redis (optional, falls back to in-memory store)
- Docker & docker-compose (optional)

### Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings
# At minimum, set ADMIN_API_KEY

# Run in development mode
npm run dev

# Or with Docker
docker-compose -f docker-compose.dev.yml up
```

### Running Tests

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Building for Production

```bash
# Build TypeScript
npm run build

# Run production build
npm start

# Or with Docker
docker-compose up --build
```

## Example curl Commands

### Create a Token

```bash
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "trusted_anchor_model": "claude-3-5-sonnet",
    "default_model": "gpt-4o",
    "policy_rules": [
      {
        "type": "ForceModelByIntent",
        "intent": "legal",
        "models": ["claude-3-opus"]
      }
    ]
  }'
```

### Route a Request

```bash
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Write a Python function to calculate factorial"
  }'
```

### Submit Feedback

```bash
curl -X POST http://localhost:3000/feedback \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "uuid-from-route-response",
    "selected_model": "gpt-4-turbo",
    "intent_label": "coding",
    "rating": "positive"
  }'
```

### Check Health

```bash
curl http://localhost:3000/health
```

### View Knowledge Stats

```bash
curl http://localhost:3000/admin/knowledge/stats \
  -H "X-Admin-Api-Key: your-admin-key"
```

### List All Models

```bash
curl http://localhost:3000/admin/models \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Get a Token by ID

```bash
curl http://localhost:3000/admin/tokens/token_abc123 \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Update a Token

```bash
curl -X PATCH http://localhost:3000/admin/tokens/token_abc123 \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "confidence_threshold": 0.75,
    "default_model": "gpt-4-turbo"
  }'
```

### Rotate a Token

```bash
curl -X POST http://localhost:3000/admin/tokens/token_abc123/rotate \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Delete a Token

```bash
curl -X DELETE http://localhost:3000/admin/tokens/token_abc123 \
  -H "X-Admin-Api-Key: your-admin-key"
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `ADMIN_API_KEY` | Admin authentication key | Required |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `REDIS_ENABLED` | Enable Redis storage | `false` |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |
| `KNOWLEDGE_DECAY_RATE` | Decay rate per cycle (0-1) | `0.05` |
| `KNOWLEDGE_DECAY_INTERVAL_HOURS` | Hours between automatic decay cycles | `24` |
| `MIN_VOTES_FOR_STRONG_CONFIDENCE` | Minimum votes for strong confidence | `5` |

### Token Configuration Options

| Field | Type | Description |
|-------|------|-------------|
| `trusted_anchor_model` | string | Fallback model for low confidence |
| `allowed_models` | string[] | Only these models are allowed |
| `denied_models` | string[] | These models are blocked |
| `policy_rules` | PolicyRule[] | Intent-specific rules |
| `confidence_threshold` | number | Minimum confidence (0-1) |
| `logging_level` | "normal" \| "verbose" | Token-specific log level |
| `default_model` | string | Default when no other selection |
| `environment` | "prod" \| "dev" | Token environment |
| `knowledge_scope` | "global" \| "token" \| "org" \| "hybrid" | Knowledge isolation level (default: "global") |

### Policy Rule Types

| Type | Description |
|------|-------------|
| `ForceModelByIntent` | Always use specified model for intent |
| `RestrictModelsByIntent` | Only allow specified models for intent |
| `AllowModelsGlobal` | Globally allow only these models |
| `DenyModelsGlobal` | Globally deny these models |

## Available Models

Wayfinder includes a registry of well-known LLM models across major providers. **Note:** Wayfinder does not execute model requests - it only provides routing decisions.

### Supported Providers

- **OpenAI**: gpt-4-turbo, gpt-4o, gpt-4o-mini, o1, o1-mini
- **Anthropic**: claude-3-5-sonnet, claude-3-opus, claude-3-haiku
- **Google**: gemini-1.5-pro, gemini-1.5-flash
- **Meta**: llama-3.1-70b, llama-3.1-8b
- **Mistral**: mistral-large, mistral-medium

Each model includes metadata about:
- Provider
- Capabilities (reasoning, coding, legal, creative, etc.)
- Cost tier (low, medium, high)
- Speed tier (fast, medium, slow)
- Context window size
- Availability status

### Default Model

The system default model is `claude-3-5-sonnet`, used as a fallback when no other selection criteria apply.

## Intent Classification

Wayfinder uses heuristic pattern matching to classify user prompts into intent categories. This classification drives policy evaluation and knowledge lookups.

### Supported Intent Labels

| Intent | Description | Example Prompts |
|--------|-------------|-----------------|
| `code_review` | Code review and quality analysis | "Review this code", "Find bugs in this function" |
| `coding` | Writing or modifying code | "Write a function to sort an array", "Implement a REST API" |
| `legal` | Legal questions and compliance | "Is this contract legal?", "GDPR compliance requirements" |
| `summarization` | Text summarization tasks | "Summarize this article", "TL;DR of this document" |
| `reasoning` | Analytical and logical tasks | "Explain why this works", "Compare pros and cons" |
| `creative` | Creative writing and content | "Write a story", "Create a blog post" |
| `support` | Help and troubleshooting | "How do I fix this error?", "Help me understand" |
| `other` | Fallback for unclassified prompts | Prompts that don't match other patterns |

The classifier returns both the intent label and a confidence score (0-1) based on pattern matching strength.

## Error Responses

All API endpoints return consistent error responses with the following structure:

```json
{
  "error": "ErrorType",
  "message": "Human-readable error description",
  "details": {},
  "timestamp": "2025-12-17T10:30:00.123Z"
}
```

### Common Error Types

| Status Code | Error Type | Description |
|-------------|------------|-------------|
| 400 | `ValidationError` | Invalid request body or parameters |
| 401 | `Unauthorized` | Missing or invalid authentication credentials |
| 404 | `NotFound` | Resource not found (token, endpoint, etc.) |
| 500 | `InternalError` | Server error during processing |

### Example Error Responses

**Validation Error (400)**
```json
{
  "error": "ValidationError",
  "message": "Invalid request body",
  "details": {
    "issues": [
      {
        "path": ["prompt"],
        "message": "Required"
      }
    ]
  },
  "timestamp": "2025-12-17T10:30:00.123Z"
}
```

**Authentication Error (401)**
```json
{
  "error": "Unauthorized",
  "message": "Invalid admin API key",
  "timestamp": "2025-12-17T10:30:00.123Z"
}
```

**Not Found Error (404)**
```json
{
  "error": "NotFound",
  "message": "Token not found",
  "timestamp": "2025-12-17T10:30:00.123Z"
}
```

## Architecture

### Project Structure

```
src/
├── server.ts          # Entry point, starts Express server
├── app.ts             # Express app setup and route mounting
├── types/             # TypeScript type definitions
│   └── index.ts       # Core types for routing, policy, knowledge
├── auth/              # Authentication middleware
│   ├── index.ts       # Auth middleware exports
│   └── middleware.ts  # Token & admin auth validation
├── tokens/            # Token management
│   ├── index.ts       # Token store exports
│   ├── store.ts       # Token storage (in-memory & Redis)
│   └── routes.ts      # Admin token endpoints
├── intent/            # Intent classification
│   ├── index.ts       # Classifier exports
│   └── classifier.ts  # Heuristic-based intent classifier
├── policy/            # Policy engine
│   ├── index.ts       # Policy engine exports
│   └── engine.ts      # Policy evaluation logic
├── knowledge/         # Knowledge store
│   ├── index.ts       # Knowledge store exports
│   └── store.ts       # Vote recording, consensus, decay
├── models/            # Model registry
│   ├── index.ts       # Registry exports
│   └── registry.ts    # Model definitions and registry
├── routing/           # Routing engine
│   ├── index.ts       # Routing engine exports
│   ├── engine.ts      # Core routing decision logic
│   └── routes.ts      # /route endpoint
├── feedback/          # Feedback handling
│   ├── index.ts       # Feedback handler exports
│   ├── handler.ts     # Feedback processing logic
│   └── routes.ts      # /feedback endpoint
├── polling/           # Opinion polling (future/stub)
│   ├── index.ts       # Polling exports
│   └── stub.ts        # Placeholder for real polling
└── logging/           # Structured logging
    ├── index.ts       # Logger exports
    └── logger.ts      # Console-based structured logger
```

### Component Responsibilities

- **Auth**: Validates admin API keys and user tokens, sets token config on request
- **Tokens**: Creates, stores, updates, rotates, and deletes token configurations
- **Intent**: Classifies user prompts into intent categories using keyword patterns
- **Policy**: Evaluates policy rules to determine eligible models and forced selections
- **Knowledge**: Stores model votes per intent, calculates consensus and confidence
- **Models**: Registry of available LLM models with metadata
- **Routing**: Orchestrates intent, policy, and knowledge to make routing decisions
- **Feedback**: Processes user feedback to update knowledge store
- **Polling**: Placeholder for future opinion polling from actual models
- **Logging**: Structured logging with request IDs and metadata

## Design Principles

1. **Policy Before Optimization** - Rules are enforced before knowledge is consulted
2. **Explainable Decisions** - Every routing decision includes a reason and audit trail
3. **Graceful Degradation** - Falls back through anchor → default → system default
4. **Knowledge Decay** - Old data loses influence but is never deleted
5. **Token Isolation** - Each token is a complete policy boundary
6. **Extensibility** - Interfaces allow swapping implementations (BYOM ready)

## Usage Examples

### Example 1: Basic Routing

Create a token and route requests to get intelligent model selection:

```bash
# Create a basic token
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"default_model": "gpt-4o"}')

TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.token')

# Route a coding request
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a function to merge two sorted arrays"}'
```

### Example 2: Policy-Driven Routing

Force specific models for certain intent types:

```bash
# Create token with legal compliance policy
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "default_model": "gpt-4o",
    "policy_rules": [
      {
        "type": "ForceModelByIntent",
        "intent": "legal",
        "models": ["claude-3-opus"]
      },
      {
        "type": "RestrictModelsByIntent",
        "intent": "coding",
        "models": ["gpt-4-turbo", "claude-3-5-sonnet"]
      }
    ]
  }'
```

### Example 3: Learning from Feedback

Submit feedback to build knowledge consensus:

```bash
# 1. Route a request
ROUTE_RESPONSE=$(curl -s -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Summarize this article"}')

REQUEST_ID=$(echo $ROUTE_RESPONSE | jq -r '.request_id')
MODEL=$(echo $ROUTE_RESPONSE | jq -r '.selected_model')

# 2. Submit positive feedback
curl -X POST http://localhost:3000/feedback \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$REQUEST_ID\",
    \"selected_model\": \"$MODEL\",
    \"intent_label\": \"summarization\",
    \"rating\": \"positive\"
  }"

# 3. Check knowledge stats
curl http://localhost:3000/admin/knowledge/stats \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Example 4: Model Restrictions

Restrict to only cost-effective models:

```bash
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "allowed_models": [
      "gpt-4o-mini",
      "claude-3-haiku",
      "gemini-1.5-flash"
    ],
    "default_model": "gpt-4o-mini"
  }'
```

### Example 5: Token-Scoped Knowledge (Enterprise)

Create a token with isolated knowledge for compliance or custom learning:

```bash
# Create a token with token-scoped knowledge
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "default_model": "gpt-4o",
    "knowledge_scope": "token",
    "trusted_anchor_model": "claude-3-5-sonnet"
  }')

TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.token')
TOKEN_ID=$(echo $TOKEN_RESPONSE | jq -r '.id')

# This token will build its own isolated knowledge
# Feedback submitted with this token only affects this token's knowledge

# Submit feedback to build token-specific knowledge
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a Python function"}' | \
jq -r '.request_id' | \
xargs -I {} curl -X POST http://localhost:3000/feedback \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"request_id\": \"{}\", \"selected_model\": \"gpt-4o\", \"intent_label\": \"coding\", \"rating\": \"positive\"}"

# Check knowledge stats for this specific token
curl "http://localhost:3000/admin/knowledge/stats?scope=token&token_id=$TOKEN_ID" \
  -H "X-Admin-Api-Key: your-admin-key"
```

**When to use token-scoped knowledge:**
- Compliance requirements (data isolation)
- Multi-tenant applications (per-customer learning)
- Custom model preferences that shouldn't affect global knowledge
- Testing new routing strategies without polluting global data

## Troubleshooting

### Redis Connection Issues

**Problem:** Wayfinder fails to connect to Redis

**Solution:**
```bash
# Check if Redis is running
redis-cli ping

# If using Docker, ensure Redis service is healthy
docker-compose ps

# Disable Redis and use in-memory storage
# In .env:
REDIS_ENABLED=false
```

### Authentication Failures

**Problem:** `401 Unauthorized` responses

**Solutions:**
- Ensure `ADMIN_API_KEY` is set in `.env`
- Verify you're using the correct header name (`X-Admin-Api-Key` or `X-Wayfinder-Token`)
- Check that the token hasn't been deleted or rotated
- For user tokens, ensure the token starts with `wf_`

### Validation Errors

**Problem:** `400 ValidationError` on API requests

**Common causes:**
- Missing required fields (e.g., `prompt` in `/route` request)
- Invalid intent label (must be one of the supported intent types)
- Invalid policy rule type
- Confidence threshold outside 0-1 range

**Solution:** Check the `details` field in the error response for specific validation issues.

### No Models Eligible After Policy

**Problem:** Routing returns an error or unexpected model

**Solution:**
- Review your policy rules - they may be too restrictive
- Check `allowed_models` and `denied_models` on the token
- Use `GET /admin/models` to see all available models
- Review the `audit_trail` in routing decisions to see which policies were applied

### Knowledge Not Being Used

**Problem:** Routes always use trusted anchor or default model

**Possible causes:**
- Insufficient feedback submitted (need multiple votes for strong confidence)
- Confidence threshold set too high
- Not enough votes for the intent cluster (need at least `MIN_VOTES_FOR_STRONG_CONFIDENCE`)

**Solution:**
```bash
# Check current knowledge stats
curl http://localhost:3000/admin/knowledge/stats \
  -H "X-Admin-Api-Key: your-admin-key"

# Lower confidence threshold on token
curl -X PATCH http://localhost:3000/admin/tokens/YOUR_TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"confidence_threshold": 0.5}'
```

### Docker Build Failures

**Problem:** Docker build or compose fails

**Solutions:**
```bash
# Clean build without cache
docker-compose build --no-cache

# Check logs for specific errors
docker-compose logs wayfinder

# Ensure Node.js version compatibility
# Check Dockerfile uses node:20-alpine or compatible version
```

## Future Scope

- **BYOM (Bring Your Own Model)** - Register custom model endpoints
- **Real Opinion Polling** - Actual model consensus voting
- **Advanced Intent Classification** - ML-based classification
- **Metrics & Observability** - Prometheus metrics, tracing
- **Rate Limiting** - Per-token rate limits
- **Model Execution** - Actually route to LLM providers

## License

MIT
