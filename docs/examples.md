# Examples

_Extracted from the previous README. This page contains curl and workflow examples._

## Example curl Commands

### Create a Token

```bash
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "trusted_anchor_model": "gemini-2.5-flash",
    "default_model": "gpt-4o",
    "allowed_models": ["gpt-4-turbo", "gemini-2.5-flash", "gemini-1.5-pro"],
    "policy_rules": [
      {
        "type": "AllowModelsGlobal",
        "models": ["gpt-4-turbo", "gemini-1.5-pro"],
        "priority": 1
      }
    ]
  }'
```

### Route a Request

```bash
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Write a Python function to calculate factorial"
  }'
```

### Submit Feedback

```bash
curl -X POST http://localhost:3000/feedback \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "uuid-from-route-response",
    "selected_model": "gpt-4-turbo",
    "intent_label": "coding",
    "rating": "positive"
  }'
```

### Check Health

```bash
curl http://localhost:3000/health
```

### View Knowledge Stats

```bash
curl http://localhost:3000/admin/knowledge/stats \
  -H "X-Admin-Api-Key: your-admin-key"
```

### List All Models

```bash
curl http://localhost:3000/admin/models \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Get a Token by ID

```bash
curl http://localhost:3000/admin/tokens/token_abc123 \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Update a Token

```bash
curl -X PATCH http://localhost:3000/admin/tokens/token_abc123 \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "confidence_threshold": 0.75,
    "default_model": "gpt-4-turbo"
  }'
```

### Rotate a Token

```bash
curl -X POST http://localhost:3000/admin/tokens/token_abc123/rotate \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Delete a Token

```bash
curl -X DELETE http://localhost:3000/admin/tokens/token_abc123 \
  -H "X-Admin-Api-Key: your-admin-key"
```

### User Self-Service Examples

When user self-service is enabled (`FEATURE_USER_SELF_SERVICE=true`):

#### Register a New User

```bash
curl -X POST http://localhost:3000/api/users/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

#### Complete Registration (Verify Email + Set Password)

```bash
curl -X POST http://localhost:3000/api/users/complete-registration \
  -H "Content-Type: application/json" \
  -d '{
    "token": "verification-token",
    "password": "SecurePass123!"
  }'
```

#### Login

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePass123!"
  }'
```

#### Get User Profile

```bash
curl http://localhost:3000/api/users/me \
  -H "X-Wayfinder-Token: wf_your_token_here"
```

#### Update User Profile

```bash
curl -X PATCH http://localhost:3000/api/users/me \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newemail@example.com"
  }'
```

#### List User Tokens

```bash
curl http://localhost:3000/api/tokens \
  -H "X-Wayfinder-Token: wf_your_token_here"
```

#### Create User Token

```bash
curl -X POST http://localhost:3000/api/tokens \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production API",
    "environment": "prod",
    "allowed_models": ["gpt-4o", "gemini-2.5-flash"]
  }'
```

#### Delete User Token

```bash
curl -X DELETE http://localhost:3000/api/tokens/token_xyz789 \
  -H "X-Wayfinder-Token: wf_your_token_here"
```

#### Rotate User Token

```bash
curl -X POST http://localhost:3000/api/tokens/token_xyz789/rotate \
  -H "X-Wayfinder-Token: wf_your_token_here"
```

#### Add BYOLLM API Key (paid_byollm tier only)

```bash
curl -X POST http://localhost:3000/api/llm-keys \
  -H "X-Wayfinder-Token: wf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "api_key": "sk-..."
  }'
```

#### List BYOLLM Keys

```bash
curl http://localhost:3000/api/llm-keys \
  -H "X-Wayfinder-Token: wf_your_token_here"
```

#### Validate BYOLLM Key

```bash
curl -X POST http://localhost:3000/api/llm-keys/openai/validate \
  -H "X-Wayfinder-Token: wf_your_token_here"
```

#### Delete BYOLLM Key

```bash
curl -X DELETE http://localhost:3000/api/llm-keys/openai \
  -H "X-Wayfinder-Token: wf_your_token_here"
```


## Usage Examples

### Example 1: Basic Routing

Create a token and route requests to get intelligent model selection:

```bash
# Create a basic token
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"default_model": "gpt-4o"}')

TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.token')

# Route a coding request
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a function to merge two sorted arrays"}'
```

### Example 2: Policy-Driven Routing (Production-Ready)

Use global rules to restrict model selection:

```bash
# Create token with model restrictions (recommended approach)
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "default_model": "gpt-4o",
    "allowed_models": ["gpt-4-turbo", "gemini-2.5-flash", "gemini-1.5-pro"],
    "denied_models": ["gpt-3.5-turbo"],
    "policy_rules": [
      {
        "type": "AllowModelsGlobal",
        "models": ["gpt-4-turbo", "gemini-1.5-pro"],
        "priority": 1
      }
    ]
  }'
