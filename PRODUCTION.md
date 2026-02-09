# Production Deployment Guide

## Quick Start - Production NPM Scripts

### Recommended package.json additions:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/server.js",
  "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
  "prod": "npm run build && npm start",
  "start:prod": "NODE_ENV=production node dist/server.js",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "lint": "eslint src --ext .ts",
  "lint:fix": "eslint src --ext .ts --fix",
  "clean": "rm -rf dist",
  "typecheck": "tsc --noEmit",
  "validate": "npm run lint && npm run typecheck && npm test"
}
```

### Usage:

```bash
# Development
npm run dev

# Production (bare metal)
npm run prod                 # Build and start
npm run build && npm start   # Or separately

# Production (Docker - RECOMMENDED)
docker-compose up -d

# Validation before deployment
npm run validate
```

---

## Critical Production Considerations

### 🔴 MUST HAVE (Security & Reliability)

#### 1. **Environment Variables & Secrets Management**
**Current State:** Using `.env` file (⚠️ NOT production-safe)

**Issues:**
- .env files can be accidentally committed
- No encryption at rest
- No audit trail for secret access

**Recommended Solutions:**
```bash
# Option 1: Use environment variables directly (Docker/K8s)
docker run \
  -e ADMIN_API_KEY=xxx \
  -e ROUTER_LLM_OPENAI_ENABLED=true \
  -e ROUTER_LLM_OPENAI_API_KEY=yyy \
  -e LANGCACHE_ENABLED=true \
  -e LANGCACHE_HOST=... \
  -e LANGCACHE_CACHE_ID=... \
  -e LANGCACHE_API_KEY=... \
  wayfinder

# Option 2: Secrets management services
- AWS Secrets Manager
- HashiCorp Vault
- Docker Secrets
- Kubernetes Secrets

