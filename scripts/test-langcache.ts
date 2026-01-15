/**
 * LangCache Index Test Script
 *
 * This script tests if the LangCache index is properly configured.
 * Run with: npx ts-node scripts/test-langcache.ts
 */

import 'dotenv/config'; // Load .env file
import { LangCache } from '@redis-ai/langcache';
import { loadCacheConfig } from '../src/cache/config';

async function testLangCache() {
  console.log('Testing LangCache connection and index...\n');

  try {
    // Load configuration
    const config = loadCacheConfig();
    console.log('Configuration loaded:', {
      serverURL: config.serverURL,
      cacheId: config.cacheId,
      similarityThreshold: config.similarityThreshold,
      ttl: config.ttl,
    });

    // Create client
    const client = new LangCache({
      serverURL: config.serverURL,
      cacheId: config.cacheId,
      apiKey: config.apiKey,
    });

    // Test 1: Store an entry
    console.log('\n--- Test 1: Store Entry ---');
    const testPrompt = 'What is the capital of France?';
    const testResponse = JSON.stringify({
      answer: 'Paris',
      timestamp: new Date().toISOString(),
    });

    const setResult = await client.set({
      prompt: testPrompt,
      response: testResponse,
      ttlMillis: config.ttl ? config.ttl * 1000 : undefined, // Convert seconds to milliseconds
    });

    console.log('✓ Store successful:', setResult);

    // Test 2: Search for the entry (requires index)
    console.log('\n--- Test 2: Search Entry (requires index) ---');
    const searchResult = await client.search({
      prompt: testPrompt,
      searchStrategies: ['semantic' as any],
      similarityThreshold: config.similarityThreshold,
    });

    console.log('✓ Search successful:', JSON.stringify(searchResult, null, 2));

    // Verify result structure
    const data = (searchResult as any)?.data;
    if (data && Array.isArray(data) && data.length > 0) {
      console.log('\n✓ Index is working! Found', data.length, 'result(s)');
      console.log('  - Similarity:', data[0].similarity);
      console.log('  - Strategy:', data[0].searchStrategy);
    } else {
      console.log('\n⚠ No results found, but search didn\'t error (index exists but empty)');
    }

    console.log('\n✅ All tests passed! LangCache is properly configured.');

  } catch (error) {
    console.error('\n❌ Error:', error);

    if (error instanceof Error && error.message.includes('424')) {
      console.error(`
⚠️  Index Not Found (424 error)

This means the LangCache semantic index hasn't been created yet.

Fix:
1. Log into Redis Cloud: https://cloud.redis.io/
2. Navigate to LangCache
3. Find your cache instance
4. Create/Initialize the semantic search index
5. Wait a few moments for index creation to complete
6. Run this test again
      `);
    } else if (error instanceof Error && error.message.includes('401')) {
      console.error(`
⚠️  Authentication Error (401)

Your API key is invalid or expired.

Fix:
1. Verify LANGCACHE_API_KEY in your .env file
2. Check that it matches the API key in Redis Cloud console
      `);
    } else if (error instanceof Error && error.message.includes('404')) {
      console.error(`
⚠️  Cache Not Found (404)

Your cache ID is incorrect or the cache doesn't exist.

Fix:
1. Verify LANGCACHE_CACHE_ID in your .env file
2. Check that it matches the cache ID in Redis Cloud console
3. Ensure LANGCACHE_HOST is correct
      `);
    }

    process.exit(1);
  }
}

// Run test
testLangCache();
