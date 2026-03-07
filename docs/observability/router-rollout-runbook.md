# Router Model Rollout Runbook

Use this runbook when changing router provider models or reliability settings.

## Goals
- Prevent request-shape regressions when switching router models.
- Validate provider health before serving production traffic.
- Control latency/cost tradeoffs with `ROUTER_CONSENSUS_MODE`.

## Pre-Change Checklist
- Confirm at least one provider key is valid for the target environment.
- Confirm `ROUTER_PREFLIGHT_MODE` is set:
  - `strict` in production (recommended)
  - `warn` in lower environments for diagnosis
- Confirm admin access is available for `POST /admin/router/validate`.

## Rollout Procedure (Validate Before Promote)
1. Deploy config/model changes to staging.
2. Run:
   - `POST /admin/router/validate`
3. Verify result:
   - `summary.passCount >= 1`
   - inspect failed providers and error messages if `failCount > 0`
4. Verify health diagnostics:
   - `GET /health` with `X-Admin-Api-Key`
   - ensure `router_provider_health` entries are healthy/expected
5. Exercise synthetic route traffic in staging (sample prompts).
6. Promote to production only after staging validation passes.
7. Immediately run production validation:
   - `POST /admin/router/validate`
8. Monitor 15-30 minutes:
   - router errors
   - circuit breaker transitions/blocks
   - preflight outcomes
   - latency and cache-hit behavior

## Consensus Mode Guidance

### `ROUTER_CONSENSUS_MODE=full`
- Waits for all successful providers and aggregates rankings.
- Best for quality consistency.
- Higher latency.

### `ROUTER_CONSENSUS_MODE=fast`
- Returns first successful provider result.
- Keeps other provider calls running asynchronously for health/telemetry updates.
- Best for latency-sensitive paths.
- Tradeoff: fewer provider rankings in immediate response.
- Explicit provider routing (`router_model=openai|gemini`) is preserved; Wayfinder waits for the requested provider result when that provider is invocable.
- Background calls still apply `ROUTER_LLM_MAX_RETRIES`; for tighter cost control in fast mode, consider `ROUTER_LLM_MAX_RETRIES=0`.
- If only one provider is invocable (for example breaker-open on the other provider), fast mode falls back to single-provider standard flow.

## Latency Guardrails
- Start with `full` in production unless latency SLO requires `fast`.
- Use `fast` when uncached route latency is above SLO and provider quality is acceptable.
- Re-validate after switching modes:
  - P50/P95 latency
  - routing error rate
  - fallback/circuit-breaker behavior

## Safe Rollback
- Revert environment variables to previous known-good values.
- Re-deploy.
- Re-run `POST /admin/router/validate`.
- Confirm `/health` provider snapshot recovery.

## Notes
- `POST /admin/router/validate` performs live provider calls and can incur API cost.
- Validation cooldown may return `429` if called repeatedly in short intervals.
