# LangCache Testing Guide

This directory contains tests for the LangCache semantic caching integration.

## Test Files

- **`semantic-cache.test.ts`** - Unit tests with mocked LangCache client
- **`langcache-integration.test.ts`** - Integration tests (mock + optional real LangCache)
- **`config.test.ts`** - Configuration loading and validation tests

## Running Tests

### Run All Cache Tests (Mock Mode)

```bash
npm test test/cache
```

This runs all cache tests with mocked LangCache client. **Fast and safe** for CI/CD pipelines.

### Run Integration Tests Against Real LangCache

To test against a real LangCache instance:

1. **Ensure LangCache credentials are in `.env`**:
   ```bash
   LANGCACHE_ENABLED=true
   LANGCACHE_HOST=aws-us-east-1.langcache.redis.io
   LANGCACHE_CACHE_ID=your-cache-id
   LANGCACHE_API_KEY=your-api-key
   LANGCACHE_SIMILARITY_THRESHOLD=0.75
   LANGCACHE_TTL=86400
   LANGCACHE_TIMEOUT_MS=5000
   ```

2. **Run integration tests**:
   ```bash
   npm run test:cache:integration
   ```

   Or manually:
   ```bash
   LANGCACHE_INTEGRATION_TEST=true npm test test/cache/langcache-integration.test.ts
   ```

**Warning**: Integration tests make real API calls to LangCache and will create/delete cache entries.

## What the Tests Cover

### Unit Tests (Mock Mode)

✅ **Timeout Configuration**
- Verifies timeout is passed to all LangCache operations
- Tests custom timeout configuration
- Validates graceful timeout handling

✅ **TTL Conversion**
- Ensures TTL converts from seconds to milliseconds
- Tests undefined TTL handling
- Validates large TTL values

