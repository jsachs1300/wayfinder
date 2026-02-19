# Wayfinder API Reference

Canonical backend API reference for Wayfinder.

## Documentation Maintenance Policy
This file is a required source of truth.

Any API change MUST update `docs/api-reference.md` in the same PR, including:
- added/removed endpoints
- auth/header changes
- request/response schema changes
- status code changes
- feature-flag gating changes

If implementation and this document diverge, treat this as a documentation bug and fix immediately.

## Base URLs
- Production: `https://wyfndr.ai`
- Local default: `http://localhost:3000`

## Authentication Headers
- `X-Wayfinder-Token`: token auth for routing and token-auth user APIs.
- `X-Session-Token`: session auth for session endpoints and user APIs.
- `X-Admin-Api-Key`: admin auth.

Admin endpoints (`/admin/*`) accept:
- `X-Admin-Api-Key`, or
- elevated admin `X-Session-Token`.

## Response Conventions
- Content type: `application/json` (except `/llms.txt`)
- Error shape (common):

```json
{
  "error": "ValidationError",
  "message": "Invalid request body",
  "timestamp": "2026-02-19T00:00:00.000Z"
}
```

Some endpoints also include `code` and/or `details`.

## Feature Flags and Conditional Availability
- `FEATURE_USER_SELF_SERVICE=true` enables `/api/*` user/session/registry/llm-key/anonymous routes and `/admin/users` routes.
- `/api/sessions/*` require session store availability (Redis-backed). If unavailable, session routes are not mounted.
- `/admin/cache/*` are mounted only when semantic cache is enabled/initialized.
- `/admin/registry/refresh` returns `503` if no model catalog providers are configured.

---

## Public Endpoints

### GET /health
Returns service health and dependency status.

Typical fields:
- `status`
- `timestamp`
- `redis_connected`
- `langcache_enabled`
- `langcache_connected`
- optional LangCache last error/success timestamps

### GET /llm-spec
Machine-readable integration spec for LLM/coding assistants.

### GET /llms.txt
Plain-text integration spec for LLM/coding assistants.

---

## Routing and Feedback (Token Auth)

### POST /route
Auth: `X-Wayfinder-Token`

Request body:
- `prompt` (required string)
- `context` (optional object)
- `prefer_model` (optional string)
- `metadata` (optional object)
- `router_model` (optional enum: `consensus` | `openai` | `gemini`)

Success:
- `200` normal success
- `203` success with router fallback

Response fields:
- `primary` (`model`, `score`, `reason`)
- `alternate` (`model`, `score`, `reason`)
- `request_id`
- `router_model_used`
- `from_cache`

Validation:
- `400` invalid request body

Auth:
- `401` missing/invalid token

### POST /feedback
Auth: `X-Wayfinder-Token`

Request body:
- `request_id` (required)
- `selected_model` (required)
- `intent_label` (required enum):
  - `code_review`, `coding`, `legal`, `summarization`, `reasoning`, `creative`, `support`, `other`
- `rating` (optional enum): `positive` | `negative` | `neutral`
- `preferred_model` (optional)
- `metadata` (optional object)

Validation:
- `400` invalid body or invalid model references for token policy

---

## Admin Endpoints (`/admin`)

Auth: `X-Admin-Api-Key` or elevated admin session token.

### Token Management

#### POST /admin/tokens
Creates an admin-managed token.

#### GET /admin/tokens
Lists all tokens.

Response tokens include metrics:
- `route_requests`
- `cache_hits`
- `throttled_requests`

#### GET /admin/tokens/:id
Returns token configuration and metrics.

#### PATCH /admin/tokens/:id
Updates mutable token configuration.

#### POST /admin/tokens/:id/rotate
Rotates token secret and returns new token value.

#### DELETE /admin/tokens/:id
Deletes token.

### Knowledge

#### GET /admin/knowledge/stats
Optional query params:
- `scope=global|token`
- `token_id=<id>` (required when `scope=token`)

#### POST /admin/knowledge/decay
Deprecated endpoint; returns `410`.

### Models

#### GET /admin/models
Returns full model list, count, and default model id.

### Model Registry

#### GET /admin/registry
Returns system-effective model registry.

#### POST /admin/registry
Creates or updates a curated system model override.

#### PATCH /admin/registry/:id
Patches curated system model override metadata.

#### DELETE /admin/registry/:id
Deletes curated system model override.

#### POST /admin/registry/refresh
Triggers provider catalog sync/import.

Status behavior:
- `200` successful sync
- `503` no providers configured

### Default Token Profile

#### GET /admin/default-token-profile
Returns current default-token profile and resolved effective model ids.

#### PUT /admin/default-token-profile
Updates system-wide default-token model ids.

### User Administration (when self-service enabled)

#### GET /admin/users
Lists users.

#### PATCH /admin/users/:id/status
Updates user status (`active|pending|suspended|deleted`).

#### PATCH /admin/users/:id/tier
Updates user tier (`free|paid_system|paid_byollm|admin`).

### Cache Administration (when semantic cache enabled)

#### GET /admin/cache/stats
Returns cache metrics.

#### POST /admin/cache/clear
Clears cache.

---

## User Self-Service Endpoints (`/api/*`)

