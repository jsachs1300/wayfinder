#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INTEGRATION_ENV_FILE=".env.local.integration"
SECRETS_ENV_FILE=".env.local.secrets"

load_env_file() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    echo "[ERROR] Missing required file: $env_file"
    return 1
  fi
  # shellcheck disable=SC1090
  set -a; source "$env_file"; set +a
}

require_var() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "[ERROR] Missing required env var: $var_name"
    return 1
  fi
}

echo "[INFO] Loading local integration env files..."
load_env_file "$INTEGRATION_ENV_FILE"
load_env_file "$SECRETS_ENV_FILE"

echo "[INFO] Validating required configuration..."
require_var ADMIN_API_KEY
require_var REDIS_URL
require_var ROUTER_LLM_OPENAI_MODEL
require_var ROUTER_LLM_GEMINI_MODEL

if [[ "${ROUTER_LLM_OPENAI_ENABLED:-false}" == "true" ]]; then
  require_var ROUTER_LLM_OPENAI_API_KEY
fi

if [[ "${ROUTER_LLM_GEMINI_ENABLED:-false}" == "true" ]]; then
  require_var ROUTER_LLM_GEMINI_API_KEY
fi

if [[ "${LANGCACHE_ENABLED:-false}" == "true" || "${LANGCACHE_INTEGRATION_TEST:-false}" == "true" ]]; then
  require_var LANGCACHE_HOST
  require_var LANGCACHE_CACHE_ID
  require_var LANGCACHE_API_KEY
fi

if [[ "${FEATURE_USER_SELF_SERVICE:-false}" == "true" ]]; then
  require_var LLM_KEY_ENCRYPTION_KEY
fi

if [[ ! "${REDIS_URL}" =~ ^redis(s)?:// ]]; then
  echo "[ERROR] REDIS_URL must start with redis:// or rediss://"
  exit 1
fi

if [[ -n "${LLM_KEY_ENCRYPTION_KEY:-}" && ! "${LLM_KEY_ENCRYPTION_KEY}" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  echo "[ERROR] LLM_KEY_ENCRYPTION_KEY must be exactly 64 hex characters"
  exit 1
fi

if [[ "${LANGCACHE_INTEGRATION_TEST:-false}" != "true" ]]; then
  echo "[WARN] LANGCACHE_INTEGRATION_TEST is not true. Real LangCache integration suite will be skipped."
fi

echo "[INFO] Pinging Redis at ${REDIS_URL}..."
node -e '
const Redis = require("ioredis");
const url = process.env.REDIS_URL;
const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000 });
(async () => {
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== "PONG") {
      throw new Error(`Unexpected ping response: ${pong}`);
    }
    console.log("[OK] Redis ping succeeded");
  } catch (error) {
    console.error("[ERROR] Redis connectivity check failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    try { await client.quit(); } catch { client.disconnect(); }
  }
})();'

echo "[OK] Local full-integration environment validation passed."
