/**
 * Tests for Router LLM Configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadRouterLLMConfig } from '../../src/routing/config';

describe('loadRouterLLMConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it('should load default configuration when only API key is provided', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';

    const config = loadRouterLLMConfig();

    expect(config).toEqual({
      provider: 'openai',
      apiKey: 'test-api-key',
      model: 'gpt-4o-mini',
      timeout: 10000,
      maxRetries: 2,
      temperature: 0.0,
      maxTokens: 500,
    });
  });

  it('should load custom provider configuration', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_PROVIDER = 'anthropic';
    process.env.ROUTER_LLM_MODEL = 'claude-3-opus-20240229';

    const config = loadRouterLLMConfig();

    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-3-opus-20240229');
  });

  it('should load custom numeric configuration', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_TIMEOUT = '5000';
    process.env.ROUTER_LLM_MAX_RETRIES = '3';
    process.env.ROUTER_LLM_TEMPERATURE = '0.5';
    process.env.ROUTER_LLM_MAX_TOKENS = '1000';

    const config = loadRouterLLMConfig();

    expect(config.timeout).toBe(5000);
    expect(config.maxRetries).toBe(3);
    expect(config.temperature).toBe(0.5);
    expect(config.maxTokens).toBe(1000);
  });

  it('should throw error when API key is missing', () => {
    delete process.env.ROUTER_LLM_API_KEY;

    expect(() => loadRouterLLMConfig()).toThrow(
      'ROUTER_LLM_API_KEY environment variable is required'
    );
  });

  it('should throw error for invalid provider', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_PROVIDER = 'invalid-provider';

    expect(() => loadRouterLLMConfig()).toThrow(
      "Invalid ROUTER_LLM_PROVIDER: invalid-provider. Must be 'openai' or 'anthropic'"
    );
  });

  it('should throw error for invalid timeout', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_TIMEOUT = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TIMEOUT: must be a positive number'
    );
  });

  it('should throw error for negative timeout', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_TIMEOUT = '-1000';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TIMEOUT: must be a positive number'
    );
  });

  it('should throw error for invalid maxRetries', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_MAX_RETRIES = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_MAX_RETRIES: must be a non-negative number'
    );
  });

  it('should throw error for negative maxRetries', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_MAX_RETRIES = '-1';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_MAX_RETRIES: must be a non-negative number'
    );
  });

  it('should throw error for invalid temperature', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_TEMPERATURE = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TEMPERATURE: must be between 0 and 2'
    );
  });

  it('should throw error for temperature outside valid range', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_TEMPERATURE = '3.0';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TEMPERATURE: must be between 0 and 2'
    );
  });

  it('should throw error for invalid maxTokens', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_MAX_TOKENS = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_MAX_TOKENS: must be a positive number'
    );
  });

  it('should allow zero maxRetries', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_MAX_RETRIES = '0';

    const config = loadRouterLLMConfig();

    expect(config.maxRetries).toBe(0);
  });

  it('should handle temperature at boundaries', () => {
    process.env.ROUTER_LLM_API_KEY = 'test-api-key';
    process.env.ROUTER_LLM_TEMPERATURE = '2.0';

    const config = loadRouterLLMConfig();

    expect(config.temperature).toBe(2.0);
  });
});
