# Frontend API Spec (User + Admin)

This document lists the HTTP endpoints the frontend should call, required headers, request/response bodies, and success/error behavior. All JSON responses include a `timestamp` on errors.

Base URL examples:
- Production: `https://wayfinder-prod-545829371795.us-central1.run.app`
- Local: `http://localhost:3000`

## Authentication Headers
- User session: `X-Session-Token: <session_token>`
- API token: `X-Wayfinder-Token: <token>`
- Admin API key: `X-Admin-Api-Key: <admin_api_key>`

Notes:
- User/session endpoints are only available when `FEATURE_FLAGS_USER_SELF_SERVICE=true`.
- Admin endpoints require `X-Admin-Api-Key` or a session elevated to admin.

---

## Health

### GET /health
No auth required.

Response (200):
```json
{
  "status": "healthy",
  "timestamp": "...",
  "redis_connected": true,
  "langcache_enabled": true,
  "langcache_connected": true,
  "langcache_last_error": "...",
  "langcache_last_error_at": "...",
  "langcache_last_success_at": "..."
}
```

### GET /llm-spec
No auth required.

Purpose:
- Machine-readable integration guide for LLM app builders.
- Includes auth headers, core/admin endpoint summaries, routing contract, and recommended implementation patterns.

Response (200):
```json
{
  "name": "Wayfinder LLM Integration Spec",
  "version": "1.0",
  "auth_headers": [
    { "header": "X-Wayfinder-Token", "used_for": ["/route", "/feedback"] }
  ],
  "core_endpoints": [
    { "method": "POST", "path": "/route", "auth": "token", "purpose": "Get model routing decision for a prompt" }
  ],
  "admin_endpoints": [
    { "method": "PUT", "path": "/admin/default-token-profile", "auth": "admin", "purpose": "Update default-token model set" }
  ],
  "integration_patterns": [
    { "name": "Chat Orchestrator", "why": "...", "implementation": ["..."] }
  ]
}
```

### GET /llms.txt
No auth required.

Purpose:
- Plain-text/LLM-friendly rendering of the same `/llm-spec` content.
- Best URL to hand directly to a coding assistant for integration guidance.

---

## User Registration & Login
(Requires user self‑service enabled)

### POST /api/users/register
Email-only registration. Sends a verification link.

Request:
```json
{ "email": "user@example.com" }
```
Response (200):
```json
{ "message": "If an account exists, a verification email has been sent." }
```
Notes:
- In non-production, the API may include `verification_token` for local testing.

### POST /api/users/verify-email
Validate an email verification token (non-consuming).

Request:
```json
{ "token": "..." }
```
Response (200):
```json
{ "valid": true, "email": "user@example.com" }
```

### POST /api/users/complete-registration
Consume verification token and set password.

Request:
```json
{ "token": "...", "password": "Testpass1" }
```
Response (201):
```json
{
  "user": { "id": "...", "email": "...", "tier": "free", "status": "active" },
  "token": { "id": "...", "token": "...", "name": "Default Token" }
}
```

### POST /api/users/login
Request:
```json
{ "email": "user@example.com", "password": "Testpass1" }
```
Response (200):
```json
{
  "user": { "id": "...", "email": "...", "tier": "free", "status": "active" },
  "tokens": [
    {
      "id": "...",
      "name": "...",
      "eligible_models": ["gpt-4-turbo", "gemini-2.5-flash"],
      "metrics": { "route_requests": 0, "cache_hits": 0, "throttled_requests": 0 }
    }
  ]
}
```
If the email is not verified yet, the API returns `403` with `Email not verified`.

---

## Sessions (Frontend Login)
(Requires user self‑service enabled)

### POST /api/sessions/login
Authenticate a user and create a session.

**Body**
```json
{ "email": "user@example.com", "password": "Testpass1" }
```

