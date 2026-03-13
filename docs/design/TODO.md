# TODO — Production Readiness Plan

## Completed
- [x] Rebuild model registry with user overlays, refresh, and validation.
- [x] Include registry metadata in router prompt (with prompt-size controls).
- [x] Update README/doc structure for current behavior.
- [x] Update REQUIREMENTS.md with implemented features (excluding anonymous sessions).

---

## 1) Router Provider Compatibility + Reliability Hardening (Layered Strategy)
**Goal:** Make router model/provider changes safe (OpenAI/Gemini now; Anthropic/xAI later) and avoid runtime outages from request-shape drift.

### Problem this solves
- Provider/model API contracts drift (`max_tokens` vs `max_completion_tokens`, JSON-mode changes, etc.).
- A single env flip (e.g., router model change) can break routing instantly.
- Fallback is not enough if all providers fail simultaneously.

### Design (Layered)

#### Layer A: Provider Capability Adapter
- Introduce provider/model capability profiles used at request build time.
- Internal routing request stays stable; adapter translates to provider-specific payload.
- Initial capability surface:
  - token param style: `max_tokens` vs `max_completion_tokens`
  - JSON mode support type
  - response schema support (`responseSchema`, etc.)
  - tool/strict mode flags (future-ready)
- Source of capabilities:
  - static defaults in code
  - optional runtime overrides from provider preflight results

#### Layer B: Startup Preflight Validation
- Add router preflight service executed at startup for each enabled provider/model pair.
- Run a minimal probe prompt and verify:
  - API call success
  - parseable JSON decision
  - latency under configured threshold
- Persist provider/model health snapshot in Redis + memory cache.
- Modes:
  - `strict` (prod default): fail startup if no provider/model pair is healthy
  - `warn` (dev): log and continue with degraded mode
  - `off`: skip preflight

#### Layer C: Runtime Compatibility Retry
- Add targeted one-shot compatibility retries on known provider contract errors.
- Example:
  - If OpenAI returns unsupported `max_tokens`, retry once with `max_completion_tokens`.
- Guardrails:
  - max one compatibility retry per provider request
  - no unbounded retries
  - log retry reason + outcome

#### Layer D: Circuit Breaker per Provider/Model
- Sliding-window error tracking by provider+model.
- States:
  - `closed`: normal traffic
  - `open`: short-circuit requests for cool-down period
  - `half_open`: allow probe request to recover
- Error classes feeding breaker:
  - request-shape errors
  - repeated timeouts
  - parse failures

#### Layer E: Health and Admin Visibility
- Extend `/health` with router provider/model health summary.
- Add admin endpoint(s) for explicit validation and inspection:
  - `GET /admin/router/providers` (health and last errors)
  - `POST /admin/router/validate` (run preflight now)
- Include:
  - configured model
  - health state
  - last success/error timestamp
  - error sample (sanitized)

#### Layer F: Safe Model-Change Workflow
- Operational runbook:
  1. Set candidate model env vars in dev/staging.
  2. Run `/admin/router/validate`.
  3. Promote only on pass.
  4. Monitor post-deploy provider health dashboard.
- Do not rely on deploy-only env changes without preflight.

#### Layer G: Fast Consensus Mode
- Add optional fast consensus mode for latency-sensitive routes:
  - Return the first successful provider result immediately.
  - Continue running secondary provider(s) asynchronously for telemetry/quality analysis.
  - Record async outcomes (agreement/disagreement, latency, errors) without blocking HTTP response.
- Keep current full-wait consensus mode available for strict quality paths.

### Proposed config
- `ROUTER_PREFLIGHT_MODE=strict|warn|off` (default: `strict` in production, `warn` in non-prod)
- `ROUTER_PREFLIGHT_TIMEOUT_MS` (default 10000)
- `ROUTER_CIRCUIT_BREAKER_ERROR_THRESHOLD` (default 5)
- `ROUTER_CIRCUIT_BREAKER_WINDOW_MS` (default 60000)
- `ROUTER_CIRCUIT_BREAKER_OPEN_MS` (default 30000)
- `ROUTER_CONSENSUS_MODE=full|fast` (default: `full`)

### Files to change
- `src/routing/router-llm/providers/*-client.ts` (adapter + compatibility retry hooks)
- `src/routing/router-llm/multi-provider-router-llm.ts` (breaker + health-aware selection)
- `src/routing/config.ts` (new router reliability config)
- `src/app.ts` (startup preflight, `/health` additions, admin route mount)
- `src/observability/*` (provider/model health and retry metrics)
- `docs/api-reference.md` + `docs/observability/*` + runbook docs

