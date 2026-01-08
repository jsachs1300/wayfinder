#!/bin/bash

# Warm Cache Script - Pre-populate semantic cache with common prompts
#
# Usage:
#   ./scripts/warm-cache.sh [OPTIONS]
#
# Options:
#   -t, --token TOKEN      Wayfinder API token (required, or set WF_TOKEN env var)
#   -u, --url URL          Wayfinder API URL (default: http://localhost:3000)
#   -h, --help            Show this help message
#
# Examples:
#   ./scripts/warm-cache.sh --token abc123
#   WF_TOKEN=abc123 ./scripts/warm-cache.sh --url https://api.wayfinder.ai

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
WF_URL="${WF_URL:-http://localhost:3000}"
WF_TOKEN="${WF_TOKEN:-}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--token)
      WF_TOKEN="$2"
      shift 2
      ;;
    -u|--url)
      WF_URL="$2"
      shift 2
      ;;
    -h|--help)
      echo "Warm Cache Script - Pre-populate semantic cache with common prompts"
      echo ""
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  -t, --token TOKEN    Wayfinder API token (required)"
      echo "  -u, --url URL        Wayfinder API URL (default: http://localhost:3000)"
      echo "  -h, --help          Show this help message"
      echo ""
      echo "Environment Variables:"
      echo "  WF_TOKEN            Alternative to --token flag"
      echo "  WF_URL              Alternative to --url flag"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Validate token
if [ -z "$WF_TOKEN" ]; then
  echo -e "${RED}Error: Wayfinder token is required${NC}"
  echo "Usage: $0 --token YOUR_TOKEN"
  echo "Or set WF_TOKEN environment variable"
  exit 1
fi

# Array of diverse prompts covering common use cases
# These prompts are semantically distinct (similarity < 0.9) but representative of real usage
declare -a PROMPTS=(
  # Code generation (different languages)
  "Write a Python function to sort a list of dictionaries by a specific key"
  "Create a React component for a user login form with validation"
  "Generate SQL query to find top 10 customers by total purchase amount"
  "Build a REST API endpoint in Node.js for creating new users"

  # Data analysis
  "Analyze this CSV file and identify trends in the sales data"
  "Calculate the correlation between temperature and ice cream sales"
  "Create a pandas DataFrame to clean and transform customer data"

  # Writing and content
  "Write a professional email to request a project deadline extension"
  "Draft a blog post about the benefits of remote work"
  "Compose a product description for a wireless noise-canceling headphone"

  # Math and reasoning
  "Solve this differential equation: dy/dx = 2x + 3"
  "Explain the concept of P vs NP problem in simple terms"
  "Calculate the compound interest on $10,000 invested at 5% annually for 10 years"

  # Summarization and extraction
  "Summarize this research paper on climate change in 3 bullet points"
  "Extract the main action items from this meeting transcript"

  # Translation and language
  "Translate this paragraph from English to Spanish maintaining formal tone"

  # Creative writing
  "Generate a short story about a robot learning to feel emotions"

  # Debugging and troubleshooting
  "Debug this JavaScript code that's causing a memory leak"

  # Documentation
  "Write API documentation for a payment processing endpoint"

  # Research and information
  "Explain how HTTPS encryption works at a high level"
)

echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   Wayfinder Cache Warming Script${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "API URL:  ${YELLOW}${WF_URL}${NC}"
echo -e "Token:    ${YELLOW}${WF_TOKEN:0:8}...${NC}"
echo -e "Prompts:  ${YELLOW}${#PROMPTS[@]}${NC}"
echo ""

# Track statistics
TOTAL=${#PROMPTS[@]}
SUCCESS=0
FAILED=0
CACHE_HITS=0

echo -e "${BLUE}Starting cache warming...${NC}"
echo ""

# Loop through prompts and make requests
for i in "${!PROMPTS[@]}"; do
  PROMPT="${PROMPTS[$i]}"
  NUM=$((i + 1))

  echo -e "${YELLOW}[$NUM/$TOTAL]${NC} Processing: ${PROMPT:0:60}..."

  # Make the request and capture response
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${WF_URL}/" \
    -H "Content-Type: application/json" \
    -H "X-Wayfinder-Token: ${WF_TOKEN}" \
    -d "{\"prompt\": $(echo "$PROMPT" | jq -Rs .)}" 2>&1)

  # Extract HTTP status code (last line)
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    SUCCESS=$((SUCCESS + 1))

    # Check if this was a cache hit
    CACHE_HIT=$(echo "$BODY" | jq -r '.cache_hit // false')
    if [ "$CACHE_HIT" = "true" ]; then
      CACHE_HITS=$((CACHE_HITS + 1))
      echo -e "  ${GREEN}✓ Success${NC} (cache hit)"
    else
      # Extract primary model for interesting output
      PRIMARY_MODEL=$(echo "$BODY" | jq -r '.primary.model // "unknown"')
      echo -e "  ${GREEN}✓ Success${NC} → ${PRIMARY_MODEL}"
    fi
  else
    FAILED=$((FAILED + 1))
    ERROR_MSG=$(echo "$BODY" | jq -r '.message // .error // "Unknown error"')
    echo -e "  ${RED}✗ Failed${NC} (HTTP $HTTP_CODE): $ERROR_MSG"
  fi

  # Small delay to avoid overwhelming the server
  sleep 0.5
done

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   Cache Warming Complete${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "Total Requests:  ${YELLOW}${TOTAL}${NC}"
echo -e "Successful:      ${GREEN}${SUCCESS}${NC}"
echo -e "Failed:          ${RED}${FAILED}${NC}"
echo -e "Cache Hits:      ${BLUE}${CACHE_HITS}${NC}"
echo ""

if [ $SUCCESS -eq $TOTAL ]; then
  echo -e "${GREEN}✓ All prompts cached successfully!${NC}"
  exit 0
elif [ $SUCCESS -gt 0 ]; then
  echo -e "${YELLOW}⚠ Some prompts failed to cache${NC}"
  exit 1
else
  echo -e "${RED}✗ Cache warming failed${NC}"
  exit 1
fi
