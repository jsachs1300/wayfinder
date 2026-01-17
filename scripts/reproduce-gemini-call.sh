#!/usr/bin/env bash
set -euo pipefail

# Reproduce the Gemini router LLM call (generateContent API)

: "${GEMINI_API_KEY:=${ROUTER_LLM_GEMINI_API_KEY:-}}"
: "${GEMINI_API_KEY:?Set GEMINI_API_KEY or ROUTER_LLM_GEMINI_API_KEY}"

export GEMINI_MODEL="${GEMINI_MODEL:-${ROUTER_LLM_GEMINI_MODEL:-gemini-1.5-flash}}"
export TEMPERATURE="${TEMPERATURE:-${ROUTER_LLM_TEMPERATURE:-0.2}}"
export MAX_TOKENS="${MAX_TOKENS:-${ROUTER_LLM_MAX_TOKENS:-512}}"
export TIMEOUT_MS="${TIMEOUT_MS:-${ROUTER_LLM_TIMEOUT:-15000}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export PROMPT="$(node -r ts-node/register "$REPO_ROOT/scripts/build-router-prompt.ts")"

BODY="$(python3 - <<'PY'
import json, os

payload = {
    "contents": [
        {
            "parts": [
                {"text": os.environ["PROMPT"]},
            ],
        },
    ],
    "generationConfig": {
        "temperature": float(os.environ["TEMPERATURE"]),
        "maxOutputTokens": int(os.environ["MAX_TOKENS"]),
        "responseMimeType": "application/json",
    },
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
  -X POST "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: ${GEMINI_API_KEY}" \
  -d "$BODY"