### Tests required
- Unit:
  - OpenAI compatibility retry path (`max_tokens` -> `max_completion_tokens`)
  - breaker state transitions (`closed/open/half_open`)
  - preflight mode behavior (`strict/warn/off`)
- Integration:
  - startup fails in strict mode when all providers unhealthy
  - startup succeeds with at least one healthy provider
  - `/health` shows provider/model health payload
  - admin validate endpoint returns expected per-provider results

### Acceptance criteria
- Changing router model via env does not cause immediate 500s from request-shape mismatch.
- At least one healthy provider is always enforced in strict mode before serving traffic.
- Provider/model health visible via `/health` and admin endpoint.
- Routing success rate > 99% (excluding downstream provider outages).

### Execution Plan (PR-by-PR)
- [x] **PR1: Config + contracts + adapter scaffolding (no behavior change)**
  - Add reliability config contract/env parsing:
    - `ROUTER_PREFLIGHT_MODE`
    - `ROUTER_PREFLIGHT_TIMEOUT_MS`
    - `ROUTER_CIRCUIT_BREAKER_ERROR_THRESHOLD`
    - `ROUTER_CIRCUIT_BREAKER_WINDOW_MS`
    - `ROUTER_CIRCUIT_BREAKER_OPEN_MS`
    - `ROUTER_CONSENSUS_MODE`
  - Add provider capability contract/types and default capability profiles.
  - Add adapter skeleton that can translate a normalized request into provider payload options.
  - Add provider-health types/store scaffolding (in-memory + Redis interface contract only).
  - Update tests for new config fields and defaults.
  - Gate: build + existing routing tests pass.
- [x] **PR2: Provider adapter integration + compatibility retry**
  - Wire OpenAI/Gemini clients through adapter request-building.
  - Add one-shot compatibility retry for known contract errors.
  - Add unit tests for retry transformation paths.
  - Gate: provider client tests pass + no behavior regressions.
- [x] **PR3: Circuit breaker runtime integration**
  - Add provider/model sliding-window failure tracking.
  - Add `closed/open/half_open` gating in multi-provider invocation path.
  - Add state-transition tests and failure-recovery tests.
  - Gate: integration tests show fallback without hammering broken providers.
- [x] **PR4: Startup preflight + startup policy**
  - Add startup preflight service and apply mode semantics (`strict|warn|off`).
  - Persist and expose preflight status in provider health state.
  - Add startup tests for fail/pass behavior by mode.
  - Gate: strict mode blocks startup when all providers are unhealthy.
- [x] **PR5: Health/admin diagnostics + observability**
  - Extend `/health` with router provider/model summary.
  - Add admin endpoints: `GET /admin/router/providers`, `POST /admin/router/validate`.
  - Add metrics/events for compatibility retries, breaker transitions, preflight outcomes.
  - Gate: endpoint coverage tests + metrics emission validation.
- [ ] **PR6: Rollout/runbook + fast-consensus enablement**
  - Add operational runbook for model changes using validate-before-promote.
  - Add `ROUTER_CONSENSUS_MODE=fast` runtime path with async secondary telemetry.
  - Add benchmarks and guardrails for latency-sensitive routes.
  - Gate: documented release playbook and target latency validation in staging.
  - Status: runbook + fast mode implemented; latency benchmark harness still pending.

---

## 2) Production Monitoring for Routing
**Goal:** Detect routing failures and provider degradation quickly.

**Proposed changes:**
- Alert on provider timeout rate, parse failure rate, and full-routing-failure rate.
- Emit metrics by provider/model + error type.
- Dashboard slices:
  - success rate by provider/model
  - P50/P95/P99 latency by provider/model
  - cache hit ratio + fallback ratio

**Files to change:**
- `src/observability/metrics.ts`
- `docs/observability/observability-design.md`

**Acceptance criteria:**
- Cloud Monitoring alerts fire at configured thresholds.
- Dashboard supports root-cause triage in <10 minutes.

---

## 3) Reassess Anonymous Sessions (Removal)
**Goal:** Remove anonymous session functionality to simplify auth and policy.