**Response**
```json
{
  "session_token": "uuid-v4",
  "session": { "id": "...", "is_admin": false, "expires_at": "..." },
  "user": { "id": "...", "email": "...", "tier": "free" },
  "tokens": [
    {
      "id": "...",
      "name": "...",
      "eligible_models": ["gpt-4-turbo", "gemini-2.5-flash"],
      "metrics": { "route_requests": 0, "cache_hits": 0, "throttled_requests": 0 }
    }
  ]
}
```
Note: this fails with `403` until the email is verified.
Default-token note: any default token returned here has `eligible_models` resolved from the current system default-token profile.

### POST /api/sessions/validate
Headers: `X-Session-Token`
Response (200):
```json
{
  "session": { "id": "...", "is_admin": false, "expires_at": "..." },
  "user": { "id": "...", "email": "...", "tier": "free" },
  "tokens": [
    {
      "id": "...",
      "name": "...",
      "eligible_models": ["gpt-4-turbo", "gemini-2.5-flash"],
      "metrics": { "route_requests": 0, "cache_hits": 0, "throttled_requests": 0 }
    }
  ]
}
```
Default-token note: any default token returned here has `eligible_models` resolved from the current system default-token profile.

### POST /api/sessions/logout
Headers: `X-Session-Token`

### POST /api/sessions/elevate
Headers: `X-Session-Token`

Request:
```json
{ "admin_api_key": "..." }
```
Response (200):
```json
{ "session_token": "...", "session": { "id": "...", "is_admin": true } }
```
Note: elevation returns a NEW session token; clients must switch to it.

---

## Forgot Password
(Requires user self‑service enabled)

### POST /api/users/password/forgot
Request:
```json
{ "email": "user@example.com" }
```
Response (200):
```json
{ "message": "If an account exists, a reset link has been sent." }
```
Notes:
- In non-production, the API may include `reset_token` for local testing.

### POST /api/users/password/validate
Request:
```json
{ "token": "..." }
```
Response (200):
```json
{ "valid": true, "email": "user@example.com" }
```

### POST /api/users/password/reset
Request:
```json
{ "token": "...", "password": "Newpass1" }
```
Response (200):
```json
{ "message": "Password updated." }
```

---

## User Profile
(Requires user self‑service enabled)

### GET /api/users/me
Headers: `X-Session-Token`

### PATCH /api/users/me
Headers: `X-Session-Token`
Request:
```json
{ "email": "new@example.com" }
```

---

## User Tokens
(Requires user self‑service enabled)

### GET /api/tokens
Headers: `X-Session-Token`
Response (200):
```json
{
  "tokens": [
    {
      "id": "...",
      "name": "...",
      "environment": "dev",
      "eligible_models": ["gpt-4-turbo", "gemini-2.5-flash"],
      "created_at": "...",
      "updated_at": "...",
      "rotated_at": "...",
      "metrics": { "route_requests": 0, "cache_hits": 0, "throttled_requests": 0 }
    }
  ],
  "count": 1
}
```
Notes:
- `eligible_models` is always returned.
- For **default tokens**, `eligible_models` is resolved from the system default-token profile (admin-managed), not from token-local config.
- For non-default tokens, `eligible_models` reflects the token configuration.

### POST /api/tokens
Headers: `X-Session-Token`
Request:
```json
{ "name": "My Token", "eligible_models": ["gpt-4-turbo"], "environment": "dev" }
```
Validation note:
- `eligible_models` is validated against the effective model registry.
- If omitted/empty, backend defaults to all available registry models.
- This endpoint creates non-default tokens. The system default token model list is controlled separately by admin via `/admin/default-token-profile`.
- On invalid model IDs, API returns `400` with `error` like `InvalidModelError` and a detailed `message`.

### POST /api/tokens/:token_id/route
Headers: `X-Session-Token`

Purpose:
- Route from frontend Route Playground without requiring token secret access in browser state.
- Uses selected `token_id` + authenticated user session.

Request body:
```json
{
  "prompt": "Summarize this customer support thread and propose a response",
  "prefer_model": "gpt-4o-mini",
  "router_model": "consensus"
}
```

