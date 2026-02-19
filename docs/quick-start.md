# Quick Start

_Extracted from the previous README. This page contains getting-started and local dev setup details._

## Quick Start

Get Wayfinder running in 4 steps:

```bash
# 1. Clone and install
git clone <repository-url>
cd wayfinder
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and configure:
#   - ADMIN_API_KEY
#   - ROUTER_LLM_OPENAI_ENABLED=true and ROUTER_LLM_OPENAI_API_KEY
#   - LANGCACHE_ENABLED=true and LangCache credentials

# 3. Run the server
npm run dev
```

The system requires at least one router LLM provider and LangCache to be configured for production. See [Router LLM Setup](#router-llm-setup-required) and [Semantic Caching](#semantic-caching-required) below. For development/testing, set `NODE_ENV=development` to bypass these requirements.

### Option A: Admin Token Flow (Traditional)

Create a token via admin API and use it for routing:

```bash
# Create a token (save the returned token value)
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"default_model": "gpt-4o"}'

# Use the token to route a request
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: wf_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a function to reverse a string"}'
```

### Option B: User Self-Service Flow (New)

If user self-service features are enabled (`FEATURE_USER_SELF_SERVICE=true`), users can register and manage their own tokens:

```bash
# Register with email only (verification link is sent)
curl -X POST http://localhost:3000/api/users/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'

# Complete registration after verification to set a password
curl -X POST http://localhost:3000/api/users/complete-registration \
  -H "Content-Type: application/json" \
  -d '{
    "token": "verification-token",
    "password": "SecurePass123!"
  }'

# The response includes a token you can use immediately
# Use the token to route requests
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: wf_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a function to reverse a string"}'
```

Response:
```json
{
  "primary": {
    "model": "gpt-4-turbo",
    "score": 8.2,
    "reason": "Excellent for coding tasks with strong reasoning capabilities"
  },
  "alternate": {
    "model": "gemini-2.5-flash",
    "score": 7.8,
    "reason": "Alternative with comparable coding ability and different strengths"
  },
  "request_id": "req_a1b2c3d4-e5f6-7890",
  "router_model_used": "consensus",
  "from_cache": false
}
```


## Local Development

### Prerequisites

- Node.js 18+
- Redis (optional, falls back to in-memory store)
- Docker & docker-compose (optional)

### Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings
# At minimum, set ADMIN_API_KEY

# Run in development mode
npm run dev

# Or with Docker
docker-compose -f docker-compose.dev.yml up
```

### Running Tests

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Building for Production

```bash
# Build TypeScript
npm run build

# Run production build
npm start

# Or with Docker
docker-compose up --build
```

