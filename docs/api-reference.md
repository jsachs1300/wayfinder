# Wayfinder API Reference

This document is the backend API reference for Wayfinder.

Base URL (production): `https://wyfndr.ai`

## Conventions
- Content type: `application/json`
- Timestamp fields are ISO-8601 UTC strings.
- Authentication headers are case-insensitive.
- Standard error shape:

```json
{
  "error": "ValidationError",
  "message": "Human-readable message",
  "timestamp": "2026-02-19T00:00:00.000Z"
}
```

## Authentication Headers
- `X-Wayfinder-Token`: token auth for routing/feedback and user-auth routes.
- `X-Session-Token`: session auth for frontend/session flows.
- `X-Admin-Api-Key`: admin auth.

Admin routes accept either:
- `X-Admin-Api-Key`, or
- an elevated admin `X-Session-Token`.

## Feature-Flagged Surface
Some endpoints are available only when `FEATURE_USER_SELF_SERVICE=true`.

---

## Public Endpoints

### GET /health
Health and dependency status.

### GET /llm-spec
Machine-readable integration spec for coding assistants.

### GET /llms.txt
Plain-text integration spec for coding assistants.

---

## Routing and Feedback

### POST /route
Auth: `X-Wayfinder-Token`

Request:
```json
{
  "prompt": "Route this request",
  "context": {},
  "prefer_model": "gpt-4o-mini",
  "metadata": {},
  "router_model": "consensus"
}
```

`router_model` allowed values:
- `consensus`
- `openai`
- `gemini`

Response (200 or 203):
```json
{
  "primary": { "model": "gpt-4o-mini", "score": 9, "reason": "..." },
  "alternate": { "model": "gemini-2.5-flash", "score": 8, "reason": "..." },
  "request_id": "uuid",
  "router_model_used": "consensus",
  "from_cache": false
}
```

### POST /feedback
Auth: `X-Wayfinder-Token`

Request:
```json
{
  "request_id": "uuid-from-route",
  "selected_model": "gpt-4o-mini",
  "intent_label": "coding",
  "rating": "positive",
  "preferred_model": "gpt-4-turbo",
  "metadata": {}
}
```

`intent_label` values:
- `code_review`, `coding`, `legal`, `summarization`, `reasoning`, `creative`, `support`, `other`

`rating` values:
- `positive`, `negative`, `neutral`

---

## Session Endpoints (`/api/sessions`) (feature-flagged)

### POST /api/sessions/login
Auth: none

Request:
```json
{ "email": "user@example.com", "password": "..." }
```

Response includes:
- `session_token`
- `session`
- `user`
- `tokens` (with token metrics)

### POST /api/sessions/validate
Auth: `X-Session-Token`

Returns current `session`, `user`, and `tokens` (with metrics).

### POST /api/sessions/logout
Auth: `X-Session-Token`

Clears session.

### POST /api/sessions/elevate
Auth: `X-Session-Token`

Request:
```json
{ "admin_api_key": "..." }
```

Returns a new elevated `session_token`.

---

## User Auth and Profile (`/api/users`) (feature-flagged)

### POST /api/users/register
Email-only registration. Sends verification email.

Request:
```json
{ "email": "user@example.com" }
```

### POST /api/users/verify-email
Validates email verification token.

Request:
```json
{ "token": "..." }
```

### POST /api/users/complete-registration
Sets password, activates user, creates default token.

Request:
```json
{ "token": "...", "password": "..." }
```

Response includes:
- `user`
- `token` (default token secret shown once)

### POST /api/users/login
Login without creating a session token (legacy/user flow).

Request:
```json
{ "email": "user@example.com", "password": "..." }
```

Response includes `user` and `tokens` (with metrics).

### POST /api/users/password/forgot
Requests password reset email.

Request:
```json
{ "email": "user@example.com" }
```

### POST /api/users/password/validate
Validates reset token.

Request:
```json
{ "token": "..." }
```

### POST /api/users/password/reset
Resets password.

Request:
```json
{ "token": "...", "password": "..." }
```

### GET /api/users/me
Auth: `X-Session-Token` or `X-Wayfinder-Token`

Returns sanitized user profile.