**Proposed changes:**
- Remove `/api/anonymous/session` and `/api/anonymous/convert` routes.
- Remove anonymous session store and anonymous token conversion paths.
- Update docs and tests to eliminate anonymous-session flows.
- Require explicit registration + verification for upgrade path.

**Files to change:**
- `src/users/anonymous/routes.ts` (remove)
- `src/app.ts` (do not mount anonymous routes)
- `docs/frontend-api-spec.md`, `docs/api-reference.md`, `README.md`
- `test/users/*` and any anonymous-route tests

**Acceptance criteria:**
- No anonymous endpoints exposed.
- No anonymous session code paths remain.
- Test suite passes without anonymous-session fixtures.

---

## 4) BYOLLM Router Models (User/Token Scoped) — Design Only
**Goal:** Allow users to configure their own router LLM models (powered by BYOLLM keys), with per-provider replacement of system router usage (not supplementation), and apply config at user or token scope with deterministic precedence.

### Current implementation review (gaps to close)
- BYOLLM currently switches credentials only; model IDs still come from system env (`ROUTER_LLM_OPENAI_MODEL`, `ROUTER_LLM_GEMINI_MODEL`).
- Supported BYOLLM providers are currently limited to `openai|gemini` in type/schema validation.
- Routing preference is provider-level only (`openai|gemini|consensus`), not specific-model-level.
- No persisted user-scoped or token-scoped router-model configuration exists.
- No API exists for users to enable/disable system router models per user.

### Requirements mapped to implementation behavior
1. Arbitrary number of router models per user/token.
2. User/token models can replace system router models (no provider-level supplementation).
3. Precedence: token-scoped config > user-scoped config > system config.
4. Default behavior unchanged: if no token/user router config exists, system router config is used.
5. Users can add router models only after API key exists for the provider.
6. Users can add only models from providers they have active keys for.
7. After at least one user-defined router model exists, users can enable/disable any router model (including remaining system-backed providers) for that user only.

### Proposed architecture

#### A) Router model entities (normalized)
- Introduce `RouterModelEntry`:
  - `id` (UUID)
  - `scope`: `system|user|token`
  - `owner_user_id` (nullable)
  - `token_id` (nullable)
  - `provider`: `openai|gemini|anthropic|xai` (extensible)
  - `model_id`: provider-native model string
  - `credential_source`: `system|user` (system keys vs BYOLLM key)
  - `enabled`: boolean
  - `priority`: integer (stable ordering for deterministic selection)
  - `validation_status`: `valid|invalid|unknown`
  - `validation_error` (nullable)
  - `created_at`, `updated_at`

#### B) Scope profile behavior
- For `user` and `token` scopes, define profile mode:
  - `inherit` (default): use parent scope as-is
  - `augment`: parent + local entries/toggles
  - `replace`: ignore parent and use local entries only
- Resolution chain:
  1. Start with system scope entries.
  2. Apply user profile mode and entries.
  3. Apply token profile mode and entries.
- This preserves precedence while supporting replacement behavior.

#### B.1) Provider-level replacement semantics (revised)
- BYOLLM replacement is enforced **per provider**.
- If a user has an active BYOLLM key for provider `P`:
  - Wayfinder MUST use the user's key for router LLM calls to provider `P`.
  - Wayfinder MUST NOT use the system key for provider `P` for that user.
  - System router model entries for provider `P` are excluded from that user's effective router model set.
- Providers without a user key remain system-backed for that user.
- This allows mixed operation across providers, but never mixed credential sources for the same provider.

#### B.2) Effective model resolution with provider ownership filtering
- Effective router-model resolution adds an ownership filter before normal scope merge:
  1. Determine providers with active BYOLLM keys for the user.
  2. Exclude system-backed entries for those providers.
  3. Keep system-backed entries for providers without user keys.
  4. Apply user scope profile (`inherit|augment|replace`).
  5. Apply token scope profile (`inherit|augment|replace`).
- Token/user scopes can still disable providers/models, but cannot “re-add” system-backed models for a provider they own via BYOLLM.

#### C) Runtime resolution and routing behavior
- Resolve effective router model set once per request in routing engine:
  - Inputs: token_id, user_id (if present), authenticated user tier, BYOLLM keys.
  - Output: ordered `effective_router_models[]` with model/provider/credential source.
- Provider/model dispatch:
  - Build provider clients using credential source:
    - `system` -> existing system API key envs
    - `user` -> decrypted BYOLLM key for same provider
  - Each enabled model is an invocation candidate.
  - For a provider with a user key, all invocations for that provider use the user credential path only.
