# BYOLLM Production Readiness Gaps

Last reviewed: 2026-03-03

## Scope
This document tracks what is already implemented for BYOLLM and what is still required before calling the feature production-ready.

## Verified Implemented
- Per-user encrypted LLM key storage exists (`InMemoryUserLLMKeyStore`, `RedisUserLLMKeyStore`).
- Encryption uses AES-256-GCM with strict key format validation (`LLM_KEY_ENCRYPTION_KEY` must be 64 hex chars).
- Startup fails fast when self-service is enabled and encryption key is missing/invalid.
- User auth/session flows exist; BYOLLM endpoints are user-authenticated and tier-gated (`paid_byollm`).
- BYOLLM key CRUD endpoints exist:
  - `GET /api/llm-keys`
  - `POST /api/llm-keys`
  - `DELETE /api/llm-keys/:provider`
  - `POST /api/llm-keys/:provider/validate`
- Live key validation endpoint exists for OpenAI/Gemini (`/validate`), and format validation is enforced on create/update.
- Provider allowlist is enforced at API/schema level (currently `openai`, `gemini`).
- BYOLLM router path exists (`BYOLLMRouterLLM`) and can invoke with user-provided keys.
- BYOLLM keys are not returned in plaintext in API responses.
- Email verification and password reset flows exist; Postmark integration exists with console-mailer fallback.
- Frontend base URL support exists for email links (`FRONTEND_BASE_URL`).

## Open Critical Gaps (Must Address)
1. Key acceptance does not require live provider validation
- Current `POST /api/llm-keys` validates key format only.
- A syntactically valid but invalid key can be stored and only fail later during routing.

2. BYOLLM provider behavior is not per-provider replacement
- Current behavior: if user has any BYOLLM keys, router uses only user-key-backed providers.
- Missing behavior for production target: per-provider replacement (example: user OpenAI key + system Gemini until user adds Gemini key).

3. No dedicated abuse controls for BYOLLM key operations
- `POST /api/llm-keys` and `POST /api/llm-keys/:provider/validate` are not behind dedicated per-user/per-endpoint rate limits.
- This leaves key validation endpoints more susceptible to abuse.

4. No BYOLLM key lifecycle audit events
- No structured audit trail for key create/update/delete/validate actions.
- Needed for incident response and compliance.

5. No provider/model compatibility enforcement for user keys during routing
- Token `eligible_models` is validated against registry/system policy, not against what the user key can actually access.
- Missing: verify selected/routed model is accessible for the active user key/provider.

6. Provider expansion framework is not yet implemented
- Current BYOLLM provider support is intentionally limited to `openai|gemini`.
- Before adding `xai` and `anthropic`, we need a provider-capability contract covering:
  - key format validation
  - live key validation endpoint behavior
  - provider-specific router client wiring
  - model compatibility checks
  - error normalization and observability fields per provider

## Open Important Gaps (Should Address)
1. Encryption key rotation strategy is undocumented/unimplemented
- No migration flow to re-encrypt stored keys when `LLM_KEY_ENCRYPTION_KEY` rotates.

2. BYOLLM usage telemetry is incomplete
- No per-user/per-provider/per-key LLM call metrics for attribution/anomaly detection.
- Existing token metrics (`route_requests`, `cache_hits`, `throttled_requests`) are not sufficient for BYOLLM operations and cost attribution.

3. Key revocation side effects are incomplete
- Key delete exists, but no explicit invalidation of dependent BYOLLM runtime state/cached capability assumptions.

4. Secret-handling hardening is incomplete
- Some store decryption error paths still use `console.error` instead of structured logging/redaction policy.
- Gemini live validation uses query-string API key; audit/log policy should explicitly ensure no key leakage.

5. Error UX normalization is partial
- Core validation errors are mapped, but provider failures during routing can still surface low-level messages.
- Missing consistent, frontend-friendly BYOLLM error taxonomy for runtime failures.

## Testing Gaps
1. End-to-end BYOLLM integration tests are not active
- Existing BYOLLM tests in `test/users/integration.test.ts` are currently skipped.

2. Missing full lifecycle contract coverage
- Needed: create key -> validate key -> route using key -> delete key -> verify fallback behavior.

3. Missing tests for target provider-replacement semantics
- Needed once per-provider replacement behavior is implemented.

## Operational Gaps
1. Production runbook for BYOLLM key incidents
- Missing explicit runbook for invalid key storms, provider outage behavior, and forced key deactivation.

2. Observability dashboards/alerts
- Missing dashboards for BYOLLM validation failures, provider-specific error rates, and abnormal BYOLLM usage spikes.

## Production Exit Criteria
- Live validation enforced (or strongly controlled) at key write time.
- Per-provider replacement semantics implemented and tested.
- Dedicated BYOLLM rate limits in place for key write/validate endpoints.
- BYOLLM key lifecycle audit logs implemented.
- Model accessibility checks enforced for routed providers/models under user keys.
- BYOLLM E2E integration tests enabled in CI (not skipped).
- Provider expansion path documented and implemented via provider-capability contract (for `xai`, `anthropic`, future providers).
