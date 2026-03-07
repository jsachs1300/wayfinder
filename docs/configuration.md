# Configuration

_Extracted from the previous README. This page contains env/configuration and model setup._

## User Tiers and Rate Limits

Wayfinder supports a three-tier user system when user self-service features are enabled:

### Free Tier

- **Rate Limits:** 10 requests/hour, 50 requests/day
- **Cost:** System pays LLM costs
- **Use Case:** Trial users, hobby projects

### Paid System Tier

- **Rate Limits:** 100 requests/hour, 1,000 requests/day
- **Cost:** System pays LLM costs
- **Use Case:** Production applications with moderate traffic

### Paid BYOLLM Tier

- **Rate Limits:** 1,000 requests/hour, unlimited requests/day
- **Cost:** User pays LLM costs via own OpenAI/Gemini API keys
- **Use Case:** High-volume applications, users who want full cost control
- **Features:** Can configure own OpenAI and Gemini API keys for routing

Rate limits can be customized via environment variables (see [Configuration](#configuration)).

### Bring Your Own LLM (BYOLLM)

Users on the paid BYOLLM tier can configure their own LLM API keys instead of using the system's keys. Benefits:

- **Cost Control:** Pay for LLM calls directly through your own accounts
- **Higher Limits:** 1,000 req/hr and unlimited daily requests
- **Key Isolation:** Your keys are encrypted and never shared
- **Multi-provider:** Configure both OpenAI and Gemini keys

Configured keys are encrypted at rest using AES-256-GCM and only decrypted when needed for routing.

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

#### Router LLM (Required for Production)

At least one provider must be enabled. Both can be enabled for multi-provider ranking.

| Variable | Description | Default |
|----------|-------------|---------|
| `ROUTER_LLM_OPENAI_ENABLED` | Enable OpenAI provider | `false` |
| `ROUTER_LLM_OPENAI_API_KEY` | OpenAI API key | **Required if enabled** |
| `ROUTER_LLM_OPENAI_MODEL` | OpenAI model identifier | `gpt-4o-mini` |
| `ROUTER_LLM_GEMINI_ENABLED` | Enable Gemini provider | `false` |
| `ROUTER_LLM_GEMINI_API_KEY` | Gemini API key | **Required if enabled** |
| `ROUTER_LLM_GEMINI_MODEL` | Gemini model identifier | `gemini-1.5-flash` |
| `ROUTER_LLM_TIMEOUT` | Request timeout in milliseconds | `30000` |
| `ROUTER_LLM_MAX_RETRIES` | Maximum retry attempts on failure | `2` |
| `ROUTER_LLM_TEMPERATURE` | Sampling temperature (0.0-2.0) | `0.0` |
| `ROUTER_LLM_MAX_TOKENS` | Maximum tokens in LLM response | `2000` |

#### Router Reliability and Consensus

| Variable | Description | Default |
|----------|-------------|---------|
| `ROUTER_PREFLIGHT_MODE` | Startup/provider-validation mode: `strict`, `warn`, or `off` | `strict` in production, `warn` otherwise |
| `ROUTER_PREFLIGHT_TIMEOUT_MS` | Per-provider probe timeout for startup/admin validation | `10000` |
| `ROUTER_CIRCUIT_BREAKER_ERROR_THRESHOLD` | Failures in window before opening breaker | `3` |
| `ROUTER_CIRCUIT_BREAKER_WINDOW_MS` | Sliding failure window duration | `60000` |
| `ROUTER_CIRCUIT_BREAKER_OPEN_MS` | Time breaker remains open before half-open probe | `30000` |
| `ROUTER_CONSENSUS_MODE` | `full` waits for all successful providers; `fast` returns first success and continues async telemetry | `full` |
| `ROUTER_COMPAT_RETRY_ENABLED` | Enable one-shot provider compatibility retries (`true`/`false`) | `true` |
| `ROUTER_VALIDATE_MIN_INTERVAL_MS` | Minimum interval between `POST /admin/router/validate` calls on a single instance | `30000` |

#### Model Registry Provider Sync (Optional, Recommended)

Use provider catalog sync to keep the system registry current. Sync can run at startup and/or on-demand via `POST /admin/registry/refresh`.

| Variable | Description | Default |
|----------|-------------|---------|
| `MODEL_REGISTRY_SYNC_ON_STARTUP` | Run provider sync on startup (`true`/`false`) | `true` (except `NODE_ENV=test`) |
| `GENERATE_NEW_REGISTRY` | Drop persisted registry state at startup and rebuild from defaults + provider sync | `false` |
| `MODEL_REGISTRY_SYNC_TIMEOUT_MS` | Per-provider HTTP timeout for catalog fetch | `10000` |
| `MODEL_REGISTRY_TRIM_VARIANTS` | Trim preview/media/dated catalog variants and canonicalize stable IDs | `true` |
| `MODEL_REGISTRY_OPENAI_ENABLED` | Enable/disable OpenAI model catalog provider | auto-enabled when OpenAI catalog/router key is present; set `false` to disable |
| `MODEL_REGISTRY_OPENAI_API_KEY` | OpenAI API key for catalog sync | falls back to `ROUTER_LLM_OPENAI_API_KEY` |
| `MODEL_REGISTRY_OPENAI_BASE_URL` | OpenAI API base URL override | `https://api.openai.com/v1` |
| `MODEL_REGISTRY_GEMINI_ENABLED` | Enable/disable Gemini model catalog provider | auto-enabled when Gemini catalog/router key is present; set `false` to disable |
| `MODEL_REGISTRY_GEMINI_API_KEY` | Gemini API key for catalog sync | falls back to `ROUTER_LLM_GEMINI_API_KEY` |
| `MODEL_REGISTRY_GEMINI_BASE_URL` | Gemini API base URL override | `https://generativelanguage.googleapis.com/v1beta` |
| `MODEL_REGISTRY_ANTHROPIC_ENABLED` | Enable/disable Anthropic model catalog provider | auto-enabled when API key is present; set `false` to disable |
| `MODEL_REGISTRY_ANTHROPIC_API_KEY` | Anthropic API key for catalog sync | - |
| `MODEL_REGISTRY_ANTHROPIC_BASE_URL` | Anthropic API base URL override | `https://api.anthropic.com/v1` |
| `MODEL_REGISTRY_ANTHROPIC_VERSION` | Anthropic API version header value | `2023-06-01` |
| `MODEL_REGISTRY_XAI_ENABLED` | Enable/disable xAI model catalog provider | auto-enabled when API key is present; set `false` to disable |
| `MODEL_REGISTRY_XAI_API_KEY` | xAI API key for catalog sync | - |
| `MODEL_REGISTRY_XAI_BASE_URL` | xAI API base URL override | `https://api.x.ai/v1` |
| `MODEL_REGISTRY_OLLAMA_ENABLED` | Enable Ollama local catalog provider | `false` |
| `MODEL_REGISTRY_OLLAMA_BASE_URL` | Ollama API base URL | `http://localhost:11434` |
| `MODEL_REGISTRY_OLLAMA_API_KEY` | Optional Bearer token for hosted Ollama | - |

When `MODEL_REGISTRY_TRIM_VARIANTS=true`, provider sync removes preview/experimental/media variants (for example `*-preview-*`, `*-image`, `*-tts`) and normalizes `-latest` / dated suffixes to stable canonical IDs before importing into the registry.

When `GENERATE_NEW_REGISTRY=true`, Wayfinder deletes persisted model registry state in Redis at startup and skips loading old state. This is useful when you want a fresh registry generated from startup defaults plus configured provider sync.

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

#### User Authentication & BYOLLM (Optional)

Enable user self-service features with `FEATURE_USER_SELF_SERVICE=true`.

| Variable | Description | Default |
|----------|-------------|---------|
| `FEATURE_USER_SELF_SERVICE` | Enable user registration and BYOLLM features | `false` |
| `LLM_KEY_ENCRYPTION_KEY` | **REQUIRED for BYOLLM**: 64 hex character encryption key (generate: `openssl rand -hex 32`) | - |
| `MAX_TOKENS_PER_USER` | Maximum tokens a user can create | `10` |

**Rate Limit Configuration (Per Tier)**

| Variable | Description | Default |
|----------|-------------|---------|
| `RATE_LIMIT_FREE_HOUR` | Free tier requests per hour | `10` |
| `RATE_LIMIT_FREE_DAY` | Free tier requests per day | `50` |
| `RATE_LIMIT_PAID_SYSTEM_HOUR` | Paid system tier requests per hour | `100` |
| `RATE_LIMIT_PAID_SYSTEM_DAY` | Paid system tier requests per day | `1000` |
| `RATE_LIMIT_BYOLLM_HOUR` | BYOLLM tier requests per hour | `1000` |
| `RATE_LIMIT_BYOLLM_DAY` | BYOLLM tier requests per day (`-1` = unlimited) | `-1` |

**Important:** The `LLM_KEY_ENCRYPTION_KEY` is required if BYOLLM features are enabled. Generate a secure key with:

```bash
openssl rand -hex 32
```

This produces a 64-character hexadecimal string suitable for AES-256 encryption.

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
      "models": ["gemini-1.5-pro"],
      "priority": 1
    }
  ]
}
```

This will force `gemini-1.5-pro` for all requests since all requests currently use `"other"` as the placeholder intent during policy evaluation.

**Recommended Approach:**

For now, use **global rules** instead of intent-based rules:

```json
{
  "allowed_models": ["gpt-4-turbo", "gemini-2.5-flash", "gemini-1.5-pro"],
  "denied_models": ["gpt-3.5-turbo"],
  "policy_rules": [
    {
      "type": "AllowModelsGlobal",
      "models": ["gpt-4-turbo", "gemini-1.5-pro"],
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

Wayfinder maintains a model registry that starts with curated defaults and can be refreshed from provider catalogs. **Note:** Wayfinder does not execute workload model requests itself; it provides routing decisions.

### Supported Providers

- **OpenAI** (sync supported)
- **Google Gemini** (sync supported)
- **Anthropic** (sync supported)
- **xAI** (sync supported)
- **Ollama** (sync supported)

Each model includes metadata about:
- Provider
- Cost tier (low, medium, high)
- Speed tier (fast, medium, slow)
- Context window size
- Availability status

### Default Model

The system default model is `gpt-4o-mini`, used as a fallback when no other selection criteria apply.

### Provider Sync Runbook

```bash
# 1) Verify provider env vars are configured
# 2) Trigger sync
curl -X POST http://localhost:3000/admin/registry/refresh \
  -H "X-Admin-Api-Key: your-admin-key"

# 3) Verify import results
curl http://localhost:3000/admin/registry \
  -H "X-Admin-Api-Key: your-admin-key"
```

Troubleshooting:
- `503 ServiceUnavailable`: no model catalog providers enabled/configured.
- Provider error in refresh response: check provider API key, endpoint/base URL, quota, or firewall egress.
- Partial success is expected: one provider can fail while others import successfully.

Provider catalog endpoints used:
- OpenAI: `GET /v1/models`
- Gemini: `GET /v1beta/models`
- Anthropic: `GET /v1/models`
- xAI: `GET /v1/models`

Startup behavior:
- Registry sync runs automatically at startup when provider credentials are configured.
- Override with `MODEL_REGISTRY_SYNC_ON_STARTUP=true|false`.
- In test environment (`NODE_ENV=test`), startup sync is disabled by default unless explicitly set to `true`.

## Router LLM Setup (REQUIRED)

Wayfinder requires at least one router LLM provider to make routing decisions. The system WILL FAIL to start in production mode without proper configuration.

### Supported Providers

You must enable at least one provider. Both can be enabled for multi-provider ranking.

- **OpenAI** - gpt-4o-mini (default), gpt-4-turbo, gpt-4, o1-preview
- **Gemini** - gemini-1.5-flash (default), gemini-1.5-pro

### Environment Configuration

Set these variables in your `.env` file:

```bash
# REQUIRED: Enable at least one provider
# OpenAI Provider
ROUTER_LLM_OPENAI_ENABLED=true
ROUTER_LLM_OPENAI_API_KEY=sk-your-openai-api-key
ROUTER_LLM_OPENAI_MODEL=gpt-4o-mini

# Gemini Provider
ROUTER_LLM_GEMINI_ENABLED=false
ROUTER_LLM_GEMINI_API_KEY=your-gemini-api-key
ROUTER_LLM_GEMINI_MODEL=gemini-1.5-flash

# OPTIONAL: Shared settings across all providers
# Request timeout in milliseconds (default: 30000)
ROUTER_LLM_TIMEOUT=30000

# Maximum retry attempts on failure (default: 2)
ROUTER_LLM_MAX_RETRIES=2

# Sampling temperature for LLM (default: 0.0 = deterministic)
# Range: 0.0 (deterministic) to 2.0 (creative)
ROUTER_LLM_TEMPERATURE=0.0

# Maximum tokens in LLM response (default: 2000)
ROUTER_LLM_MAX_TOKENS=2000
```

**Get API Keys:**
- OpenAI: https://platform.openai.com/api-keys
- Gemini: https://aistudio.google.com/app/apikey

### Test Mode

For development and testing, set `NODE_ENV=development` or `NODE_ENV=test` to bypass router LLM requirements.

### Quick Test

After configuration, test that your router LLM works:

```bash
# This will fail if no providers are enabled or API keys are invalid
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