- Consensus behavior:
  - If effective set has >1 models: run multi-model consensus aggregation.
  - If effective set has 1 model: run single-model route decision.
- Guardrails:
  - Reject configuration updates that would leave effective enabled set empty.
  - On BYOLLM key deletion/deactivation, mark dependent user entries invalid/disabled.

### Storage design (Redis, not in-memory)
- Add Redis-backed `RouterModelConfigStore`.
- Suggested keys:
  - `wayfinder:router:models:system` (JSON array)
  - `wayfinder:router:models:user:{userId}` (JSON array + mode)
  - `wayfinder:router:models:token:{tokenId}` (JSON array + mode)
- Add index key for fast cleanup:
  - `wayfinder:router:token-index:user:{userId}` => set of token IDs with token-scoped router config.
- Use optimistic concurrency (`WATCH/MULTI/EXEC`) for updates to avoid lost writes.

### API surface (design)

#### User scope (session auth)
- `GET /api/router-models`
  - Returns:
    - `system_models`
    - `user_profile` (`mode`, `entries`)
    - `effective_models`
    - `available_by_provider` (model candidates user can add)
    - `provider_ownership` (e.g. `{ "openai": "user", "gemini": "system" }`)
- `PUT /api/router-models`
  - Upsert user profile (`mode`, `entries`).
  - Validates provider key ownership for any `credential_source=user` entries.
  - Rejects attempts to use `credential_source=system` for providers currently owned by the user's BYOLLM keys.
- `PATCH /api/router-models/:entry_id`
  - Merge-patch one entry (enable/disable, priority, model_id migration).
- `DELETE /api/router-models/:entry_id`
  - Remove one user entry.

#### Token scope (session auth, owner-only)
- `GET /api/tokens/:token_id/router-models`
- `PUT /api/tokens/:token_id/router-models`
- `PATCH /api/tokens/:token_id/router-models/:entry_id`
- `DELETE /api/tokens/:token_id/router-models/:entry_id`
- Same validation rules as user scope + token ownership checks.

#### Admin scope
- `GET /admin/router-models/system`
- `PUT /admin/router-models/system`
- Optional: `POST /admin/router-models/system/validate` to run capability preflight.

### Backward compatibility
- Preserve current request field `router_model` (`openai|gemini|consensus`) for existing clients.
- Preserve token field `router_model_preference` initially.
- Compatibility mapping while new model config is rolled out:
  - `openai` maps to highest-priority effective OpenAI router model (user-backed if user has OpenAI key, otherwise system-backed).
  - `gemini` maps to highest-priority effective Gemini router model (user-backed if user has Gemini key, otherwise system-backed).
  - `consensus` maps to all enabled effective models.
- Introduce new optional request override (future-ready): `router_model_id` (exact model selection) once frontend/backend adoption is ready.

### BYOLLM integration changes required
- Expand provider enum and validation framework to support `anthropic` and `xai` (and future providers).
- Maintain provider-specific key format + live validation handlers.
- Add provider capability metadata used by router adapter (json mode, max token param style, timeout limits).
- Enforce that user can only add router entries for providers with active validated keys (if `credential_source=user`).
- Enforce provider replacement semantics when a user key exists (system credentials/models for that provider are not used for that user).

### Security and abuse controls
- Never return raw API keys in any router-model endpoints.
- Validate `model_id` length/charset and sanitize user-provided metadata before prompt usage.
- Rate limit router-model config mutations.
- Audit log config changes and effective-set resolution decisions.

### Observability
- Add metrics:
  - `router_model_effective_count`
  - `router_model_resolution_ms`
  - `router_model_invocation_failures{provider,model}`
  - `router_model_config_invalid_total`
- Add structured logs for:
  - config write actions
  - resolution output (`system/user/token` source breakdown)
  - runtime fallback/disabled-path decisions

### Testing plan
- Unit:
  - scope resolution (`inherit|augment|replace`)
  - precedence correctness (token > user > system)
  - provider-key ownership validation
  - backward compatibility mapping for `router_model`
- Integration:
  - user adds BYOLLM key then adds router model successfully
  - user cannot add router model without key
  - adding OpenAI BYOLLM key causes routing to stop using system OpenAI for that user while system Gemini remains available
  - token-scoped override takes precedence over user/system
  - user disables system model for self only (other users unaffected)
  - deleting key invalidates dependent user router models

