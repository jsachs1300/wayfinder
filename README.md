# Wayfinder

Wayfinder is an LLM routing control plane that delegates routing decisions to an external router LLM, subject to policy constraints and token configuration. It directs requests to the appropriate model based on policy enforcement, trust preferences, and learned knowledge.

## What Wayfinder Does

Wayfinder is a **routing control plane** that:

1. **Enforces Policy** - Applies token-scoped rules to determine which models are eligible for selection
2. **Delegates to Router LLM** - Invokes an external LLM (OpenAI or Anthropic) to make intelligent routing decisions
3. **Returns Recommendations** - Provides primary and alternate model recommendations with confidence scores and explanations
4. **Records Feedback** - Accumulates user feedback to build knowledge for observational and analytical purposes

Unlike a load balancer, Wayfinder's router LLM understands prompt semantics and makes informed decisions. Policy constraints ensure all routing respects security and compliance requirements.

## Quick Start

Get Wayfinder running in 4 steps:

```bash
# 1. Clone and install
git clone <repository-url>
cd wayfinder
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set ADMIN_API_KEY and ROUTER_LLM_API_KEY

# 3. Run the server
npm run dev
```

The system requires a router LLM API key to function. Without it, you'll get an error. See [Router LLM Setup](#router-llm-setup-required) below.

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

Response:
```json
{
  "primary": {
    "model": "gpt-4-turbo",
    "score": 8.2,
    "reason": "Excellent for coding tasks with strong reasoning capabilities"
  },
  "alternate": {
    "model": "claude-3-5-sonnet",
    "score": 7.8,
    "reason": "Alternative with comparable coding ability and different strengths"
  },
  "request_id": "req_a1b2c3d4-e5f6-7890"
}
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

> ⚠️ **Note:** Intent-based rules (steps 2-3) are currently in beta with a known timing limitation. They only match if configured for intent `"other"`. Use global allow/deny rules (step 1) for production. See [Policy Rule Types](#policy-rule-types) for details.

### Knowledge Store

The knowledge store is **not a traditional cache**:
- Accumulates model votes per intent cluster
- Calculates agreement scores (consensus strength)
- Uses lazy exponential decay at read time to reduce influence of old data
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
- Knowledge remains long-lived with lazy decay; it is not a cache

**Tradeoffs:**
- **Global**: Maximum shared learning, network effects, best consensus
- **Token-scoped**: Isolation, compliance, custom tuning, but slower learning

> ℹ️ Knowledge decay and statistics are now lazy and incremental (see [issue #6](https://github.com/jsachs1300/wayfinder/issues/6)). Effective scores are computed at read time using exponential decay, and statistics are updated on writes, so aggregate totals are approximate over time without scanning Redis keyspaces.

### Semantic Caching

Wayfinder supports **optional semantic caching** using Redis LangCache to significantly reduce router LLM API costs and improve response times.

**What is Semantic Caching?**

Traditional caching matches exact keys. Semantic caching uses embeddings to match semantically similar prompts, even if the wording differs:

```
"Write a Python function to reverse a string"  ≈  "Create a string reversal function in Python"
```

Both prompts would return the same cached routing decision, avoiding redundant LLM calls.

**Why Wayfinder Uses Semantic Caching**

- **Cost Reduction**: Avoid router LLM API calls for similar prompts (can save 40-70% on costs)
- **Faster Response**: Cache hits return instantly without LLM latency
- **Consistency**: Similar prompts get consistent routing decisions
- **Token-Scoped**: Each token has isolated cache namespace for security and compliance

**How It Works**

Per REQUIREMENTS.md §8 step 8, cache is queried:
1. **After** policy evaluation (ensures policy is always enforced)
2. **Before** router LLM invocation (only if cache miss)
3. Cache key includes `token_id` + `eligible_models_hash` for automatic invalidation

**Cache Behavior:**
- Cache **hit**: Return cached decision, skip router LLM (fast path)
- Cache **miss**: Invoke router LLM, store result in cache (fire-and-forget)
- Cache **failure**: Log error, continue with routing (graceful degradation)

**Setup Instructions**

1. **Get LangCache Credentials**
   - Sign up at [Redis LangCache](https://redis.io/langcache/)
   - Create a cache instance
   - Note your: `HOST`, `CACHE_ID`, `API_KEY`

2. **Configure Environment Variables**

   ```bash
   # Enable semantic caching
   LANGCACHE_ENABLED=true

   # LangCache API configuration
   LANGCACHE_HOST=your-cache-id.langcache.redis.io
   LANGCACHE_CACHE_ID=your-cache-id
   LANGCACHE_API_KEY=your-langcache-api-key

   # Optional: tune similarity threshold (default: 0.9)
   LANGCACHE_SIMILARITY_THRESHOLD=0.9

   # Optional: set cache TTL in seconds (default: 3600 = 1 hour)
   LANGCACHE_TTL=3600
   ```

3. **Restart Wayfinder**

   ```bash
   npm run dev  # or npm start
   ```

   You should see: `Semantic cache initialized`

**Configuration Options**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANGCACHE_ENABLED` | No | `false` | Enable/disable semantic caching |
| `LANGCACHE_HOST` | Yes* | - | LangCache API hostname |
| `LANGCACHE_CACHE_ID` | Yes* | - | Cache ID from LangCache console |
| `LANGCACHE_API_KEY` | Yes* | - | LangCache API authentication key |
| `LANGCACHE_SIMILARITY_THRESHOLD` | No | `0.9` | Semantic similarity threshold (0.0 - 1.0) |
| `LANGCACHE_TTL` | No | `3600` | Cache entry TTL in seconds |