```

**Note:** Intent-based rules (ForceModelByIntent, RestrictModelsByIntent) are currently in beta and only work with intent `"other"`. See [Policy Rule Types](#policy-rule-types) for details.

### Example 3: Learning from Feedback

Submit feedback to build knowledge consensus:

```bash
# 1. Route a request
ROUTE_RESPONSE=$(curl -s -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Summarize this article"}')

REQUEST_ID=$(echo $ROUTE_RESPONSE | jq -r '.request_id')
MODEL=$(echo $ROUTE_RESPONSE | jq -r '.selected_model')

# 2. Submit positive feedback
curl -X POST http://localhost:3000/feedback \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$REQUEST_ID\",
    \"selected_model\": \"$MODEL\",
    \"intent_label\": \"summarization\",
    \"rating\": \"positive\"
  }"

# 3. Check knowledge stats
curl http://localhost:3000/admin/knowledge/stats \
  -H "X-Admin-Api-Key: your-admin-key"
```

### Example 4: Model Restrictions

Restrict to only cost-effective models:

```bash
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "allowed_models": [
      "gpt-4o-mini",
      "gemini-1.5-flash",
      "gemini-1.5-flash"
    ],
    "default_model": "gpt-4o-mini"
  }'
```

### Example 5: Token-Scoped Knowledge (Enterprise)

Create a token with isolated knowledge for compliance or custom learning:

```bash
# Create a token with token-scoped knowledge
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "default_model": "gpt-4o",
    "knowledge_scope": "token",
    "trusted_anchor_model": "gemini-2.5-flash"
  }')

TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.token')
TOKEN_ID=$(echo $TOKEN_RESPONSE | jq -r '.id')

# This token will build its own isolated knowledge
# Feedback submitted with this token only affects this token's knowledge

# Submit feedback to build token-specific knowledge
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a Python function"}' | \
jq -r '.request_id' | \
xargs -I {} curl -X POST http://localhost:3000/feedback \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"request_id\": \"{}\", \"selected_model\": \"gpt-4o\", \"intent_label\": \"coding\", \"rating\": \"positive\"}"

# Check knowledge stats for this specific token
curl "http://localhost:3000/admin/knowledge/stats?scope=token&token_id=$TOKEN_ID" \
  -H "X-Admin-Api-Key: your-admin-key"
```

**When to use token-scoped knowledge:**
- Compliance requirements (data isolation)
- Multi-tenant applications (per-customer learning)
- Custom model preferences that shouldn't affect global knowledge
- Testing new routing strategies without polluting global data

### Example 6: User Self-Service Workflow

Register a user, create tokens, and manage LLM keys:

```bash
# Register (email-only)
REGISTER_RESPONSE=$(curl -s -X POST http://localhost:3000/api/users/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "developer@example.com"
  }')

# Complete registration (use verification token from email or debug response)
VERIFY_TOKEN=$(echo $REGISTER_RESPONSE | jq -r '.verification_token')
COMPLETE_RESPONSE=$(curl -s -X POST http://localhost:3000/api/users/complete-registration \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"${VERIFY_TOKEN}\",
    \"password\": \"SecurePass123!\"
  }")

# Extract the token from completion response
TOKEN=$(echo $COMPLETE_RESPONSE | jq -r '.token.token')

# Use the token to route a request
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum computing"}'

# Create additional tokens for different environments
curl -X POST http://localhost:3000/api/tokens \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production",
    "environment": "prod",
    "allowed_models": ["gpt-4o", "gemini-2.5-flash"]
  }'
```

### Example 7: BYOLLM Configuration

For paid BYOLLM tier users to configure their own LLM keys:

```bash
# User must be on paid_byollm tier
# Configure OpenAI key
curl -X POST http://localhost:3000/api/llm-keys \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "api_key": "sk-..."
  }'

# Configure Gemini key
curl -X POST http://localhost:3000/api/llm-keys \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gemini",
    "api_key": "AIza..."
  }'

# Validate keys against provider APIs
curl -X POST http://localhost:3000/api/llm-keys/openai/validate \
  -H "X-Wayfinder-Token: $TOKEN"

curl -X POST http://localhost:3000/api/llm-keys/gemini/validate \
  -H "X-Wayfinder-Token: $TOKEN"

# List configured keys (keys are encrypted, only metadata shown)
curl http://localhost:3000/api/llm-keys \
  -H "X-Wayfinder-Token: $TOKEN"

# Now routing requests will use YOUR keys instead of system keys
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Compare machine learning frameworks"}'
```

**BYOLLM Behavior:**
- If you have configured keys, Wayfinder uses YOUR keys for routing LLM calls
- You pay for LLM costs directly through your provider accounts
- Keys are encrypted at rest with AES-256-GCM
- Each user's keys are completely isolated
- If your keys fail, requests return errors (no fallback to system keys)