Behavior:
- Validates session token.
- Validates selected token exists and belongs to session user.
- Applies same routing logic as `POST /route`:
  - policy/eligibility checks
  - router selection/fallback
  - cache lookup/store behavior
  - rate limiting and tier quotas
  - token usage metrics attribution

Success response:
- Same schema as `POST /route` (`primary`, `alternate`, `request_id`, `router_model_used`, `from_cache`).

Errors:
- `401` missing/invalid/expired session
- `403` token not usable for this session
- `404` token not found
- `422` invalid route payload
- `429` rate limited

### DELETE /api/tokens/:id
Headers: `X-Session-Token`
Response (403):
```json
{
  "error": "Forbidden",
  "code": "TOKEN_005",
  "message": "Cannot delete the last remaining token"
}
```

### POST /api/tokens/:id/rotate
Headers: `X-Session-Token`

---

## Routing + Feedback

### POST /route
Headers: `X-Wayfinder-Token`
Request:
```json
{ "prompt": "...", "router_model": "consensus" }
```
Response (200/203):
```json
{
  "primary": { "model": "...", "score": 0.9, "reason": "..." },
  "alternate": { "model": "...", "score": 0.7, "reason": "..." },
  "request_id": "...",
  "router_model_used": "consensus",
  "from_cache": false
}
```

### POST /feedback
Headers: `X-Wayfinder-Token`
Request:
```json
{ "request_id": "...", "selected_model": "gpt-4-turbo", "intent_label": "coding", "rating": "positive" }
```

---

## Admin: Tokens

### GET /admin/tokens
Headers: `X-Admin-Api-Key`
Notes:
- Includes `eligible_models` for every token.
- For default tokens, `eligible_models` is resolved from the current default-token profile.

### POST /admin/tokens
Headers: `X-Admin-Api-Key`
Request:
```json
{ "eligible_models": ["gpt-4-turbo"], "environment": "dev" }
```

### GET /admin/tokens/:id
Headers: `X-Admin-Api-Key`
Note:
- For default tokens, `eligible_models` is resolved from the current default-token profile.

### PATCH /admin/tokens/:id
Headers: `X-Admin-Api-Key`

### POST /admin/tokens/:id/rotate
Headers: `X-Admin-Api-Key`

### DELETE /admin/tokens/:id
Headers: `X-Admin-Api-Key`

---

## Admin: Users
(Available only when user self‑service enabled)

### GET /admin/users
Headers: `X-Admin-Api-Key`

### PATCH /admin/users/:id/status
Headers: `X-Admin-Api-Key`
Request:
```json
{ "status": "active|pending|suspended|deleted" }
```

### PATCH /admin/users/:id/tier
Headers: `X-Admin-Api-Key`
Request:
```json
{ "tier": "free|paid_system|paid_byollm|admin" }
```

---

## Admin: Knowledge

### GET /admin/knowledge/stats
Headers: `X-Admin-Api-Key`
Query params:
- `scope=global|token` (optional)
- `token_id=...` (optional)

### POST /admin/knowledge/decay
Headers: `X-Admin-Api-Key`
Response (410): deprecated

---

## Admin: Models

### GET /admin/models
Headers: `X-Admin-Api-Key`
Response (200):
```json
{ "models": [ { "id": "...", "provider": "..." } ], "count": 10, "default": "..." }
```

---

## Model Registry (User + Admin)

### Core Model Shape
Registry APIs return rich model entries (provider data can be sparse):
```json
{
  "id": "gpt-4o-mini",
  "provider": "openai",
  "cost_tier": "low",
  "speed_tier": "fast",
  "context_window": 128000,
  "max_output_tokens": 16384,
  "available": true,
  "status": "active",
  "global_eligible": true,
  "display_name": "GPT-4o mini",
  "description": "...",
  "capabilities": ["chat", "tool_use"],
  "cost": { "input_per_1k": 0.00015, "output_per_1k": 0.0006, "currency": "USD", "source": "provider" },
  "performance": { "quality_tier": "medium", "latency_tier": "fast", "strengths": ["low_cost"] },
  "capability_flags": { "tool_use": true, "vision": true, "audio": false, "json_mode": true },
  "metadata_confidence": { "cost": "high", "performance": "medium", "capabilities": "high" },
  "source": "system_base",
  "updated_at": "..."
}
```

