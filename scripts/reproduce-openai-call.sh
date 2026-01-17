#!/usr/bin/env bash
set -euo pipefail

source .env.backup
# Reproduce the OpenAI router LLM call (Chat Completions API)

: "${OPENAI_API_KEY:=${ROUTER_LLM_OPENAI_API_KEY:-}}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY or ROUTER_LLM_OPENAI_API_KEY}"

#OPENAI_MODEL="${OPENAI_MODEL:-${ROUTER_LLM_OPENAI_MODEL:-gpt-4o-mini}}"
export OPENAI_MODEL="gpt-4-turbo"
export TEMPERATURE="${TEMPERATURE:-${ROUTER_LLM_TEMPERATURE:-0.2}}"
export MAX_TOKENS="${MAX_TOKENS:-${ROUTER_LLM_MAX_TOKENS:-512}}"
export TIMEOUT_MS="${TIMEOUT_MS:-${ROUTER_LLM_TIMEOUT:-15000}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export PROMPT="$(node -r ts-node/register "$REPO_ROOT/scripts/build-router-prompt.ts")"

BODY="$(python3 - <<'PY'
import json, os

payload = {
    "model": os.environ["OPENAI_MODEL"],
    "messages": [
        {"role": "user", "content": os.environ["PROMPT"]},
    ],
    "temperature": float(os.environ["TEMPERATURE"]),
    "max_tokens": int(os.environ["MAX_TOKENS"]),
    "response_format": {"type": "json_object"},
}

print(json.dumps(payload, ensure_ascii=True))
PY
)"

MAX_TIME_SECONDS="$(python3 - <<'PY'
import os
ms = int(os.environ["TIMEOUT_MS"])
print(max(ms / 1000.0, 1))
PY
)"

curl -sS --max-time "$MAX_TIME_SECONDS" \
  -X POST "https://api.openai.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -d "$BODY"
