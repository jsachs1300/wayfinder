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

  it('should load default configuration when only API keys are provided', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';

    const config = loadRouterLLMConfig();

    expect(config).toEqual({
      openai: {
        enabled: true,
        apiKey: 'test-openai-key',
        model: 'gpt-4o-mini',
      },
      gemini: {
        enabled: true,
        apiKey: 'test-gemini-key',
        model: 'gemini-1.5-flash',
      },
      timeout: 30000,
      maxRetries: 2,
      temperature: 0.0,
      maxTokens: 2000,
    });
  });

  it('should load custom model configuration', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_OPENAI_MODEL = 'gpt-4';
    process.env.ROUTER_LLM_GEMINI_MODEL = 'gemini-1.5-pro';

    const config = loadRouterLLMConfig();

    expect(config.openai.model).toBe('gpt-4');
    expect(config.gemini.model).toBe('gemini-1.5-pro');
  });

  it('should load custom numeric configuration', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
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

  it('should throw error when OpenAI API key is missing', () => {
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    delete process.env.ROUTER_LLM_OPENAI_API_KEY;

    expect(() => loadRouterLLMConfig()).toThrow(
      'ROUTER_LLM_OPENAI_API_KEY environment variable is required'
    );
  });

  it('should throw error when Gemini API key is missing', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    delete process.env.ROUTER_LLM_GEMINI_API_KEY;

    expect(() => loadRouterLLMConfig()).toThrow(
      'ROUTER_LLM_GEMINI_API_KEY environment variable is required'
    );
  });

  it('should throw error for invalid timeout', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_TIMEOUT = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TIMEOUT: must be a positive number'
    );
  });

  it('should throw error for negative timeout', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_TIMEOUT = '-1000';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TIMEOUT: must be a positive number'
    );
  });

  it('should throw error for invalid maxRetries', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_MAX_RETRIES = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_MAX_RETRIES: must be a non-negative number'
    );
  });

  it('should throw error for negative maxRetries', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_MAX_RETRIES = '-1';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_MAX_RETRIES: must be a non-negative number'
    );
  });

  it('should throw error for invalid temperature', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_TEMPERATURE = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TEMPERATURE: must be between 0 and 2'
    );
  });

  it('should throw error for temperature outside valid range', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_TEMPERATURE = '3.0';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_TEMPERATURE: must be between 0 and 2'
    );
  });

  it('should throw error for invalid maxTokens', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_MAX_TOKENS = 'invalid';

    expect(() => loadRouterLLMConfig()).toThrow(
      'Invalid ROUTER_LLM_MAX_TOKENS: must be a positive number'
    );
  });

  it('should allow zero maxRetries', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_MAX_RETRIES = '0';

    const config = loadRouterLLMConfig();

    expect(config.maxRetries).toBe(0);
  });

  it('should handle temperature at boundaries', () => {
    process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
    process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
    process.env.ROUTER_LLM_TEMPERATURE = '2.0';

    const config = loadRouterLLMConfig();

    expect(config.temperature).toBe(2.0);
  });

  describe('Provider enable/disable functionality', () => {
    it('should allow only OpenAI enabled', () => {
      process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'true';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'false';

      const config = loadRouterLLMConfig();

      expect(config.openai.enabled).toBe(true);
      expect(config.openai.apiKey).toBe('test-openai-key');
      expect(config.gemini.enabled).toBe(false);
    });

    it('should allow only Gemini enabled', () => {
      process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'false';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'true';

      const config = loadRouterLLMConfig();

      expect(config.openai.enabled).toBe(false);
      expect(config.gemini.enabled).toBe(true);
      expect(config.gemini.apiKey).toBe('test-gemini-key');
    });

    it('should allow both providers enabled', () => {
      process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
      process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'true';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'true';

      const config = loadRouterLLMConfig();

      expect(config.openai.enabled).toBe(true);
      expect(config.gemini.enabled).toBe(true);
    });

    it('should throw error when both providers disabled', () => {
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'false';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'false';

      expect(() => loadRouterLLMConfig()).toThrow(
        'At least one router LLM provider must be enabled'
      );
    });

    it('should throw error when OpenAI enabled but API key missing', () => {
      process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'true';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'true';
      delete process.env.ROUTER_LLM_OPENAI_API_KEY;

      expect(() => loadRouterLLMConfig()).toThrow(
        'ROUTER_LLM_OPENAI_API_KEY environment variable is required when OpenAI is enabled'
      );
    });

    it('should throw error when Gemini enabled but API key missing', () => {
      process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'true';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'true';
      delete process.env.ROUTER_LLM_GEMINI_API_KEY;

      expect(() => loadRouterLLMConfig()).toThrow(
        'ROUTER_LLM_GEMINI_API_KEY environment variable is required when Gemini is enabled'
      );
    });

    it('should not require OpenAI API key when OpenAI is disabled', () => {
      process.env.ROUTER_LLM_GEMINI_API_KEY = 'test-gemini-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'false';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'true';
      delete process.env.ROUTER_LLM_OPENAI_API_KEY;

      const config = loadRouterLLMConfig();

      expect(config.openai.enabled).toBe(false);
      expect(config.openai.apiKey).toBeUndefined();
      expect(config.gemini.enabled).toBe(true);
    });

    it('should not require Gemini API key when Gemini is disabled', () => {
      process.env.ROUTER_LLM_OPENAI_API_KEY = 'test-openai-key';
      process.env.ROUTER_LLM_OPENAI_ENABLED = 'true';
      process.env.ROUTER_LLM_GEMINI_ENABLED = 'false';
      delete process.env.ROUTER_LLM_GEMINI_API_KEY;

      const config = loadRouterLLMConfig();

      expect(config.openai.enabled).toBe(true);
      expect(config.gemini.enabled).toBe(false);
      expect(config.gemini.apiKey).toBeUndefined();
    });
  });
});