### Implementation phases
1. Add store + scope resolution engine (no route behavior change).
2. Add user/token/admin config endpoints.
3. Wire routing engine to effective model set and credential source.
4. Add backward compatibility mapping and migration guards.
5. Add frontend API docs + rollout runbook.

### Clarifications needed before implementation
- Should `paid_byollm` remain required to configure user-scoped router models, or should `paid_system` users also be allowed to configure system-only toggles?
- For token scope, should non-owner access return `403` or `404`?
- Should we allow `router_model_id` request-level override now, or defer until after initial rollout?
- When user config disables all effective router models, should write fail hard (`422`) or auto-re-enable a safe default?

---

## Redis
**Goal:** Align Redis usage with `redis-development` skill rules and close production-risk gaps.

### Rule Coverage Snapshot (`redis-development`)
- `data-key-naming`: Mostly aligned (consistent `wayfinder:*` prefixes).
- `data-incr`: Aligned for counters (`INCR` used for metrics and rate limits).
- `data-transactions`: Partially aligned (some multi-key flows still non-atomic).
- `ram-ttl`: Partially aligned (sessions/reset tokens use TTL; some keys lack retention policy).
- `conn-pooling`: Aligned (shared singleton Redis client, no per-request connect).
- `conn-pipelining`: Partially aligned (good in list/get paths; some delete/update paths still chatty).
- `conn-blocking`: Partially aligned (no direct `KEYS` usage, but monkey-patching client API is fragile).
- `conn-timeouts`: Partially aligned (minimal options configured; missing explicit connect/command timeout strategy).
- `security-auth`/`security-network`/`security-acls`: Not enforced in app-level guardrails yet (operationally configurable, but not validated).
- `observe-metrics`: Partial (app logs Redis connect/failure; no dedicated Redis health/latency/error metrics surface).
- `json-vs-hash`/`json-partial-updates`: Tradeoff accepted today (JSON strings are simple but cause read-modify-write races in some flows).

### P0 — Correctness & Security Gaps

1. [x] **`data-transactions`: Session create is not atomic across related keys**
- Files:
  - `/Users/john/wayfinder/src/sessions/store.ts:75`
  - `/Users/john/wayfinder/src/sessions/store.ts:95`
- Gap:
  - `SETEX`/`ZADD`/`EXPIRE` are separate writes; partial failure can leave inconsistent indexes.
- TODO:
  - Convert to one `MULTI/EXEC` (or Lua) transaction and validate exec results.

2. [x] **`data-transactions`: User email uniqueness is race-prone**
- Files:
  - `/Users/john/wayfinder/src/users/store.ts:235`
  - `/Users/john/wayfinder/src/users/store.ts:257`
  - `/Users/john/wayfinder/src/users/store.ts:271`
  - `/Users/john/wayfinder/src/users/store.ts:291`
- Gap:
  - `GET` uniqueness check before write transaction is not atomic under concurrency.
- TODO:
  - Use atomic uniqueness guard (`SETNX` + transaction, or Lua script).

3. [x] **`ram-ttl`: Anonymous session counter update can create immortal keys**
- Files:
  - `/Users/john/wayfinder/src/users/anonymous/store.ts:258`
  - `/Users/john/wayfinder/src/users/anonymous/store.ts:267`
- Gap:
  - Fallback plain `SET` when TTL <= 0 removes expiration.
- TODO:
  - Treat TTL<=0 as expired and fail/delete; never write this key without TTL.

4. [x] **`security-auth` + secure key hygiene: raw tokens used in rate-limit Redis keys**
- Files:
  - `/Users/john/wayfinder/src/middleware/rate-limit.ts:184`
  - `/Users/john/wayfinder/src/middleware/rate-limit.ts:229`
  - `/Users/john/wayfinder/src/middleware/rate-limit.ts:254`
- Gap:
  - Redis keys include plaintext token values.
- TODO:
  - Replace with hashed token identifiers (or token config IDs) for key generation.

### P1 — Reliability & Data Hygiene

