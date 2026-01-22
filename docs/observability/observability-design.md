# Observability Design for Wayfinder (Cloud Run)

## Goals
- Provide full operational visibility for Cloud Run services.
- Track product and business metrics (users, tokens, routing usage, cache hit rate).
- Enable future billing/monetization with reliable usage records.
- Support alerting and dashboards for SLOs, cost, and reliability.

## Recommended Tech Stack (Cloud Run)
Core:
- Cloud Monitoring (metrics + alerting)
- Cloud Logging (structured logs from app)
- Cloud Trace (request tracing)

Instrumentation:
- OpenTelemetry SDK (Node.js) with OTLP exporter
- Google Cloud OpenTelemetry distro (preferred) or OTLP to Cloud Monitoring

Business Analytics / Billing:
- Log sink to BigQuery for event-level usage analysis
- Optional: Cloud SQL (Postgres) or BigQuery as a billing ledger store

Why this stack:
- First-class support for Cloud Run and GCP.
- Minimal operational overhead vs. third-party APM.
- Allows both real-time operational metrics and long-term billing/analytics.

## High-Level Architecture
1) App emits structured logs and OpenTelemetry metrics/traces.
2) Cloud Run captures logs and traces automatically.
3) Custom metrics go to Cloud Monitoring.
4) Usage events are optionally exported to BigQuery via log sinks.
5) Dashboards and alerts are built in Cloud Monitoring.

## Instrumentation Strategy
### 1) Request Metrics
Use OpenTelemetry HTTP instrumentation.
Key metrics:
- `http.server.request_count`
- `http.server.duration`
- `http.server.request_size`
- `http.server.response_size`

Dimensions (labels):
- `route` (e.g., /route, /feedback, /admin, /api/tokens)
- `status_code`
- `method`
- `token_id` (careful: high-cardinality; see below)

### 2) Routing + LLM Metrics
Emit custom metrics for:
- `routing.requests_total` (counter)
- `routing.cache_hits_total` (counter)
- `routing.cache_misses_total` (counter)
- `routing.llm_calls_total` (counter)
- `routing.llm_latency_ms` (histogram)
- `routing.provider_errors_total` (counter)
- `routing.fallbacks_total` (counter)

Labels:
- `provider` (openai, gemini)
- `router_model_used` (openai, gemini, consensus)
- `token_tier` (free, paid_system, paid_byollm, admin)

### 3) Token + User Metrics
Emit gauges or computed metrics:
- `users.total` (gauge)
- `tokens.total` (gauge)
- `tokens.active_total` (gauge)
- `tokens.active_per_user` (distribution via BigQuery or periodic job)

Note: Gauges are best computed via scheduled jobs to avoid expensive realtime queries.

### 4) Billing / Monetization Metrics
Capture event-level usage data for billing:
- `usage.route_requests` (counter)
- `usage.llm_calls` (counter)
- `usage.cached_routes` (counter)
- `usage.llm_tokens_in` / `usage.llm_tokens_out` (if available)

Recommended:
- Emit a structured "usage event" log for each request to `/route`.
- Export usage events to BigQuery.
- Aggregate daily/monthly usage for billing.

## Metric Cardinality Guidance
Avoid high-cardinality labels in Monitoring (token_id, user_id). Instead:
- Use token/user IDs only in logs or in BigQuery analytics.
- Keep Monitoring labels to low-cardinality values (provider, tier, route, status).

## Data Storage and Aggregation
### Cloud Monitoring (Operational)
- Real-time metrics for latency, error rates, cache hit rate.

### BigQuery (Analytics + Billing)
- Log sinks from Cloud Logging to BigQuery.
- Scheduled queries to compute:
  - Daily active users
  - Active tokens per user
  - Billable usage per token/user
  - Cache hit rates by tier/provider

### Optional Billing Ledger
If billing needs strong consistency:
- Store per-request usage in a durable ledger (Cloud SQL).
- Aggregate into invoices or Stripe usage events.

## Proposed Structured Log Events
### Routing Usage Event
Fields:
- `event_type: "routing_usage"`
- `timestamp`
- `request_id`
- `token_id`
- `user_id` (if available)
- `token_tier`
- `router_model_used`
- `provider` (openai/gemini/consensus)
- `cache_hit` (true/false)
- `llm_call` (true/false)
- `llm_latency_ms` (if applicable)
- `llm_tokens_in` / `llm_tokens_out` (if available)
- `eligible_models_count`

### Token Lifecycle Event
Fields:
- `event_type: "token_created" | "token_deleted" | "token_rotated"`
- `timestamp`
- `token_id`
- `user_id`
- `is_primary`
- `eligible_models` (only on create)

### User Lifecycle Event
Fields:
- `event_type: "user_registered" | "user_logged_in"`
- `timestamp`
- `user_id`
- `email_hash` (never log raw email)

## Dashboards (Cloud Monitoring)
Operational:
- Request rate, error rate, p50/p95 latency
- Cache hit rate and misses
- LLM call rate + latency by provider
- Redis connectivity health

Business:
- Daily active users
- Active tokens
- Requests per token tier
- Cache hit rate by tier

Billing:
- Total billable requests by day
- LLM calls by provider/tier
- Tokens-in/out (if available)

## Alerting
Suggested alerts:
- 5xx error rate > 2% for 5 min
- p95 /route latency > 2s for 5 min
- Redis connection failures > 0
- Cache hit rate < 20% for 15 min (if expected to be higher)
- LLM provider errors spike

## Privacy + Security
- Never log plaintext prompts or API keys.
- Hash emails before logging.
- Token IDs are OK in logs but do not expose token secrets.
- Ensure BigQuery access is restricted (PII and usage data).

## Rollout Plan
1) Add OpenTelemetry SDK with HTTP + custom metrics.
2) Emit routing usage event logs.
3) Create Cloud Monitoring dashboards + alerts.
4) Add log sink to BigQuery.
5) Add scheduled aggregation jobs (daily/weekly).

## Open Questions
- Do we want usage-based billing at request-level or token-level?
- Should billing be computed in BigQuery or a ledger database?
- Do we need per-user SLOs or just system-wide?
