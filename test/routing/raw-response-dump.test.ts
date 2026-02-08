import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { dumpRawRouterResponse } from '../../src/routing/router-llm/raw-response-dump';

describe('dumpRawRouterResponse', () => {
  afterEach(() => {
    delete process.env.ROUTER_LLM_RAW_RESPONSE_DUMP_DIR;
  });

  it('returns undefined when dump directory is not configured', async () => {
    const result = await dumpRawRouterResponse({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      rawResponse: '{"ranked_models":[]}',
      parseError: 'Unexpected end of JSON input',
      inputTokens: 12,
      outputTokens: 40,
    });

    expect(result).toBeUndefined();
  });

  it('writes raw parse payload to disk when dump directory is configured', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wayfinder-raw-dump-'));
    process.env.ROUTER_LLM_RAW_RESPONSE_DUMP_DIR = tempDir;

    try {
      const dumpPath = await dumpRawRouterResponse({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        rawResponse: '{"truncated":"value',
        parseError: 'Unterminated string in JSON at position 19',
        inputTokens: 24,
        outputTokens: 57,
      });

      expect(dumpPath).toBeDefined();
      const content = await readFile(dumpPath!, 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;

      expect(parsed.provider).toBe('gemini');
      expect(parsed.model).toBe('gemini-2.5-flash');
      expect(parsed.raw_response).toBe('{"truncated":"value');
      expect(parsed.parse_error).toContain('Unterminated string');
      expect(parsed.response_length).toBe('{"truncated":"value'.length);
      expect(parsed.input_tokens).toBe(24);
      expect(parsed.output_tokens).toBe(57);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