*Required only if `LANGCACHE_ENABLED=true`

**Similarity Threshold Guidance**

- **0.95+**: Very strict (only nearly identical prompts match)
- **0.85-0.95**: Recommended for production (balanced)
- **0.75-0.85**: Lenient (more cache hits, less precise)
- **< 0.75**: Too loose (risk of incorrect matches)

**Monitoring Cache Performance**

Get cache statistics:

```bash
curl http://localhost:3000/admin/cache/stats \
  -H "X-Admin-Api-Key: your-admin-key"
```

Response:
```json
{
  "hits": 142,
  "misses": 58,
  "entries": 58,
  "hit_rate": 0.71,
  "last_updated": "2026-01-04T18:30:00.000Z"
}
```

**Cache Management**

Clear entire cache:

```bash
curl -X POST http://localhost:3000/admin/cache/clear \
  -H "X-Admin-Api-Key: your-admin-key"
```

Clear cache for specific token:

```bash
curl -X POST http://localhost:3000/admin/cache/clear \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"token_id": "wf_xxxxx"}'
```

**Token Isolation**

Each token has its own cache namespace. Cached decisions for token A are never returned for token B, even for identical prompts. This ensures:
- Security (no cross-token data leakage)
- Compliance (token-specific policies respected)
- Correctness (policy changes invalidate cache automatically)

**Policy-Aware Caching**

Cache keys include a hash of eligible models. If policy changes which models are eligible, the cache automatically invalidates:

```
Before policy change: eligible_models = ["gpt-4", "claude-3-opus"]
After policy change:  eligible_models = ["gpt-4", "gpt-4-turbo"]
→ Different eligible_models_hash → Cache miss → Fresh routing decision
```

**Troubleshooting**

