# Core Concepts

_Extracted from the previous README. This page contains core behavior and routing concepts._

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

### Semantic Caching (REQUIRED)

Wayfinder requires **semantic caching** using Redis LangCache to significantly reduce router LLM API costs and improve response times. For development/testing, set `NODE_ENV=development` to bypass this requirement.

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
- **Scope-Aware**: Default user tokens share global cache; non-default tokens use token-scoped cache

**How It Works**

Per REQUIREMENTS.md §8 step 8, cache is queried:
1. **After** policy evaluation (ensures policy is always enforced)
2. **Before** router LLM invocation (only if cache miss)
3. Cache attributes include `scope` + `router_model`:
   - default user token: `scope=global`
   - non-default token: `scope=<token_id>`

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
   # Note: LANGCACHE_HOST and LANGCACHE_CACHE_ID must be set at runtime
   # (Cloud Run or env file). They are not injected by Cloud Build.
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
| `LANGCACHE_HOST` | Yes* | - | LangCache API hostname (set at runtime, not in Cloud Build) |
| `LANGCACHE_CACHE_ID` | Yes* | - | Cache ID from LangCache console (set at runtime, not in Cloud Build) |
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
Before policy change: eligible_models = ["gpt-4", "gemini-1.5-pro"]
After policy change:  eligible_models = ["gpt-4", "gpt-4-turbo"]
→ Different eligible_models_hash → Cache miss → Fresh routing decision
```

**Troubleshooting**

**Cache not initializing:**
```
Error: LANGCACHE_HOST environment variable is required
```
→ Set all required environment variables (`LANGCACHE_HOST`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY`)
  in your runtime environment (Cloud Run or local .env), not Cloud Build.

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

**Prompt Safety for Registry Metadata**

Model metadata is also sent to the router LLM as **informational context** for eligible models. Because descriptions can originate from admin/user registry entries, Wayfinder treats them as untrusted:
- Descriptions are transformed to `safe_description` before prompt inclusion.
- Control characters and code-fence markers are sanitized.
- Router instructions explicitly forbid following commands embedded in metadata fields.

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

ModelConfigurationError: trusted_anchor_model "gemini-1.5-pro" cannot be in denied_models
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

Models are curated and currently include OpenAI and Google (Gemini). Future versions may support additional providers and BYOM (Bring Your Own Model) for custom models.

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


## Design Principles

1. **LLM-Driven Routing** - All routing decisions originate from the router LLM, never from local heuristics
2. **Policy as Constraint** - Policy filters eligible models; it never selects or ranks them
3. **Intent as Metadata** - Intent is inferred by the LLM for logging and analysis, but MUST NOT influence routing
4. **Token-Scoped Policies** - Each token is a complete policy boundary with its own configuration
5. **Fail Fast on Invalid Configuration** - Policy violations and configuration errors are surfaced immediately
6. **Explainable Decisions** - Every routing response includes confidence scores and reasoning from the LLM
7. **Deterministic Behavior** - Given the same inputs and cached state, routing produces the same results

