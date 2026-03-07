# Local Integration Testing

This guide sets up a production-like local test loop with real Redis, real router providers, and real LangCache credentials.

## Goal
- Catch integration regressions locally before opening a PR.
- Reproduce cloud behavior with the same env contract.

## 1. Create local env files

Copy templates:

```bash
cp .env.local.integration.example .env.local.integration
cp .env.local.secrets.example .env.local.secrets
```

Fill in real values in `.env.local.secrets`:
- `ADMIN_API_KEY`
- `ROUTER_LLM_OPENAI_API_KEY`
- `ROUTER_LLM_GEMINI_API_KEY`
- `LANGCACHE_HOST`
- `LANGCACHE_CACHE_ID`
- `LANGCACHE_API_KEY`
- `LLM_KEY_ENCRYPTION_KEY`
- `POSTMARK_API_KEY` (optional unless testing email delivery)

## 2. Start local Redis

```bash
npm run local:deps:up
```

Redis runs via `docker-compose.local-integration.yml` on `localhost:6379`.

## 3. Validate local integration config

```bash
npm run local:full:check
```

This validates:
- env files exist
- required vars are present
- encryption key format is valid
- Redis is reachable

## 4. Run full local integration test path

```bash
npm run test:integration:local-full
```

This command:
1. loads `.env.local.integration` and `.env.local.secrets`
2. runs local env validation
3. runs `npm test` with your local integration settings

## 5. Optional smoke test against a running local server

Start app:

```bash
set -a; source .env.local.integration; source .env.local.secrets; set +a
npm run dev
```

In a second terminal:

```bash
set -a; source .env.local.integration; source .env.local.secrets; set +a
node scripts/smoke-test.js
```

## 6. Tear down local dependencies

```bash
npm run local:deps:down
```

## Cloud Build parity mapping

Use the same variable names as cloud deployments:
- Router providers: `ROUTER_LLM_*`
- LangCache: `LANGCACHE_*`
- Redis: `REDIS_URL`
- User self-service/BYOLLM: `FEATURE_USER_SELF_SERVICE`, `LLM_KEY_ENCRYPTION_KEY`
- Admin auth: `ADMIN_API_KEY`

Keeping names identical avoids environment-specific drift between local and CI.