# Option 3: Encrypted .env (dotenvx)
npm install @dotenvx/dotenvx
npx dotenvx encrypt
```

**Action Items:**
- [ ] Never commit `.env` to git (verify `.gitignore`)
- [ ] Use strong, unique API keys (32+ characters)
- [ ] Rotate secrets regularly (90 days)
- [ ] Use different keys per environment (dev/staging/prod)

---

#### 2. **Rate Limiting**
**Current State:** ✅ IMPLEMENTED

**Why Critical:** Prevent abuse, DDoS attacks, cost overruns (LLM API calls are expensive)

**Implementation Status:**
- ✅ `express-rate-limit` installed and configured
- ✅ Per-endpoint rate limits with different strategies:
  - **Routing** (`/route`): 20 req/min per token (conservative due to LLM costs)
  - **Admin** (`/admin/*`): 50 req/15min per IP
  - **Feedback** (`/feedback`): 100 req/15min per token
  - **Global**: 100 req/15min per IP (fallback)
- ✅ Redis-backed rate limiting (when Redis is enabled)
- ✅ Standard `RateLimit-*` headers in responses
- ✅ IPv6-compatible IP key generation
- ✅ Fully configurable via environment variables

**Configuration:**

All rate limits are configurable via `.env`:

```bash
# Routing endpoint (per token, most critical due to LLM costs)
RATE_LIMIT_ROUTING_WINDOW_MS=60000   # 1 minute
RATE_LIMIT_ROUTING_MAX=20            # 20 requests

# Admin endpoints (per IP)
RATE_LIMIT_ADMIN_WINDOW_MS=900000    # 15 minutes
RATE_LIMIT_ADMIN_MAX=50              # 50 requests

# Feedback endpoint (per token)
RATE_LIMIT_FEEDBACK_WINDOW_MS=900000 # 15 minutes
RATE_LIMIT_FEEDBACK_MAX=100          # 100 requests

# Session/auth endpoints (per IP)
RATE_LIMIT_AUTH_WINDOW_MS=900000     # 15 minutes
RATE_LIMIT_AUTH_MAX=20               # 20 requests

# Global fallback (per IP)
RATE_LIMIT_GLOBAL_WINDOW_MS=900000   # 15 minutes
RATE_LIMIT_GLOBAL_MAX=100            # 100 requests
```

**Response Headers:**
```http
RateLimit-Policy: 20;w=60
RateLimit-Limit: 20
RateLimit-Remaining: 19
RateLimit-Reset: 60
```

**Remaining Action Items:**
- [ ] Monitor rate limit hits in production logs
- [ ] Adjust thresholds based on actual usage patterns
- [ ] Set up alerts for excessive rate limit violations
- [ ] Document rate limits in API documentation for users

---

#### 3. **HTTPS/TLS**
**Current State:** ❌ HTTP only (requires reverse proxy)

**Why Critical:** Protects API keys and tokens in transit

**Implementation:**

**See [NGINX_GUIDE.md](./NGINX_GUIDE.md) for comprehensive setup instructions** including:
- Step-by-step Nginx installation
- Automated SSL with Let's Encrypt/Certbot
- Production-ready configuration with rate limiting
- Security hardening (firewall, fail2ban)
- Load balancing for multiple instances
- Monitoring and troubleshooting

**Quick Setup Options:**

```bash
# Option 1: Caddy (easiest - automatic HTTPS)
# Caddyfile
api.yourdomain.com {
    reverse_proxy localhost:3000
}

# Option 2: Nginx with Let's Encrypt (see NGINX_GUIDE.md)
# Automated setup with certbot
sudo certbot --nginx -d api.yourdomain.com
```

**Action Items:**
- [ ] Set up reverse proxy (see NGINX_GUIDE.md)
- [ ] Obtain SSL certificate (Let's Encrypt recommended)
- [ ] Configure auto-renewal (certbot handles this)
- [ ] Enforce HTTPS (redirect HTTP to HTTPS)
- [ ] HSTS headers already enabled via helmet ✅

---

#### 4. **Input Validation & Security Headers**
**Current State:** ✅ Security headers IMPLEMENTED, ✅ Input validation with Zod

**Implementation Status:**
- ✅ **helmet** installed and configured with comprehensive security headers:
  - Content Security Policy (CSP) with strict directives
  - HSTS (HTTP Strict Transport Security) with 1-year max-age, includeSubDomains, preload
  - X-Content-Type-Options: nosniff (prevents MIME sniffing)
  - X-Frame-Options / frame-ancestors (prevents clickjacking)
  - Referrer-Policy: strict-origin-when-cross-origin
  - XSS protection (legacy header for older browsers)
- ✅ **CORS** configured with:
  - Origin validation (configurable via `ALLOWED_ORIGINS` env var)
  - Proper headers exposed for rate limiting (`RateLimit-*`)
  - Credentials support
  - Standard HTTP methods (GET, POST, PATCH, DELETE, OPTIONS)
- ✅ **Input validation** with Zod schemas on routing/feedback/admin endpoints
- ✅ **Trust proxy** enabled for correct IP detection behind reverse proxy

**Configuration:**

See `.env.example` for CORS configuration:
```bash
# CORS (Cross-Origin Resource Sharing)
# Comma-separated list of allowed origins (default: * allows all origins)
# In production, specify exact origins: https://app.example.com,https://admin.example.com
ALLOWED_ORIGINS=*
```

**Remaining Action Items:**
- [ ] Configure production ALLOWED_ORIGINS (replace wildcard with specific domains)
- [ ] Add request size limits with `app.use(express.json({ limit: '10kb' }))`
- [ ] Sanitize error messages in production (avoid leaking stack traces)

---

#### 5. **Logging & Monitoring**
**Current State:** ✅ Structured logging exists

**Enhancements Needed:**
```bash
# Log aggregation
- Datadog
- New Relic
- Elastic Stack (ELK)
- CloudWatch Logs

# Error tracking
npm install @sentry/node
```

```typescript
// src/app.ts
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });

  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.errorHandler());
}
```

**Metrics to Monitor:**
- Request rate (requests/sec)
- Error rate (5xx responses)
- Response latency (p50, p95, p99)
- Router LLM call duration
- Redis connection health
- Memory/CPU usage
- Active connections

**Action Items:**
- [ ] Set up error tracking (Sentry/Rollbar)
- [ ] Configure log aggregation
- [ ] Create dashboards for key metrics
- [ ] Set up alerts (error rate > 5%, latency > 1s, etc.)
- [ ] Add distributed tracing for LLM calls

---

#### 6. **Process Management & Resilience**
**Current State:** ✅ Graceful shutdown implemented, ⚠️ No process manager

**Recommended: PM2**
```bash
npm install -g pm2

# ecosystem.config.js
module.exports = {
  apps: [{
    name: 'wayfinder',
    script: 'dist/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
    },
    max_memory_restart: '500M',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Auto-start on reboot
```

**Docker Alternative (RECOMMENDED):**
```yaml
# docker-compose.yml (already exists)
services:
  wayfinder:
    restart: unless-stopped
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
```

**Action Items:**
- [ ] Use Docker with restart policies (already configured ✅)
- [ ] Configure health checks (already configured ✅)
- [ ] Set memory/CPU limits
- [ ] Test crash recovery
- [ ] Implement circuit breakers for external API calls

---

### 🟡 SHOULD HAVE (Performance & Scalability)

#### 7. **Caching Strategy**
**Current State:** ❌ No HTTP caching

**Implementation:**
```typescript
// Cache routing decisions for identical prompts (with TTL)
import NodeCache from 'node-cache';
const routeCache = new NodeCache({ stdTTL: 300 }); // 5 min TTL

// In routing handler:
const cacheKey = `${tokenId}:${promptHash}`;
const cached = routeCache.get(cacheKey);
if (cached) return res.json(cached);
```

**Considerations:**
- Cache /models endpoint (rarely changes)
- Cache policy evaluations for same token+intent
- Use Redis for distributed caching
- Invalidate cache on feedback/knowledge updates

---

#### 8. **Database Optimization**
**Current State:** ✅ Redis for knowledge/tokens (good!)

**Recommendations:**
- [ ] Use Redis persistence (already configured ✅)
- [ ] Set up Redis replication for HA
- [ ] Monitor Redis memory usage
- [ ] Configure eviction policies
- [ ] Consider Redis Cluster for >10GB data

---

#### 9. **API Versioning**
**Current State:** ❌ No versioning

**Future-proof your API:**
```typescript
// Option 1: URL versioning
app.use('/v1/route', routingRoutes);
app.use('/v1/admin', adminRoutes);

// Option 2: Header versioning
app.use((req, res, next) => {
  const version = req.headers['x-api-version'] || 'v1';
  req.apiVersion = version;
  next();
});
```

---

### 🟢 NICE TO HAVE (Operational Excellence)

#### 10. **CI/CD Pipeline**
```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run validate

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t wayfinder:latest .
      - run: docker push registry/wayfinder:latest
      # Deploy to your infrastructure
```

---

#### 11. **Documentation**
- [ ] OpenAPI/Swagger spec for API
- [ ] Runbook for common operations
- [ ] Incident response playbook
- [ ] Architecture diagrams
- [ ] API rate limits documentation

---

#### 12. **Backup & Disaster Recovery**
- [ ] Redis snapshot backups (automated)
- [ ] Token/configuration backups
- [ ] RTO/RPO definition (how quickly can you recover?)
- [ ] Test restore procedures

---

## Cost Considerations for Public Service

### 1. **LLM API Costs**
- Router LLM calls on EVERY request
- Set budgets/alerts in provider dashboard
- Consider cheaper models for routing (gpt-4o-mini, claude-haiku)
- Cache routing decisions aggressively

### 2. **Infrastructure Costs**
- Redis: $20-100/month (managed Redis)
- Server: $10-50/month (small VPS)
- Load balancer: $10-20/month
- SSL cert: Free (Let's Encrypt)

**Estimated monthly cost:** $50-200 for small-medium scale

---

## Security Checklist for Public Launch

- [ ] Strong, unique API keys for all services
- [ ] HTTPS enforced (requires reverse proxy - see NGINX_GUIDE.md)
- [x] **Rate limiting on all endpoints** ✅ DONE
- [x] **Input validation on all user inputs** ✅ DONE (Zod schemas)
- [x] **Security headers (helmet)** ✅ DONE
- [x] **CORS properly configured** ✅ DONE
- [ ] Error messages sanitized (no stack traces)
- [ ] Secrets not in code/git
- [ ] Dependencies scanned for vulnerabilities
- [x] **DoS protection via rate limiting** ✅ DONE (CloudFlare optional)
- [ ] Monitoring and alerting set up
- [ ] Backup and recovery tested
- [ ] Terms of Service published
- [ ] Privacy Policy (if storing user data)

---

## Deployment Checklist

### Pre-deployment
- [ ] `npm run validate` passes
- [ ] All tests passing (315/315)
- [ ] Environment variables configured
- [ ] Secrets rotated
- [ ] Rate limits configured
- [ ] Monitoring/alerts set up

### Deployment
- [ ] Deploy to staging first
- [ ] Run smoke tests
- [ ] Load test (Apache Bench, k6)
- [ ] Monitor error rates
- [ ] Gradual rollout (10% → 50% → 100%)

### Post-deployment
- [ ] Monitor logs for errors
- [ ] Check latency metrics
- [ ] Verify health checks passing
- [ ] Test key user flows
- [ ] Document any issues

---

## Cloud Build Triggers & Secrets

### Triggers
We maintain two Cloud Build triggers:
- **Dev (main branch)**: Builds and deploys `wayfinder-dev` using `cloudbuild.main.yaml` (image tagged with `COMMIT_SHA`).
- **Prod (tags)**: Builds and deploys `wayfinder-prod` using `cloudbuild.yaml` (image tagged with `TAG_NAME`).

Recommended trigger patterns:
- `main` branch: `^main$`
- production release tags: `^v\\d+\\.\\d+\\.\\d+$`

### Secrets (Environment-Specific Names)
The Cloud Run environment variables are the same for dev and prod, but secrets are split by name:

Dev secrets:
- `ADMIN_API_KEY_DEV`
- `ROUTER_LLM_OPENAI_API_KEY_DEV`
- `ROUTER_LLM_GEMINI_API_KEY_DEV`
- `REDIS_URL_DEV`
- `LANGCACHE_API_KEY_DEV`
- `LLM_KEY_ENCRYPTION_KEY_DEV`
- `POSTMARK_API_KEY_DEV`

Prod secrets:
- `ADMIN_API_KEY_PROD`
- `ROUTER_LLM_OPENAI_API_KEY_PROD`
- `ROUTER_LLM_GEMINI_API_KEY_PROD`
- `REDIS_URL_PROD`
- `LANGCACHE_API_KEY_PROD`
- `LLM_KEY_ENCRYPTION_KEY_PROD`
- `POSTMARK_API_KEY_PROD`

Cloud Build mappings:
- Dev (`cloudbuild.main.yaml`) maps `ADMIN_API_KEY=ADMIN_API_KEY_DEV:latest` (same pattern for other secrets).
- Prod (`cloudbuild.yaml`) maps `ADMIN_API_KEY=ADMIN_API_KEY_PROD:latest` (same pattern for other secrets).

### Required Cloud Build Substitutions
Both triggers must define these substitutions to avoid accidental deploy-time misconfiguration:

- `_LANGCACHE_HOST` (LangCache host, e.g. `aws-us-east-1.langcache.redis.io`)
- `_LANGCACHE_CACHE_ID` (LangCache cache id)
- `_ALLOWED_ORIGINS` (comma-separated frontend origins)
- `_FRONTEND_BASE_URL` (frontend base URL used in email links)

If these are missing, Cloud Build deploys can overwrite working Cloud Run env values with placeholders.

---

## Model Registry Sync (Production)

Wayfinder supports dynamic provider catalog sync into the system model registry. This keeps model lists current without hardcoding.

### Environment Variables

Core controls:

- `MODEL_REGISTRY_SYNC_ON_STARTUP` (default `false`)
- `MODEL_REGISTRY_SYNC_TIMEOUT_MS` (default `10000`)

Provider flags and credentials:

- `MODEL_REGISTRY_OPENAI_ENABLED` (falls back to `ROUTER_LLM_OPENAI_ENABLED`)
- `MODEL_REGISTRY_OPENAI_API_KEY` (falls back to `ROUTER_LLM_OPENAI_API_KEY`)
- `MODEL_REGISTRY_OPENAI_BASE_URL` (default `https://api.openai.com/v1`)
- `MODEL_REGISTRY_GEMINI_ENABLED` (falls back to `ROUTER_LLM_GEMINI_ENABLED`)
- `MODEL_REGISTRY_GEMINI_API_KEY` (falls back to `ROUTER_LLM_GEMINI_API_KEY`)
- `MODEL_REGISTRY_GEMINI_BASE_URL` (default `https://generativelanguage.googleapis.com/v1beta`)
- `MODEL_REGISTRY_ANTHROPIC_ENABLED` (default `false`)
- `MODEL_REGISTRY_ANTHROPIC_API_KEY`
- `MODEL_REGISTRY_ANTHROPIC_BASE_URL` (default `https://api.anthropic.com/v1`)
- `MODEL_REGISTRY_ANTHROPIC_VERSION` (default `2023-06-01`)
- `MODEL_REGISTRY_XAI_ENABLED` (default `false`)
- `MODEL_REGISTRY_XAI_API_KEY`
- `MODEL_REGISTRY_XAI_BASE_URL` (default `https://api.x.ai/v1`)
- `MODEL_REGISTRY_OLLAMA_ENABLED` (default `false`)
- `MODEL_REGISTRY_OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `MODEL_REGISTRY_OLLAMA_API_KEY` (optional)

### Operational Runbook

After deployment (or any provider credential change), run:

```bash
curl -X POST "https://<service-domain>/admin/registry/refresh" \
  -H "X-Admin-Api-Key: <admin-api-key>"
```

Expected behavior:

- `200 OK` with per-provider `imported_count` and error details (if partial failures).
- `503 ServiceUnavailable` when no providers are configured/enabled.

Validate results:

```bash
curl "https://<service-domain>/admin/registry" \
  -H "X-Admin-Api-Key: <admin-api-key>"
```

Troubleshooting:

- Provider shows error: verify API key, quota, endpoint/base URL, and Cloud Run egress/network policy.
- Zero imports for a provider: confirm provider is enabled and returns models supporting generation.
- `503` on refresh: ensure at least one provider is enabled and has credentials.

## Recommended Deployment Architecture

```
                                ┌──────────────┐
                                │ CloudFlare   │
                                │ (DDoS, CDN)  │
                                └──────┬───────┘
                                       │
                                ┌──────▼───────┐
                                │ Load Balancer│
                                │ (SSL, HTTP/2)│
                                └──────┬───────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
              ┌─────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
              │ Wayfinder  │   │ Wayfinder   │   │ Wayfinder   │
              │ Instance 1 │   │ Instance 2  │   │ Instance 3  │
              └─────┬──────┘   └──────┬──────┘   └──────┬──────┘
                    │                  │                  │
                    └──────────────────┼──────────────────┘
                                       │
                                ┌──────▼───────┐
                                │ Redis Cluster│
                                │ (Persistence)│
                                └──────────────┘
```

---

## Quick Win: Minimal Production-Ready Setup

If you need to launch quickly with basic security:

```bash
# 1. Rate limiting ✅ ALREADY DONE
# Rate limiting is already implemented! Just configure via .env if needed.

# 2. Security headers (helmet + CORS) ✅ ALREADY DONE
# Security headers are already implemented! Just configure ALLOWED_ORIGINS in .env:
ALLOWED_ORIGINS=https://app.yourdomain.com,https://yourdomain.com

# 3. Use Docker Compose with Redis
docker-compose up -d

# 4. Put behind HTTPS reverse proxy
# See NGINX_GUIDE.md for comprehensive setup instructions
# Quick option - Caddy (easiest):
api.yourdomain.com {
    reverse_proxy localhost:3000
}

# Or Nginx with Let's Encrypt (see NGINX_GUIDE.md for full setup)

# 5. Set required environment variables
ADMIN_API_KEY=$(openssl rand -hex 32)
ROUTER_LLM_OPENAI_ENABLED=true
ROUTER_LLM_OPENAI_API_KEY=your-openai-key
LANGCACHE_ENABLED=true
LANGCACHE_HOST=your-cache.langcache.redis.io
LANGCACHE_CACHE_ID=your-cache-id
NOTE: LANGCACHE_HOST and LANGCACHE_CACHE_ID must be set in the Cloud Run
service environment (or local .env). Cloud Build no longer injects them.

# Email (Postmark)
POSTMARK_API_KEY=your-postmark-server-token
EMAIL_FROM=Wayfinder <user-ops@wyfndr.ai>
EMAIL_REPLY_TO=support@yourdomain.com
LANGCACHE_API_KEY=your-langcache-key
NODE_ENV=production

# 6. Monitor with simple health checks
curl https://api.yourdomain.com/health
```

**Time to launch:** ~1-2 hours (down from 3-4 hours with rate limiting and security headers complete!)

**See also:** [NGINX_GUIDE.md](./NGINX_GUIDE.md) for comprehensive reverse proxy setup with SSL/TLS

---

## Additional Resources

- **Express Security Best Practices:** https://expressjs.com/en/advanced/best-practice-security.html
- **Node.js Production Best Practices:** https://github.com/goldbergyoni/nodebestpractices
- **OWASP Top 10:** https://owasp.org/www-project-top-ten/
- **Docker Security:** https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