Available only when `FEATURE_USER_SELF_SERVICE=true`.

### User Registration and Login (`/api/users`)

#### POST /api/users/register
Email-only registration kickoff.

Request:
```json
{ "email": "user@example.com" }
```

Returns `200` with generic message (anti-enumeration-safe).

#### POST /api/users/verify-email
Validates verification token.

Request:
```json
{ "token": "..." }
```

#### POST /api/users/complete-registration
Consumes verification token, sets password, activates user, creates default token.

Request:
```json
{ "token": "...", "password": "..." }
```

Success: `201` with `user` and newly created token secret.

#### POST /api/users/login
Credential login (non-session endpoint).

Request:
```json
{ "email": "user@example.com", "password": "..." }
```

Success: `200` with:
- `user`
- `tokens[]` (sanitized) including per-token metrics

#### POST /api/users/password/forgot
Requests password reset link.

Request:
```json
{ "email": "user@example.com" }
```

Returns `200` with generic message.

#### POST /api/users/password/validate
Validates reset token.

Request:
```json
{ "token": "..." }
```

#### POST /api/users/password/reset
Resets password with token.

Request:
```json
{ "token": "...", "password": "..." }
```

#### GET /api/users/me
Auth: `X-Session-Token` or `X-Wayfinder-Token`

#### PATCH /api/users/me
Auth: `X-Session-Token` or `X-Wayfinder-Token`

---

### Session Endpoints (`/api/sessions`)

Mounted only when session store is available.

#### POST /api/sessions/login
Request:
```json
{ "email": "user@example.com", "password": "..." }
```

Success: `200` with:
- `session_token`
- `session`
- `user`
- `tokens[]` (includes metrics)

#### POST /api/sessions/validate
Auth: `X-Session-Token`

Success: `200` with:
- `session`
- `user`
- `tokens[]` (includes metrics)

#### POST /api/sessions/logout
Auth: `X-Session-Token`

#### POST /api/sessions/elevate
Auth: `X-Session-Token`

Request:
```json
{ "admin_api_key": "..." }
```

Success: `200` with rotated elevated `session_token` and `session`.

---

### User Token Management (`/api/tokens`)

Auth: `X-Session-Token` or `X-Wayfinder-Token`

#### GET /api/tokens
Returns user-owned tokens only.

Token fields include:
- `id`, `name`, `environment`, `eligible_models`, timestamps
- `metrics`: `{ route_requests, cache_hits, throttled_requests }`

#### POST /api/tokens
Creates a user token.

Request supports token config fields such as:
- `name`
- `eligible_models`
- `allowed_models`, `denied_models`
- `trusted_anchor_model`
- `policy_rules`
- `confidence_threshold`
- `logging_level`
- `environment`
- `knowledge_scope`
- `router_model_preference`

Notes:
- If `eligible_models` omitted, defaults are derived from the user’s effective model registry.
- Max per-user token count enforced (`MAX_TOKENS_PER_USER`).

#### DELETE /api/tokens/:id
Deletes a user-owned token.

Constraint:
- last remaining token cannot be deleted (`403`).

#### POST /api/tokens/:id/rotate
Rotates token secret and returns new secret.

> Current state: there is **no** `/api/tokens/:token_id/route` endpoint mounted in this build.
> Use `POST /route` with `X-Wayfinder-Token`.

---

### User Model Registry (`/api/registry`)

Auth: `X-Session-Token` or `X-Wayfinder-Token`

#### GET /api/registry
Returns authenticated user’s effective registry:
- `registry_mode` (`augment` | `override`)
- `models`
- `count`

#### POST /api/registry/mode
Sets registry mode.

Request:
```json
{ "mode": "augment" }
```

#### POST /api/registry
Creates/updates user overlay model metadata.

Request must include:
- `id` (string)

Response includes populated `model`.

#### PATCH /api/registry/:id
Patches user overlay metadata for model id.

#### DELETE /api/registry/:id
Deletes user overlay metadata for model id.

---

### BYOLLM Keys (`/api/llm-keys`)

Auth: `X-Session-Token` or `X-Wayfinder-Token`

Additional authorization:
- user tier must be `paid_byollm`

#### GET /api/llm-keys
Lists configured keys (metadata only; secrets never returned).

#### POST /api/llm-keys
Adds/updates key for provider.

Request:
```json
{ "provider": "openai", "api_key": "..." }
```

Supported providers:
- `openai`
- `gemini`

#### DELETE /api/llm-keys/:provider
Deletes configured key for provider.

#### POST /api/llm-keys/:provider/validate
Validates stored key against provider API.

---

### Anonymous Session Endpoints (`/api/anonymous`) (optional)

Auth requirements vary by endpoint.

#### POST /api/anonymous/session
Creates anonymous session and token.

#### POST /api/anonymous/convert
Auth: `X-Wayfinder-Token` (anonymous token)

Converts anonymous session to registered user.

---

## CORS and Exposed Headers
Common response headers include:
- `X-Request-Id`
- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset`

## Related Docs
- Frontend-oriented API contract: `docs/frontend-api-spec.md`
- Quick start: `docs/quick-start.md`
- Configuration: `docs/configuration.md`
