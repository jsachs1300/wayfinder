# Model Registry v3 Design

## 1. Goals
- Replace stale hardcoded model lists with a registry that can ingest provider model catalogs.
- Support a rich internal schema while tolerating sparse upstream provider metadata.
- Allow user-scoped registry customization with clear isolation boundaries.
- Improve routing quality by passing eligible model metadata to the router LLM.
- Keep system behavior deterministic and auditable.

## 2. Non-Goals
- Building billing/chargeback in this phase.
- Automatically trusting user-supplied metadata globally.
- Hard-coding provider-specific routing logic.

## 3. Core Design Decisions
- Registry data is layered:
  - `system_base` (provider-synced)
  - `system_curated` (admin overrides)
  - `user_overlay` (user overrides)
- Per user, `registry_mode` is:
  - `augment`: effective = system + user overlay
  - `override`: effective = user overlay only
- User metadata applies only to that user’s route requests.
- Provider sync is best-effort with fallback to cached data.

## 4. Internal Schema (Rich, Optional)

### 4.1 ModelRegistryEntry
```json
{
  "id": "gpt-4o-mini",
  "provider": "openai",
  "display_name": "GPT-4o mini",
  "status": "active",
  "availability": "generally_available",
  "context_window": 128000,
  "max_output_tokens": 16384,
  "cost": {
    "input_per_1k": 0.00015,
    "output_per_1k": 0.0006,
    "currency": "USD",
    "source": "curated"
  },
  "performance": {
    "quality_tier": "medium",
    "latency_tier": "fast",
    "strengths": ["reasoning", "coding", "summarization"],
    "weaknesses": ["long-form creative writing"]
  },
  "capabilities": {
    "tool_use": true,
    "vision": false,
    "audio": false,
    "json_mode": true
  },
  "provider_metadata": {
    "raw": {},
    "model_family": "gpt-4o",
    "version": "2026-01"
  },
  "metadata_confidence": {
    "cost": "high",
    "performance": "medium",
    "capabilities": "high"
  },
  "source": "system_base",
  "updated_at": "2026-02-08T00:00:00.000Z"
}
```

### 4.2 Required vs Optional
- Required fields:
  - `id`, `provider`, `status`, `source`, `updated_at`
- Optional fields (nullable):
  - all cost/performance/capability details

This allows sparse providers to contribute minimal entries without blocking registry ingestion.

## 5. Sparse Provider Handling

### 5.1 Ingestion Strategy
- Always ingest provider list data into `system_base`.
- If provider returns only sparse data:
  - Store known fields.
  - Leave unknown fields as `null`.
  - Mark confidence low/unknown.

### 5.2 Heuristic Defaults (Name-Based)
Two supported modes:
- `heuristics_disabled` (default): leave unknown metadata null.
- `heuristics_enabled`: infer coarse hints from model IDs (`mini`, `nano`, `pro`, `flash`, etc.).

Heuristic outputs must be marked:
- `source = inferred`
- `metadata_confidence = low`

Rationale: avoid silent misinformation while enabling optional usability.

## 6. Override Model

### 6.1 Admin/System-Wide Overrides
- Admin can set/patch metadata in `system_curated` for any model.
- Curated values override `system_base` during merge.
- Curated metadata has `source = curated`, higher confidence.

### 6.2 User-Scoped Overrides
- User can set metadata for models in their registry overlay.
- User values apply only for that user’s effective registry.
- User can choose:
  - `augment`: inherit system + user patches
  - `override`: only user registry entries are eligible

## 7. Crowd-Sourced Metadata (Future-Safe)
- Persist user overrides as structured votes/signals, not global truth.
- Create aggregate views per model for admin review:
  - most common `quality_tier`
  - most common `latency_tier`
  - top strengths tags
  - sample size and variance
- Admin can selectively promote aggregates into `system_curated`.

This keeps user input valuable without compromising global quality.

## 8. Effective Registry Resolution
For each route request:
1. Load user `registry_mode`.
2. Build system merged registry (`system_base + system_curated`).
3. Apply user overlay per mode.
4. Filter to token `eligible_models`.
5. If any eligible model missing:
  - fail request with validation error (recommended), or
  - strict warning + exclude (optional legacy mode only).

## 9. Router Prompt Integration
Continue passing `eligible_models`, and add metadata for each eligible model.

Example prompt payload fragment:
```json
{
  "eligible_models": ["gpt-4o-mini", "gemini-2.5-flash"],
  "model_registry": {
    "gpt-4o-mini": {
      "provider": "openai",
      "cost": {"input_per_1k": 0.00015, "output_per_1k": 0.0006, "currency": "USD"},
      "performance": {"quality_tier": "medium", "latency_tier": "fast", "strengths": ["coding", "reasoning"]},
      "capabilities": {"json_mode": true, "tool_use": true}
    },
    "gemini-2.5-flash": {
      "provider": "gemini",
      "cost": null,
      "performance": {"quality_tier": "medium", "latency_tier": "fast", "strengths": ["speed", "summarization"]},
      "capabilities": {"json_mode": true}
    }
  }
}
```

## 10. API Surface (Proposed)

### 10.1 User APIs
- `GET /api/registry` -> effective registry for current user.
- `POST /api/registry` -> create user entry.
- `PATCH /api/registry/:id` -> update user entry metadata.
- `DELETE /api/registry/:id` -> delete user entry.
- `POST /api/registry/mode` -> set `augment|override`.

### 10.2 Admin APIs
- `GET /admin/registry` -> system effective registry.
- `POST /admin/registry` -> create/update curated system entry.
- `PATCH /admin/registry/:id` -> patch curated metadata.
- `DELETE /admin/registry/:id` -> remove curated override.
- `POST /admin/registry/refresh` -> trigger provider sync.
- `GET /admin/registry/crowd/:modelId` -> aggregated user metadata insights.

## 11. Storage Model
- `wayfinder:registry:system:base` (provider-synced)
- `wayfinder:registry:system:curated` (admin overrides)
- `wayfinder:registry:user:{userId}` (user overlay)
- `wayfinder:registry:user:{userId}:mode` (`augment|override`)
- `wayfinder:registry:crowd:{modelId}` (aggregate insights)

## 12. Provider Sync
- Startup sync: attempt per enabled provider.
- Scheduled refresh: configurable interval (e.g., every 12h).
- Fallback order on failure:
  1. last cached registry
  2. minimal baked-in safe registry
- Never delete curated overrides during sync.

## 13. Validation Rules
- `id`: lowercase canonical identifier.
- `provider`: enum of enabled providers.
- Numeric fields: non-negative.
- Tier enums: constrained values.
- Unknown fields: rejected at write time.

## 14. Security & Trust
- User registry changes are isolated to user scope.
- No automatic promotion of user metadata to system scope.
- Admin promotion workflow required for global impact.
- Full audit log for system and user registry mutations.
- Metadata that reaches router prompts is untrusted:
  - include `safe_description` (sanitized) instead of raw `description`
  - strip control chars / code-fence markers before prompt injection
  - router prompt must state metadata fields are informational only, never instructions

## 15. Rollout Plan
1. Introduce schema + storage layer + read-path resolution.
2. Add provider sync and admin curated overrides.
3. Add user overlay + mode switching.
4. Add prompt metadata integration for eligible models.
5. Add crowd aggregation and admin insights endpoints.

## 16. Open Questions
1. Should missing eligible models be hard-fail only, or support temporary warn-and-exclude mode?
2. Should heuristics be enabled by default in dev only?
3. Should user overlays be user-scoped only, or org-scoped in a later phase?