### User Registry Endpoints (`/api/registry`)
Headers: `X-Session-Token` (or `X-Wayfinder-Token` for authenticated user routes)

#### GET /api/registry
Returns effective user registry (system + user overlays, depending on mode).
```json
{
  "registry_mode": "augment",
  "models": [{ "id": "gpt-4o-mini", "provider": "openai", "cost_tier": "low", "speed_tier": "fast", "context_window": 128000, "available": true, "status": "active", "global_eligible": true }],
  "count": 42,
  "timestamp": "..."
}
```

#### POST /api/registry/mode
Request:
```json
{ "mode": "augment" }
```
`mode` is `augment | override`.

Response:
```json
{ "registry_mode": "augment", "timestamp": "..." }
```

#### POST /api/registry
Create/update user model overlay.
Request: model patch with required `id`.

Response:
```json
{ "model": { "id": "custom-model", "provider": "custom", "cost_tier": "low", "speed_tier": "fast", "context_window": 16000, "available": true, "status": "active", "global_eligible": true }, "timestamp": "..." }
```

#### PATCH /api/registry/:id
Patch user overlay metadata for an existing model id.

Response:
```json
{ "model": { "id": "gpt-4o-mini", "description": "User override ..." }, "timestamp": "..." }
```

#### DELETE /api/registry/:id
Response: `204 No Content`

### Admin Registry Endpoints (`/admin/registry`)
Headers: `X-Admin-Api-Key` (or elevated `X-Session-Token`)

#### GET /admin/registry
```json
{ "models": [ { "id": "...", "provider": "..." } ], "count": 42, "default": "gpt-4o-mini" }
```
Use this as the canonical admin view for all registry models and metadata.

#### POST /admin/registry
Create system curated override (`id` required).
This creates or updates a system-level model entry/override.

Request:
```json
{
  "id": "gpt-4o-mini",
  "display_name": "GPT-4o mini",
  "description": "Fast and low-cost default candidate",
  "cost_tier": "low",
  "speed_tier": "fast",
  "context_window": 128000,
  "available": true,
  "status": "active",
  "global_eligible": true
}
```
Response (201):
```json
{
  "model": {
    "id": "gpt-4o-mini",
    "provider": "openai",
    "cost_tier": "low",
    "speed_tier": "fast",
    "context_window": 128000,
    "available": true,
    "status": "active",
    "global_eligible": true
  },
  "timestamp": "..."
}
```

#### PATCH /admin/registry/:id
Patch system curated override.
Use for partial metadata updates.

Request:
```json
{
  "description": "Updated copy for admin catalog UI",
  "speed_tier": "medium"
}
```
Response (200):
```json
{
  "model": {
    "id": "gpt-4o-mini",
    "description": "Updated copy for admin catalog UI",
    "speed_tier": "medium"
  },
  "timestamp": "..."
}
```

#### DELETE /admin/registry/:id
Response: `204 No Content`
Removes the system curated override entry.

#### POST /admin/registry/refresh
Triggers provider catalog sync and import into system registry.

Success (200):
```json
{
  "started_at": "...",
  "completed_at": "...",
  "imported_total": 57,
  "providers": [
    { "provider": "openai", "imported": 23, "total_fetched": 25 },
    { "provider": "gemini", "imported": 34, "total_fetched": 34 }
  ],
  "configured_providers": ["openai", "gemini"],
  "timestamp": "..."
}
```

### Admin Default Token Eligible Models (`/admin/default-token-profile`)
Headers: `X-Admin-Api-Key` (or elevated `X-Session-Token`)

This is the system-wide source of truth for default-token `eligible_models`.
All default tokens resolve from this profile.

