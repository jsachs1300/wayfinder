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
docker run -e ADMIN_API_KEY=xxx -e ROUTER_LLM_API_KEY=yyy wayfinder

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
**Current State:** ❌ HTTP only

**Why Critical:** Protects API keys and tokens in transit

**Implementation:**
```bash
# Option 1: Reverse proxy (RECOMMENDED)
# Use Nginx, Caddy, or cloud load balancer

# nginx.conf
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Option 2: Let's Encrypt with Caddy (easiest)
# Caddyfile
api.yourdomain.com {
    reverse_proxy localhost:3000
}
```

**Action Items:**
- [ ] Set up reverse proxy (Nginx/Caddy)
- [ ] Obtain SSL certificate (Let's Encrypt recommended)
- [ ] Configure auto-renewal
- [ ] Enforce HTTPS (redirect HTTP to HTTPS)
- [ ] Enable HSTS headers

---

#### 4. **Input Validation & Security Headers**
**Current State:** ⚠️ Partial (Zod validation exists for some endpoints)

**Implementation:**
```bash
npm install helmet cors express-validator
```

```typescript
// src/app.ts additions
import helmet from 'helmet';
import cors from 'cors';

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Wayfinder-Token', 'X-Admin-Api-Key'],
  credentials: true,
}));

// Body size limits (prevent large payload attacks)
app.use(express.json({ limit: '10kb' }));
```

**Action Items:**
- [ ] Install helmet and configure security headers
- [ ] Set up CORS with allowed origins
- [ ] Add request size limits
- [ ] Validate all user inputs with Zod schemas
- [ ] Sanitize error messages (don't leak stack traces)

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
- [ ] HTTPS enforced
- [x] **Rate limiting on all endpoints** ✅ DONE
- [ ] Input validation on all user inputs
- [ ] Security headers (helmet)
- [ ] CORS properly configured
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

# 2. Add security headers (helmet + CORS)
npm install helmet cors

# Update src/app.ts:
import helmet from 'helmet';
import cors from 'cors';

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
}));

# 3. Use Docker Compose with Redis
docker-compose up -d

# 4. Put behind HTTPS reverse proxy (Caddy is easiest)
# Install Caddy, create Caddyfile:
api.yourdomain.com {
    reverse_proxy localhost:3000
}

# 5. Set strong environment variables
ADMIN_API_KEY=$(openssl rand -hex 32)
ROUTER_LLM_API_KEY=your-openai-or-anthropic-key

# 6. Monitor with simple health checks
curl https://api.yourdomain.com/health
```

**Time to launch:** ~2-3 hours (down from 3-4 hours with rate limiting complete!)

---

## Additional Resources

- **Express Security Best Practices:** https://expressjs.com/en/advanced/best-practice-security.html
- **Node.js Production Best Practices:** https://github.com/goldbergyoni/nodebestpractices
- **OWASP Top 10:** https://owasp.org/www-project-top-ten/
- **Docker Security:** https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
