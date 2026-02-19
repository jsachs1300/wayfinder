# Troubleshooting

_Extracted from the previous README._

## Troubleshooting

### Router LLM Configuration

**Problem:** `Error: At least one router LLM provider must be enabled`

**Cause:** System cannot start in production without at least one router LLM provider configured.

**Solution:**
1. Get API key from your provider:
   - OpenAI: https://platform.openai.com/api-keys
   - Gemini: https://aistudio.google.com/app/apikey

2. Add to `.env`:
   ```bash
   # Enable OpenAI
   ROUTER_LLM_OPENAI_ENABLED=true
   ROUTER_LLM_OPENAI_API_KEY=sk-your-openai-key

   # Or enable Gemini
   ROUTER_LLM_GEMINI_ENABLED=true
   ROUTER_LLM_GEMINI_API_KEY=your-gemini-key

   # Or enable both for multi-provider routing
   ```

3. Restart the server

**For testing/development:** Set `NODE_ENV=development` to bypass this requirement

### Router LLM API Failures

**Problem:** `RouterLLMRetryExhaustedError` or timeouts in routing requests

**Possible causes:**
- API key is invalid or expired
- API key has insufficient quota
- Provider is experiencing issues
- Timeout is too short for heavy load

**Solutions:**
```bash
# Increase timeout (default 10s)
ROUTER_LLM_TIMEOUT=15000

# Reduce max retries if getting stuck (default 2)
ROUTER_LLM_MAX_RETRIES=1

# Check API key validity by calling provider directly
# (This step depends on your provider)
```

### Router LLM Response Validation

**Problem:** `RouterLLMContractViolation` error

**Cause:** Router LLM returned a response that violates the canonical schema.

**Schema requirements:**
```json
{
  "intent": "string",
  "primary": {
    "model": "string",
    "score": number,
    "reason": "string"
  },
  "alternate": {
    "model": "string",
    "score": number,
    "reason": "string"
  }
}
```

**Solutions:**
- Check LLM prompt engineering in `src/routing/router-llm/prompt-builder.ts`
- Verify router LLM is capable of returning JSON
- Try switching LLM model to one with better structured output support
- Increase `ROUTER_LLM_MAX_TOKENS` if response is being truncated

### Authentication Failures

**Problem:** `401 Unauthorized` responses

**Solutions:**
- Ensure `ADMIN_API_KEY` is set in `.env`
- Verify you're using the correct header name (`X-Admin-Api-Key` or `X-Wayfinder-Token`)
- Check that the token hasn't been deleted or rotated
- For user tokens, ensure the token starts with `wf_`

### Validation Errors

**Problem:** `400 ValidationError` on API requests

**Common causes:**
- Missing required fields (e.g., `prompt` in `/route` request)
- Invalid model identifier not in registry
- Invalid policy rule type
- Confidence threshold outside 0-1 range

**Solution:** Check the `details` field in the error response for specific validation issues.

### No Models Eligible After Policy

**Problem:** Router LLM has no models to choose from

**Cause:** Policy rules or denied_models list excluded all available models.

**Solution:**
```bash
# Check available models
curl http://localhost:3000/admin/models \
  -H "X-Admin-Api-Key: your-admin-key"

# Review token's policy rules
curl http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key"

# Update to allow more models
curl -X PATCH http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"allowed_models": ["gpt-4-turbo", "gemini-1.5-pro"]}'
```

### Redis Connection Issues

**Problem:** Wayfinder fails to connect to Redis

**Solution:**
```bash
# Check if Redis is running
redis-cli ping

# If using Docker, ensure Redis service is healthy
docker-compose ps

# Disable Redis and use in-memory storage
# In .env:
REDIS_ENABLED=false
```

### Docker Build Failures

**Problem:** Docker build or compose fails

**Solutions:**
```bash
# Clean build without cache
docker-compose build --no-cache

# Check logs for specific errors
docker-compose logs wayfinder

# Ensure Node.js version compatibility
# Check Dockerfile uses node:18+ or compatible version
```

### Intent-Based Policy Rules Not Working

**Problem:** Intent-based policy rules (ForceModelByIntent, RestrictModelsByIntent) don't match as expected

**Cause:** Intent-based rules are currently in **beta** with a known timing limitation. All requests use placeholder intent `"other"` during policy evaluation.

**Solution:**

```bash
# Option 1: Use global rules instead (recommended)
curl -X PATCH http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "allowed_models": ["gpt-4-turbo", "gemini-1.5-pro"],
    "policy_rules": [
      {
        "type": "AllowModelsGlobal",
        "models": ["gpt-4-turbo", "gemini-1.5-pro"],
        "priority": 1
      }
    ]
  }'

# Option 2: Use intent-based rules with "other" intent (beta workaround)
curl -X PATCH http://localhost:3000/admin/tokens/TOKEN_ID \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "policy_rules": [
      {
        "type": "ForceModelByIntent",
        "intent": "other",
        "models": ["gemini-1.5-pro"],
        "priority": 1
      }
    ]
  }'
```

See [Policy Rule Types](#policy-rule-types) for detailed explanation and migration guidance.

### User Self-Service Issues

**Problem:** User registration fails with "FEATURE_USER_SELF_SERVICE is disabled"

**Cause:** User self-service features are disabled by default.

**Solution:**
```bash
# In .env:
FEATURE_USER_SELF_SERVICE=true

# Restart the server
npm run dev
```

---

**Problem:** BYOLLM key management fails with "BYOLLM_001: BYOLLM requires paid_byollm tier"

**Cause:** User is not on the paid_byollm tier.

**Solution:**
BYOLLM key management is only available to users with `tier: 'paid_byollm'`. User tier must be upgraded by an admin (payment/billing integration is not yet implemented):

```bash
# Admin must update user tier directly in the user store
# This will be exposed via admin API in future versions
```

---

**Problem:** "LLM_KEY_ENCRYPTION_KEY environment variable is required"

**Cause:** BYOLLM features require an encryption key to secure user API keys.

**Solution:**
```bash
# Generate a secure 256-bit encryption key
openssl rand -hex 32

# Add to .env:
LLM_KEY_ENCRYPTION_KEY=<64 hex characters from above>

# Restart the server
```

---

**Problem:** Rate limit exceeded errors for registered users

**Cause:** User is hitting tier-specific rate limits.

**Solution:**
```bash
# Check current rate limits via profile endpoint
curl http://localhost:3000/api/users/me \
  -H "X-Wayfinder-Token: wf_xxxxx"

# To increase limits, upgrade user tier (admin operation)
# Or adjust rate limit configuration in .env:
RATE_LIMIT_FREE_DAY=100
RATE_LIMIT_PAID_SYSTEM_DAY=5000
```

---

**Problem:** "Cannot delete last token"

**Cause:** Users must always have at least one active token to prevent account lockout.

**Solution:**
Create another token, then retry the delete:

```bash
curl -X POST http://localhost:3000/api/tokens \
  -H "X-Wayfinder-Token: wf_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "Secondary"}'
```

---

**Problem:** BYOLLM routing still uses system keys instead of user keys

**Cause:** User keys may not be properly configured or may have failed validation.

**Solution:**
```bash
# Check configured keys
curl http://localhost:3000/api/llm-keys \
  -H "X-Wayfinder-Token: wf_xxxxx"

# Validate keys
curl -X POST http://localhost:3000/api/llm-keys/openai/validate \
  -H "X-Wayfinder-Token: wf_xxxxx"

# Check logs for BYOLLM routing behavior
# Should see: "Using user LLM keys for routing"
```