#### GET /admin/default-token-profile
Response (200):
```json
{
  "profile": {
    "model_ids": ["gpt-4o-mini", "gemini-2.5-flash"],
    "version": 3,
    "updated_at": "...",
    "updated_by": "..."
  },
  "effective_model_ids": ["gpt-4o-mini", "gemini-2.5-flash"],
  "missing_model_ids": [],
  "cache_scope": "global:v3",
  "recommended_model_ids": ["gpt-4o-mini", "gemini-2.5-flash"],
  "timestamp": "..."
}
```
Field meanings:
- `profile.model_ids`: configured target list.
- `effective_model_ids`: usable list after filtering against currently available models.
- `missing_model_ids`: configured IDs not currently available.
- `cache_scope`: versioned default-token cache scope used by routing.
- `recommended_model_ids`: backend recommendation (compact provider-diverse defaults).

#### PUT /admin/default-token-profile
Request:
```json
{
  "model_ids": ["gpt-4o-mini", "gemini-2.5-flash"]
}
```
Validation:
- model must exist
- model must be active
- model must be `global_eligible`

Response (200):
```json
{
  "profile": {
    "model_ids": ["gpt-4o-mini", "gemini-2.5-flash"],
    "version": 4,
    "updated_at": "...",
    "updated_by": "..."
  },
  "effective_model_ids": ["gpt-4o-mini", "gemini-2.5-flash"],
  "missing_model_ids": [],
  "cache_scope": "global:v4",
  "cache_flush_recommended": true,
  "cache_flush_hint": "Default-token cache scope advanced. Clear global cache if you want immediate cleanup of stale entries from previous profile versions.",
  "timestamp": "..."
}
```
Notes:
- Updating this profile changes default-token model selection globally.
- Backend recommends (but does not force) cache clear after profile changes.
- This is the admin control the frontend should use to manage default-token `eligible_models`.

Suggested admin UX sequence:
1. Load `GET /admin/default-token-profile`.
2. Load candidate models from `GET /admin/registry` (or `GET /admin/models`).
3. Show current `profile.model_ids`, `effective_model_ids`, and `missing_model_ids`.
4. Save updates with `PUT /admin/default-token-profile`.
5. Surface `cache_scope`, `cache_flush_recommended`, and `cache_flush_hint` after save.

No providers configured (503):
```json
{
  "error": "ServiceUnavailable",
  "message": "No model catalog providers configured for registry refresh",
  "timestamp": "..."
}
```

### Realtime Token `eligible_models` Validation (Frontend)
Use `GET /api/registry` as the realtime source of truth.

Recommended flow:
1. Load registry once on token-create page.
2. Build a local `Map<modelId, model>`.
3. As user types/adds model IDs, validate:
   - exists in map
   - `status !== "disabled"`
   - `available === true`
4. Show immediate valid/invalid state and suggestions (by id/display_name/provider).
5. Submit with `POST /api/tokens`; treat backend validation as final authority.

Admin UI (default-token profile editor):
1. Load `GET /admin/default-token-profile` for current configured/effective IDs.
2. Load registry source via `GET /admin/registry` (or `GET /admin/models`) for model pickers and metadata.
3. Validate selected IDs client-side before submit.
4. Save with `PUT /admin/default-token-profile`.
5. Show returned `cache_scope`, `cache_flush_recommended`, and `cache_flush_hint`.

Important:
- There is currently no separate `POST /api/registry/validate` endpoint.
- `GET /api/tokens` and session token payloads include `eligible_models`; default-token values come from `/admin/default-token-profile`.

---

## Admin: Cache
(Only when LangCache is enabled)

### GET /admin/cache/stats
Headers: `X-Admin-Api-Key`

### POST /admin/cache/clear
Headers: `X-Admin-Api-Key`
Request (optional):
```json
{ "token_id": "..." }
```

---

## Anonymous Session (optional)
(Requires user self‑service enabled)

### POST /api/anonymous/session
Response (201):
```json
{ "session_id": "...", "token": "...", "expires_at": "..." }
```

### POST /api/anonymous/convert
Headers: `X-Wayfinder-Token`
Request:
```json
{ "email": "...", "password": "..." }
```