### PATCH /api/users/me
Auth: `X-Session-Token` or `X-Wayfinder-Token`

Updates profile fields.

---

## User Tokens (`/api/tokens`) (feature-flagged)

All endpoints require auth via `X-Session-Token` or `X-Wayfinder-Token`.

### GET /api/tokens
Lists only the authenticated user’s tokens.

Each token includes:
- `id`, `name`, `environment`, `eligible_models`, timestamps
- `metrics`: `{ route_requests, cache_hits, throttled_requests }`

### POST /api/tokens
Creates a user token.

Request body accepts token configuration fields, including:
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
- If `eligible_models` is omitted, defaults are resolved from the authenticated user’s effective registry.
- Max tokens per user enforced by `MAX_TOKENS_PER_USER`.

### DELETE /api/tokens/:id
Deletes a token owned by the user.

Notes:
- Cannot delete the last remaining token.

### POST /api/tokens/:id/rotate
Rotates token secret.

Response includes new token secret.

### POST /api/tokens/:token_id/route
Session-scoped route endpoint for frontend UX.

Auth: `X-Session-Token`

Request body same as `/route` but token is selected by `:token_id`.

Behavior:
- validates ownership/availability
- applies same routing, cache, rate limiting, and metrics attribution as `/route`

---

## User Model Registry (`/api/registry`) (feature-flagged)

All endpoints require auth via `X-Session-Token` or `X-Wayfinder-Token`.

### GET /api/registry
Returns effective registry for authenticated user:
- `registry_mode`: `augment` or `override`
- `models`
- `count`

### POST /api/registry/mode
Sets user registry composition mode.

Request:
```json
{ "mode": "augment" }
```

### POST /api/registry
Creates/updates user overlay entry.

Request is model metadata including required `id`.

Response includes populated `model`.

### PATCH /api/registry/:id
Patches user overlay metadata for model id.

### DELETE /api/registry/:id
Deletes user overlay entry.

---

## BYOLLM Keys (`/api/llm-keys`) (feature-flagged, paid_byollm tier)

All endpoints require auth via `X-Session-Token` or `X-Wayfinder-Token`.

### GET /api/llm-keys
Lists configured providers (no secrets returned).

### POST /api/llm-keys
Creates/updates encrypted provider API key.

### DELETE /api/llm-keys/:provider
Removes configured key.

### POST /api/llm-keys/:provider/validate
Validates configured key against provider.

---

## Admin Endpoints (`/admin`)

Auth: `X-Admin-Api-Key` or elevated `X-Session-Token`.

### Tokens
- `POST /admin/tokens`
- `GET /admin/tokens`
- `GET /admin/tokens/:id`
- `PATCH /admin/tokens/:id`
- `POST /admin/tokens/:id/rotate`
- `DELETE /admin/tokens/:id`

Token responses include metrics:
- `{ route_requests, cache_hits, throttled_requests }`

### Knowledge
- `GET /admin/knowledge/stats`
  - optional query params: `scope=global|token`, `token_id=<id>`
- `POST /admin/knowledge/decay` (deprecated; returns 410)

### Models
- `GET /admin/models`

### Model Registry
- `GET /admin/registry`
- `POST /admin/registry`
- `PATCH /admin/registry/:id`
- `DELETE /admin/registry/:id`
- `POST /admin/registry/refresh`

### Default Token Profile
- `GET /admin/default-token-profile`
- `PUT /admin/default-token-profile`

Use this to control system-wide default-token effective models.

### Users (feature-flagged)
- `GET /admin/users`
- `PATCH /admin/users/:id/status`
- `PATCH /admin/users/:id/tier`

### Cache
- `GET /admin/cache/stats`
- `POST /admin/cache/clear`

---

## Anonymous Endpoints (`/api/anonymous`) (optional/feature-flagged)
- `POST /api/anonymous/session`
- `POST /api/anonymous/convert`

---

## CORS and Headers
Wayfinder exposes rate-limit headers and supports frontend auth headers.

Common response headers include:
- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset`
- `X-Request-Id`

---

## Related Docs
- Frontend-oriented API spec: `docs/frontend-api-spec.md`
- Quick start: `docs/quick-start.md`
- Configuration: `docs/configuration.md`