**Cache not initializing:**
```
Error: LANGCACHE_HOST environment variable is required
```
→ Set all required environment variables (`LANGCACHE_HOST`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY`)

**Low cache hit rate (<20%):**
- Prompts are too diverse (expected for low-volume traffic)
- Similarity threshold too high (try lowering to 0.85)
- Cache TTL too short (consider increasing)

**High cache hit rate but poor decisions:**
- Similarity threshold too low (try raising to 0.92)
- Prompts semantically similar but require different models

**Cache errors in logs but routing still works:**
- This is expected (graceful degradation)
- Cache failures never block routing
- Fix underlying LangCache connectivity issue

**Disabling Cache**

Set `LANGCACHE_ENABLED=false` or remove the variable entirely. Wayfinder works perfectly without caching—it's purely an optimization.

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

## Routing Decision Flow

Every routing request follows this deterministic flow:

```
1. Request arrives with prompt and token
                ↓
2. Authenticate token
                ↓
3. Load token configuration
                ↓
4. Apply policy constraints → determine eligible models
                ↓
5. Is there a forced model?
   ├─ YES → Return forced model immediately
   └─ NO → Continue to router LLM
                ↓
6. Invoke router LLM with:
   • User prompt
   • Eligible models (post-policy)
   • Token configuration
                ↓
7. Router LLM returns:
   • Primary model recommendation + score
   • Alternate model recommendation + score
   • Confidence score (0-10)
   • Inferred intent (for internal analysis only)
   • Explanation for primary choice
                ↓
8. Validate response against canonical schema
                ↓
9. Project response (drop intent from user-facing output)
                ↓
10. Return result to user
```

**Key design principles:**
- Policy is always enforced BEFORE router LLM invocation
- Router LLM never sees ineligible models
- Intent is advisory metadata only—never used for routing
- Routing is deterministic given same inputs and cached state

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
- `POST /admin/knowledge/decay` - Deprecated; decay is now applied lazily on reads

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

Response (primary and alternate recommendations from router LLM):
```json
{
  "primary": {
    "model": "gpt-4-turbo",
    "score": 8.5,
    "reason": "Excellent reasoning and code generation. Best choice for algorithmic problems."
  },
  "alternate": {
    "model": "claude-3-5-sonnet",
    "score": 7.9,
    "reason": "Strong coding ability with clear explanations. Good alternative with different strengths."
  },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Note:** Intent is inferred by the router LLM but not returned in user-facing responses (logged internally).

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
  "allowed_models": ["gpt-4-turbo", "claude-3-5-sonnet", "claude-3-opus"],
  "policy_rules": [
    {
      "type": "AllowModelsGlobal",
      "models": ["gpt-4-turbo", "claude-3-opus"],
      "priority": 1
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

Manual decay is deprecated. The legacy `/admin/knowledge/decay` endpoint remains for compatibility but returns a 410 status and does not mutate data because decay is applied lazily on reads. Use `/admin/knowledge/stats` to observe approximate totals instead.

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
    "allowed_models": ["gpt-4-turbo", "claude-3-5-sonnet", "claude-3-opus"],
    "policy_rules": [
      {
        "type": "AllowModelsGlobal",
        "models": ["gpt-4-turbo", "claude-3-opus"],
        "priority": 1
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

#### Server Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (development, production) | `development` |

#### Authentication (Required)

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_API_KEY` | Admin API key for token management | **REQUIRED** |

#### Router LLM (Required)

| Variable | Description | Default |
|----------|-------------|---------|
| `ROUTER_LLM_API_KEY` | API key for router LLM provider | **REQUIRED** |
| `ROUTER_LLM_PROVIDER` | LLM provider (openai, anthropic) | `openai` |
| `ROUTER_LLM_MODEL` | Model to use for routing decisions | `gpt-4o-mini` |
| `ROUTER_LLM_TIMEOUT` | Request timeout in milliseconds | `10000` |
| `ROUTER_LLM_MAX_RETRIES` | Maximum retry attempts on failure | `2` |
| `ROUTER_LLM_TEMPERATURE` | Sampling temperature (0.0-2.0) | `0.0` |
| `ROUTER_LLM_MAX_TOKENS` | Maximum tokens in LLM response | `500` |

#### Redis & Storage

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `REDIS_ENABLED` | Enable Redis storage (true/false) | `false` |

#### Knowledge Store

| Variable | Description | Default |
|----------|-------------|---------|
| `KNOWLEDGE_DECAY_RATE` | Decay rate for knowledge entries | `0.05` |
| `KNOWLEDGE_DECAY_INTERVAL_HOURS` | Decay recalculation interval | `24` |
| `MIN_VOTES_FOR_STRONG_CONFIDENCE` | Minimum votes for strong confidence level | `5` |

#### Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |

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

Wayfinder supports two categories of policy rules: **Production-Ready Global Rules** and **Beta Intent-Based Rules**.

#### Global Rules (Production Ready)

Global rules apply regardless of intent and are fully supported for production use:

| Type | Description |
|------|-------------|
| `AllowModelsGlobal` | Globally allow only these models (allowlist) |
| `DenyModelsGlobal` | Globally deny these models (denylist) |

**Recommended Usage:**
- Use `allowed_models` in token configuration for simple allowlisting
- Use `denied_models` in token configuration for simple denylisting
- Use `AllowModelsGlobal` / `DenyModelsGlobal` policy rules for priority-based control

#### Intent-Based Rules (Beta)

> ⚠️ **Beta Feature with Known Limitations**

Intent-based policy rules are currently in **beta** and have an architectural limitation:

| Type | Description | Status |
|------|-------------|--------|
| `ForceModelByIntent` | Always use specified model for intent | **Beta - Limited** |
| `RestrictModelsByIntent` | Only allow specified models for intent | **Beta - Limited** |

**Current Limitation:**

Intent-based rules face a timing challenge:
- Intent is inferred **by the router LLM** during routing
- But policy evaluation happens **before** calling the router LLM
- Solution: All requests currently use placeholder intent `"other"` for policy evaluation

**What This Means:**
- ✅ **Global allow/deny rules work perfectly** - Use these for production
- ⚠️ **Intent-based rules only match if configured for intent `"other"`**
- ❌ Configuring rules for specific intents (e.g., `"coding"`, `"legal"`) will not match as expected

**Example - Intent-Based Rules (Beta Workaround):**

```json
{
  "policy_rules": [
    {
      "type": "ForceModelByIntent",
      "intent": "other",
      "models": ["claude-3-opus"],
      "priority": 1
    }
  ]
}
```

This will force `claude-3-opus` for all requests since all requests currently use `"other"` as the placeholder intent during policy evaluation.

**Recommended Approach:**

For now, use **global rules** instead of intent-based rules:

```json
{
  "allowed_models": ["gpt-4-turbo", "claude-3-5-sonnet", "claude-3-opus"],
  "denied_models": ["gpt-3.5-turbo"],
  "policy_rules": [
    {
      "type": "AllowModelsGlobal",
      "models": ["gpt-4-turbo", "claude-3-opus"],
      "priority": 1
    }
  ]
}
```

**Future Plans:**

This limitation will be addressed in a future version through architectural improvements. We're tracking this as a P1 priority. The fix will likely involve:
- Refactoring policy evaluation to support two-phase filtering (pre-LLM and post-LLM)
- Or restructuring the system to make intent available earlier in the flow

For updates, see the [GitHub issues](https://github.com/jsachs1300/wayfinder/issues).

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

## Router LLM Setup (REQUIRED)

Wayfinder requires a working router LLM to make routing decisions. The system WILL FAIL without proper configuration.

### Supported Providers

- **OpenAI** - gpt-4o-mini, gpt-4-turbo, gpt-4, o1-preview
- **Anthropic** - claude-3-5-sonnet, claude-3-opus

### Environment Configuration

Set these variables in your `.env` file:

```bash
# REQUIRED: Your router LLM provider API key
# Generate from https://platform.openai.com/api-keys (OpenAI)
# or https://console.anthropic.com/account/keys (Anthropic)
ROUTER_LLM_API_KEY=sk-your-api-key-here

# OPTIONAL: Provider to use (default: openai)
ROUTER_LLM_PROVIDER=openai
# Alternative:
# ROUTER_LLM_PROVIDER=anthropic

# OPTIONAL: Model to use for routing (default depends on provider)
# OpenAI default: gpt-4o-mini
# Anthropic default: claude-3-5-sonnet
ROUTER_LLM_MODEL=gpt-4o-mini

# OPTIONAL: Request timeout in milliseconds (default: 10000)
ROUTER_LLM_TIMEOUT=10000

# OPTIONAL: Maximum retry attempts on failure (default: 2)
ROUTER_LLM_MAX_RETRIES=2

# OPTIONAL: Sampling temperature for LLM (default: 0.0 = deterministic)
# Range: 0.0 (deterministic) to 2.0 (creative)
ROUTER_LLM_TEMPERATURE=0.0

# OPTIONAL: Maximum tokens in LLM response (default: 500)
ROUTER_LLM_MAX_TOKENS=500
```

### Quick Test

After configuration, test that your router LLM works:

```bash
# This will fail if ROUTER_LLM_API_KEY is not set or invalid
npm run dev

# In another terminal, try a route request
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: wf_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello"}'
```

If you see `RouterLLMError` or `ROUTER_LLM_API_KEY` error, check:
1. API key is set in `.env`
2. API key is valid for your provider
3. API key has sufficient quota

## Intent (Metadata Only)

The router LLM infers intent from the user prompt as part of its decision-making process. Intent is logged for internal observability and analysis, but MUST NOT influence routing logic.

**Important:** Removing or changing intent inference MUST NOT change routing behavior.

### Intent Labels

The router LLM returns one of these canonical intent labels:

- `code_change` - Writing or modifying code
- `debugging` - Finding and fixing bugs
- `architecture_design` - System design and architecture decisions
- `explanation` - Understanding concepts and explaining behavior
- `summarization` - Condensing content
- `data_analysis` - Working with data and statistics
- `content_generation` - Creating new content
- `planning` - Task planning and organization
- `other:<subcategory>` - Fallback for other intents

Intent is purely advisory and used only for:
- Observational telemetry
- Internal analysis and metrics
- Future feature development

Removing intent from the routing decision does NOT break the system.

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
│           ├── anthropic-client.ts  # Anthropic API
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

## Design Principles

1. **LLM-Driven Routing** - All routing decisions originate from the router LLM, never from local heuristics
2. **Policy as Constraint** - Policy filters eligible models; it never selects or ranks them
3. **Intent as Metadata** - Intent is inferred by the LLM for logging and analysis, but MUST NOT influence routing
4. **Token-Scoped Policies** - Each token is a complete policy boundary with its own configuration
5. **Fail Fast on Invalid Configuration** - Policy violations and configuration errors are surfaced immediately
6. **Explainable Decisions** - Every routing response includes confidence scores and reasoning from the LLM
7. **Deterministic Behavior** - Given the same inputs and cached state, routing produces the same results

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

### Example 2: Policy-Driven Routing (Production-Ready)

Use global rules to restrict model selection:

```bash
# Create token with model restrictions (recommended approach)
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "default_model": "gpt-4o",
    "allowed_models": ["gpt-4-turbo", "claude-3-5-sonnet", "claude-3-opus"],
    "denied_models": ["gpt-3.5-turbo"],
    "policy_rules": [
      {
        "type": "AllowModelsGlobal",
        "models": ["gpt-4-turbo", "claude-3-opus"],
        "priority": 1
      }
    ]
  }'
```

**Note:** Intent-based rules (ForceModelByIntent, RestrictModelsByIntent) are currently in beta and only work with intent `"other"`. See [Policy Rule Types](#policy-rule-types) for details.

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

### Router LLM Configuration

**Problem:** `RouterLLMError: ROUTER_LLM_API_KEY environment variable is required`

**Cause:** System cannot start without a router LLM API key.

**Solution:**
1. Get API key from your provider:
   - OpenAI: https://platform.openai.com/api-keys
   - Anthropic: https://console.anthropic.com/account/keys

2. Add to `.env`:
   ```bash
   ROUTER_LLM_API_KEY=sk-your-key-here
   ROUTER_LLM_PROVIDER=openai  # or 'anthropic'
   ```

3. Restart the server

### Router LLM API Failures

**Problem:** `RouterLLMRetryExhaustedError` or timeouts in routing requests

**Possible causes:**
- API key is invalid or expired
- API key has insufficient quota
- Provider is experiencing issues
- Timeout is too short for heavy load

**Solutions:**
```bash
# Increase timeout (default 10s)
ROUTER_LLM_TIMEOUT=15000

# Reduce max retries if getting stuck (default 2)
ROUTER_LLM_MAX_RETRIES=1

# Check API key validity by calling provider directly
# (This step depends on your provider)
```

### Router LLM Response Validation

**Problem:** `RouterLLMContractViolation` error

**Cause:** Router LLM returned a response that violates the canonical schema.

**Schema requirements:**
```json
{
  "intent": "string",
  "primary": {
    "model": "string",
    "score": number,
    "reason": "string"
  },
  "alternate": {
    "model": "string",
    "score": number,
    "reason": "string"
  }
}
```

**Solutions:**
- Check LLM prompt engineering in `src/routing/router-llm/prompt-builder.ts`
- Verify router LLM is capable of returning JSON
- Try switching LLM model to one with better structured output support
- Increase `ROUTER_LLM_MAX_TOKENS` if response is being truncated

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
- Invalid model identifier not in registry
- Invalid policy rule type
- Confidence threshold outside 0-1 range

**Solution:** Check the `details` field in the error response for specific validation issues.

### No Models Eligible After Policy

**Problem:** Router LLM has no models to choose from

**Cause:** Policy rules or denied_models list excluded all available models.

**Solution:**
```bash
# Check available models
curl http://localhost:3000/admin/models \
  -H "X-Admin-Api-Key: your-admin-key"

# Review token's policy rules
curl http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key"

# Update to allow more models
curl -X PATCH http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"allowed_models": ["gpt-4-turbo", "claude-3-opus"]}'
```

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

### Docker Build Failures

**Problem:** Docker build or compose fails

**Solutions:**
```bash
# Clean build without cache
docker-compose build --no-cache

# Check logs for specific errors
docker-compose logs wayfinder

# Ensure Node.js version compatibility
# Check Dockerfile uses node:18+ or compatible version
```

### Intent-Based Policy Rules Not Working

**Problem:** Intent-based policy rules (ForceModelByIntent, RestrictModelsByIntent) don't match as expected

**Cause:** Intent-based rules are currently in **beta** with a known timing limitation. All requests use placeholder intent `"other"` during policy evaluation.

**Solution:**

```bash
# Option 1: Use global rules instead (recommended)
curl -X PATCH http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "allowed_models": ["gpt-4-turbo", "claude-3-opus"],
    "policy_rules": [
      {
        "type": "AllowModelsGlobal",
        "models": ["gpt-4-turbo", "claude-3-opus"],
        "priority": 1
      }
    ]
  }'

# Option 2: Use intent-based rules with "other" intent (beta workaround)
curl -X PATCH http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "policy_rules": [
      {
        "type": "ForceModelByIntent",
        "intent": "other",
        "models": ["claude-3-opus"],
        "priority": 1
      }
    ]
  }'
```

See [Policy Rule Types](#policy-rule-types) for detailed explanation and migration guidance.

## Future Roadmap

### Short-term (v1.x)

- **Intent-Based Policy Rules (Full Support)** - Fix timing limitation to enable true intent-based routing policies (P1)
- **Real Opinion Polling** - Asynchronous polling of actual models to populate knowledge
- **Org-Scoped Knowledge** - Shared learning within organizations (in addition to global and token scopes)
- **Hybrid Knowledge Scope** - Combination of global and token-scoped learning
- **Advanced Observability** - Enhanced logging and metrics

### Medium-term (v2.x)

- **Knowledge-Guided Routing** - Use knowledge store to optimize router LLM decisions
- **Model Metadata in Decisions** - Return expanded model information in routing responses
- **Compliance & Audit** - Detailed audit trails and compliance reporting
- **Rate Limiting** - Per-token rate limits and quota management

### Longer-term

- **BYOM (Bring Your Own Model)** - Support for custom/internal LLM models
- **Multi-Modal Routing** - Route based on content type (text, image, etc.)
- **Cost Optimization** - Automatic model selection based on cost targets
- **Advanced Prompt Optimization** - Rewrite prompts for specific models

## What Wayfinder Does NOT Do

Wayfinder is NOT:
- A chatbot or conversational interface
- A prompt optimizer or rewriter
- A local heuristic router
- A model execution engine
- A capability matcher based on static task labels
- An auto-ML engine

These are intentional non-goals that keep the system focused and maintainable.

## License

MIT
