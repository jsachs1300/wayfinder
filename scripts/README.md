# Wayfinder Scripts

Utility scripts for managing and operating Wayfinder.

## warm-cache.sh

Pre-populate the semantic cache with common prompts to improve response times.

### Usage

```bash
# Using command line arguments
./scripts/warm-cache.sh --token YOUR_WAYFINDER_TOKEN

# Using environment variables
export WF_TOKEN=YOUR_WAYFINDER_TOKEN
./scripts/warm-cache.sh

# Custom API URL
./scripts/warm-cache.sh --token YOUR_TOKEN --url https://api.wayfinder.ai
```

### Options

- `-t, --token TOKEN` - Wayfinder API token (required)
- `-u, --url URL` - Wayfinder API URL (default: `http://localhost:3000`)
- `-h, --help` - Show help message

### Environment Variables

- `WF_TOKEN` - Alternative to `--token` flag
- `WF_URL` - Alternative to `--url` flag (default: `http://localhost:3000`)

### What It Does

The script sends 20 diverse prompts to your Wayfinder instance, covering common use cases:

- **Code generation** - Python, React, SQL, Node.js
- **Data analysis** - CSV processing, statistics, pandas
- **Writing tasks** - Emails, blog posts, product descriptions
- **Math & reasoning** - Equations, explanations, calculations
- **Summarization** - Research papers, meeting notes
- **Translation** - Language conversion
- **Creative writing** - Story generation
- **Debugging** - Code troubleshooting
- **Documentation** - API docs
- **Research** - Technical explanations

Each prompt is semantically distinct (similarity < 0.9) to maximize cache coverage while representing real user queries.

### Example Output

```
═══════════════════════════════════════════════════
   Wayfinder Cache Warming Script
═══════════════════════════════════════════════════

API URL:  http://localhost:3000
Token:    abc12345...
Prompts:  20

Starting cache warming...

[1/20] Processing: Write a Python function to sort a list of dictionaries...
  ✓ Success → gpt-4-turbo
[2/20] Processing: Create a React component for a user login form...
  ✓ Success → claude-3-5-sonnet
...

═══════════════════════════════════════════════════
   Cache Warming Complete
═══════════════════════════════════════════════════

Total Requests:  20
Successful:      20
Failed:          0
Cache Hits:      0

✓ All prompts cached successfully!
```

### When to Use

- **After deploying** - Warm cache after clearing or deploying new version
- **Performance testing** - Pre-populate cache before load testing
- **Demo preparation** - Ensure fast responses during demos
- **Development** - Populate local cache for testing cache behavior

### Cache TTL

Cached entries expire based on your `LANGCACHE_TTL` configuration (default: 3600 seconds / 1 hour). Re-run this script periodically if needed.