5. [x] **`data-transactions`: standardize `MULTI/EXEC` error handling**
- Files:
  - `/Users/john/wayfinder/src/users/store.ts:261`
  - `/Users/john/wayfinder/src/users/store.ts:295`
  - `/Users/john/wayfinder/src/users/store.ts:365`
  - `/Users/john/wayfinder/src/sessions/store.ts:155`
  - `/Users/john/wayfinder/src/users/verification-store.ts:162`
  - `/Users/john/wayfinder/src/users/verification-store.ts:232`
  - `/Users/john/wayfinder/src/knowledge/store.ts:570`
- Gap:
  - Some `exec()` results are not validated per-command.
- TODO:
  - Introduce a shared `assertExecOk` helper and apply everywhere.

6. [x] **`ram-ttl`: define token metrics retention policy**
- Files:
  - `/Users/john/wayfinder/src/tokens/metrics.ts:16`
  - `/Users/john/wayfinder/src/tokens/metrics.ts:33`
  - `/Users/john/wayfinder/src/tokens/routes.ts:315`
  - `/Users/john/wayfinder/src/tokens/user-routes.ts:233`
- Gap:
  - Metrics keys have no TTL and no deletion policy.
- TODO:
  - Choose policy: keep-forever, TTL retention, or delete-on-token-delete and apply consistently.

7. [x] **`data-transactions`: token multi-key writes are partially non-atomic**
- Files:
  - `/Users/john/wayfinder/src/tokens/store.ts:300`
  - `/Users/john/wayfinder/src/tokens/store.ts:341`
  - `/Users/john/wayfinder/src/tokens/store.ts:365`
  - `/Users/john/wayfinder/src/tokens/store.ts:423`
- Gap:
  - Create/rotate/delete use separate commands for config/hash/index keys.
- TODO:
  - Group related writes in transactional units; keep existing WATCH logic for delete guard.

8. [x] **`conn-blocking`: avoid mutating shared Redis client methods**
- Files:
  - `/Users/john/wayfinder/src/knowledge/store.ts:221`
- Gap:
  - Monkey-patching `redis.keys` is global and brittle for shared clients.
- TODO:
  - Replace with static guardrails (lint/checklist/tests) instead of runtime method patching.

### P2 — Performance & Operability

9. [x] **`conn-pipelining`: batch session-user cleanup**
- Files:
  - `/Users/john/wayfinder/src/sessions/store.ts:198`
  - `/Users/john/wayfinder/src/sessions/store.ts:214`
- Gap:
  - Loop issues many sequential round trips.
- TODO:
  - Use batched pipeline (or Lua) for cleanup.

10. [x] **`conn-timeouts`: strengthen shared Redis client options**
- Files:
  - `/Users/john/wayfinder/src/redis/shared.ts:35`
- Gap:
  - Minimal options only (`maxRetriesPerRequest`, `lazyConnect`).
- TODO:
  - Add explicit timeout/reconnect strategy (`connectTimeout`, retry backoff, keepalive) and log connection lifecycle events.

11. [x] **`observe-metrics`: add Redis-specific operational telemetry**
- Files:
  - `/Users/john/wayfinder/src/redis/shared.ts:24`
  - `/Users/john/wayfinder/src/app.ts:301`
- Gap:
  - No first-class Redis metrics surfaced for alerting.
- TODO:
  - Track Redis connect failures/retries, command error rates, and pool/client counts in observability layer.

### P3 — Architecture Optimization (Optional)

12. **`json-vs-hash` / `json-partial-updates`: evaluate high-churn entity storage format**
- Files:
  - `/Users/john/wayfinder/src/users/store.ts:258`
  - `/Users/john/wayfinder/src/sessions/store.ts:128`
  - `/Users/john/wayfinder/src/tokens/store.ts:300`
- Gap:
  - JSON-string blobs force full read-modify-write for small field updates.
- TODO:
  - Assess migration candidates to Redis hashes (or RedisJSON if module guarantees exist) for partial update heavy paths.

### Keep As-Is (Aligned with skill)
- `conn-pooling`: shared Redis client reuse + explicit cleanup hook
  - `/Users/john/wayfinder/src/redis/shared.ts:24`
  - `/Users/john/wayfinder/test/setup.ts:17`
- `data-incr`: counter operations use `INCR`
  - `/Users/john/wayfinder/src/tokens/metrics.ts:35`
  - `/Users/john/wayfinder/src/middleware/tier-rate-limit.ts:54`
- `data-transactions`: good WATCH/MULTI retry patterns already used
  - `/Users/john/wayfinder/src/tokens/default-profile-store.ts:163`
  - `/Users/john/wayfinder/src/tokens/default-profile-store.ts:218`
  - `/Users/john/wayfinder/src/tokens/store.ts:459`