✅ **Error Handling**
- 401 Authentication errors (invalid API key)
- 424 Index Not Found errors (index not created)
- Network errors and timeouts
- Graceful degradation (cache failures don't block routing)

✅ **Performance**
- Large payloads (14 models, multiple providers)
- Large prompts (10KB edge case)
- JSON stringify/parse performance

✅ **Configuration Validation**
- Required environment variables
- Optional variables and defaults
- Similarity threshold range (0.0 - 1.0)
- TTL and timeout validation
- Server URL normalization (https:// prefix)

✅ **Cache Statistics**
- Hit/miss tracking
- Store operation tracking
- Hit rate calculation

### Integration Tests (Real LangCache)

These tests only run when `LANGCACHE_INTEGRATION_TEST=true`:

✅ **Real API Connection**
- Connect to actual LangCache service
- Store and retrieve real cache entries
- Verify semantic matching works

✅ **Timeout Enforcement**
- Test real timeout behavior with short timeouts
- Verify graceful degradation on slow responses

## Common Issues and Solutions

### Issue: Tests fail with "LANGCACHE_HOST environment variable is required"

**Solution**: Set LangCache credentials in `.env` file (even for mock tests, config validation runs):

```bash
cp .env.example .env
# Edit .env and set LANGCACHE_* variables
```

### Issue: Integration tests timeout or fail with 424 errors

**Cause**: LangCache index not created or still warming up.

**Solution**:
1. Log into [Redis Cloud Console](https://cloud.redis.io/)
2. Navigate to LangCache
3. Verify index exists and is ready
4. If newly created, wait 1-2 minutes for indexing

### Issue: Integration tests fail with 401 Authentication Failed

**Cause**: Invalid or malformed API key in `.env`.

**Solution**:
1. Check for whitespace in `LANGCACHE_API_KEY` (common issue)
2. Regenerate API key from Redis Cloud console
3. Ensure entire key is on single line (no line breaks)

### Issue: Tests are slow (19+ seconds)

**Cause**: Missing timeout configuration or slow LangCache service.

**Solution**:
1. Set `LANGCACHE_TIMEOUT_MS=5000` in `.env`
2. Check network latency to LangCache region
3. Consider reducing timeout for faster failure: `LANGCACHE_TIMEOUT_MS=3000`

## Test Development Tips

### Writing New Cache Tests

1. **Use mock mode by default** - Fast and reliable
2. **Add integration tests sparingly** - Only for critical paths
3. **Test error paths** - Cache failures should never block routing
4. **Test timeouts explicitly** - Use `mockRejectedValue` to simulate timeouts

### Example: Testing Timeout Behavior

```typescript
it('should timeout gracefully', async () => {
  mockLangCacheClient.search.mockRejectedValue(
    new Error('Request timed out after 5000ms')
  );

  const result = await cache.get('test');

  expect(result).toBeNull(); // Graceful degradation
});
```

### Example: Testing Large Payloads

```typescript
it('should handle 14 models (real-world size)', async () => {
  const largeDecision = buildLargeDecision(14);
  const cachedResponse = buildCachedResponse(largeDecision, 'test');

  await cache.set('test', cachedResponse);

  // Verify no errors on large payload
});
```

## CI/CD Integration

### GitHub Actions / CI Pipeline

```yaml
# .github/workflows/test.yml
- name: Run cache tests (mock mode)
  run: npm test test/cache

# Optional: Run integration tests on main branch only
- name: Run cache integration tests
  if: github.ref == 'refs/heads/main'
  env:
    LANGCACHE_INTEGRATION_TEST: true
    LANGCACHE_HOST: ${{ secrets.LANGCACHE_HOST }}
    LANGCACHE_CACHE_ID: ${{ secrets.LANGCACHE_CACHE_ID }}
    LANGCACHE_API_KEY: ${{ secrets.LANGCACHE_API_KEY }}
  run: npm run test:cache:integration
```

### Pre-commit Hook

Add to `.git/hooks/pre-commit`:

```bash
#!/bin/bash
npm test test/cache
```

## Debugging Tips

### Enable Verbose Logging

The tests suppress console.log by default. To see timing instrumentation:

```typescript
// Comment out in beforeEach():
// consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

// Run tests - you'll see:
// [2026-01-15T...] LangCache search() STARTED
// [2026-01-15T...] LangCache search() COMPLETED in XXXms
```

### Inspect Mock Calls

```typescript
// See all calls to search()
console.log(mockLangCacheClient.search.mock.calls);

// See specific call arguments
console.log(mockLangCacheClient.search.mock.calls[0][0]); // First arg
console.log(mockLangCacheClient.search.mock.calls[0][1]); // Second arg (options)
```

### Test Individual Files

```bash
# Run only config tests
npm test test/cache/config.test.ts

# Run only integration tests
npm test test/cache/langcache-integration.test.ts

# Run with watch mode
npm test test/cache -- --watch
```

## Performance Benchmarks

Expected test execution times:

- **Mock tests**: < 100ms total
- **Config tests**: < 50ms total
- **Integration tests (real)**: 5-15 seconds total

If tests are slower, check:
1. Network latency to LangCache
2. LangCache index status (warming up?)
3. Timeout configuration (too high?)

## Troubleshooting

### All tests fail immediately

Check:
- ✅ `.env` file exists
- ✅ Required env vars set (LANGCACHE_HOST, etc.)
- ✅ Dependencies installed (`npm install`)

### Integration tests fail, mock tests pass

Check:
- ✅ API key is valid (no whitespace)
- ✅ Cache index exists in Redis Cloud
- ✅ Network connectivity to LangCache host
- ✅ Timeout is sufficient for your network

### Tests pass but app fails

Check:
- ✅ Same `.env` used for app and tests
- ✅ Cache initialized in app (`LANGCACHE_ENABLED=true`)
- ✅ App has same timeout config as tests

## Resources

- [LangCache Documentation](https://redis.io/docs/latest/develop/ai/langcache/)
- [LangCache API Examples](https://redis.io/docs/latest/develop/ai/langcache/api-examples/)
- [Redis Cloud Console](https://cloud.redis.io/)
- [Vitest Documentation](https://vitest.dev/)