---

## Local Integration Testing
**Goal:** Enable full pre-PR integration validation locally with real dependencies (Redis, LangCache, LLM providers, email provider) and locally supplied secrets.

### Outcomes
- Run full local integration tests that are meaningfully close to Cloud Build behavior.
- Validate routing with real provider keys before opening PRs.
- Keep secrets out of git while still making local setup repeatable.

### Proposed Local Test Topology
- Runtime mode: local app process (`npm run dev` or `npm run build && npm start`).
- Redis: local Docker container (`redis:7`) on `localhost:6379`.
- External services: real remote APIs with user-supplied keys:
  - OpenAI/Gemini router keys
  - LangCache (`LANGCACHE_HOST`, `LANGCACHE_CACHE_ID`, `LANGCACHE_API_KEY`)
  - Postmark (`POSTMARK_API_KEY`) when testing email flows

### Secrets Supply Design
- Add two local-only env files (gitignored):
  - `.env.local.integration` (non-secret config + feature flags)
  - `.env.local.secrets` (all secrets)
- Add committed templates:
  - `.env.local.integration.example`
  - `.env.local.secrets.example` (placeholders only, no real values)
- Add to `.gitignore`:
  - `.env.local.integration`
  - `.env.local.secrets`
- Local run pattern:
  - `set -a; source .env.local.integration; source .env.local.secrets; set +a; npm test`

### Environment Profiles
1. `local-min` (fast, mostly mocked)
- No real LangCache/provider calls.
- For quick regression loops.

2. `local-full` (pre-PR gate)
- Real Redis + real provider/LangCache/API-key paths.
- Enables:
  - `FEATURE_USER_SELF_SERVICE=true`
  - `LANGCACHE_INTEGRATION_TEST=true`
  - router provider flags for real routing tests
- Runs targeted suites + smoke script + (optional) full `npm test`.

### Command Workflow (Design)
1. Start dependencies:
- `docker compose -f docker-compose.local-integration.yml up -d redis`

2. Export env:
- `set -a; source .env.local.integration; source .env.local.secrets; set +a`

3. Validate environment:
- `npm run test:security:secrets` (or equivalent secret sanity test)
- health check script ensures required env vars exist for selected profile

4. Run local-full integration:
- `npm run test:integration:local-full`
  - includes key files such as:
    - `test/integration.test.ts`
    - `test/routing-integration.test.ts`
    - `test/cache/langcache-integration.test.ts` (when enabled)
    - `test/public/mcp.test.ts`
    - user/session/auth flows

5. Optional end-to-end smoke:
- `node scripts/smoke-test.js` against `http://localhost:<port>`

### Git Worktree Support
- Keep one shared local Redis container, but isolate data per worktree using a required env prefix:
  - `WAYFINDER_REDIS_PREFIX=wayfinder:<worktree_name>:`
- If codebase lacks a global key prefix mechanism, add it as a follow-up task so parallel worktrees do not collide.

### Safety and Operational Guardrails
- Never print secret values in test logs.
- Add startup validation for required secrets in `local-full` profile.
- Fail fast with clear errors for missing keys.
- Include warning banner when running with production-like real keys locally.

### CI Parity Strategy
- Mirror Cloud Build env contract in `.env.local.integration.example` (same variable names).
- Keep one doc table mapping each cloud substitution/secret to local env variable names.
- Add explicit command in docs:
  - “Run this before opening PR” checklist command bundle.

### Deliverables (Implementation Tasks)
- [x] Add `.env.local.integration.example` and `.env.local.secrets.example`.
- [x] Add `docker-compose.local-integration.yml` (Redis service).
- [x] Add `scripts/local-full-check.sh` for env validation.
- [x] Add npm scripts:
  - `test:integration:local-full`
  - `local:deps:up`
  - `local:deps:down`
- [x] Add docs page: `docs/local-integration-testing.md` with copy/paste setup instructions.
- [x] Add pre-PR checklist in `README.md` linking local-full workflow.

### Acceptance Criteria
- Developer can clone repo, add local env files, and run full local integration path in <20 minutes.
- Full local integration tests exercise real Redis + real provider/LangCache paths.
- No secrets are committed; templates are sufficient for onboarding.
- Local pre-PR run catches issues currently discovered only in Cloud Build.
