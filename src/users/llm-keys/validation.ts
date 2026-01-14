/**
 * LLM API Key Validation
 *
 * Validates API key format for different LLM providers.
 * Optionally can validate keys against provider APIs.
 */

import type { LLMProvider } from './types';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate OpenAI API key format
 *
 * OpenAI keys follow the pattern:
 * - sk-... (secret key)
 * - sk-proj-... (project key)
 *
 * @param apiKey - API key to validate
 * @returns Validation result
 */
export function validateOpenAIKeyFormat(apiKey: string): ValidationResult {
  if (!apiKey || typeof apiKey !== 'string') {
    return { valid: false, error: 'API key is required' };
  }

  if (apiKey.trim() !== apiKey) {
    return { valid: false, error: 'API key contains leading or trailing whitespace' };
  }

  // OpenAI keys start with 'sk-' (legacy) or 'sk-proj-' (project keys)
  if (!apiKey.startsWith('sk-')) {
    return { valid: false, error: 'OpenAI API key must start with sk-' };
  }

  // Minimum length check (OpenAI keys are typically 50+ characters)
  if (apiKey.length < 20) {
    return { valid: false, error: 'OpenAI API key is too short' };
  }

  // Maximum length check (prevent DOS)
  if (apiKey.length > 200) {
    return { valid: false, error: 'OpenAI API key is too long' };
  }

  return { valid: true };
}

/**
 * Validate Gemini API key format
 *
 * Gemini keys are typically alphanumeric strings around 39 characters
 *
 * @param apiKey - API key to validate
 * @returns Validation result
 */
export function validateGeminiKeyFormat(apiKey: string): ValidationResult {
  if (!apiKey || typeof apiKey !== 'string') {
    return { valid: false, error: 'API key is required' };
  }

  if (apiKey.trim() !== apiKey) {
    return { valid: false, error: 'API key contains leading or trailing whitespace' };
  }

  // Gemini keys are typically alphanumeric (can contain hyphens and underscores)
  if (!/^[A-Za-z0-9_-]+$/.test(apiKey)) {
    return { valid: false, error: 'Gemini API key contains invalid characters' };
  }

  // Minimum length check (Gemini keys are typically 30+ characters)
  if (apiKey.length < 20) {
    return { valid: false, error: 'Gemini API key is too short' };
  }

  // Maximum length check (prevent DOS)
  if (apiKey.length > 200) {
    return { valid: false, error: 'Gemini API key is too long' };
  }

  return { valid: true };
}

/**
 * Validate API key format for any provider
 *
 * @param provider - LLM provider
 * @param apiKey - API key to validate
 * @returns Validation result
 */
export function validateLLMKeyFormat(provider: LLMProvider, apiKey: string): ValidationResult {
  switch (provider) {
    case 'openai':
      return validateOpenAIKeyFormat(apiKey);
    case 'gemini':
      return validateGeminiKeyFormat(apiKey);
    default:
      return { valid: false, error: `Unknown provider: ${provider}` };
  }
}

/**
 * Validate OpenAI API key against OpenAI API
 *
 * Makes a lightweight API call to verify the key works.
 * Note: This is optional and should be rate-limited.
 *
 * @param apiKey - API key to validate
 * @returns Validation result
 */
export async function validateOpenAIKeyLive(apiKey: string): Promise<ValidationResult> {
  try {
    // Use /models endpoint as a lightweight validation check
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (response.status === 403) {
      return { valid: false, error: 'API key does not have required permissions' };
    }

    return { valid: false, error: `Unexpected response: ${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { valid: false, error: 'Validation request timed out' };
    }
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

/**
 * Validate Gemini API key against Google AI API
 *
 * Makes a lightweight API call to verify the key works.
 * Note: This is optional and should be rate-limited.
 *
 * @param apiKey - API key to validate
 * @returns Validation result
 */
export async function validateGeminiKeyLive(apiKey: string): Promise<ValidationResult> {
  try {
    // Use /models endpoint as a lightweight validation check
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      }
    );

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }

    return { valid: false, error: `Unexpected response: ${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { valid: false, error: 'Validation request timed out' };
    }
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

/**
 * Validate LLM API key against provider API (live validation)
 *
 * @param provider - LLM provider
 * @param apiKey - API key to validate
 * @returns Validation result
 */
export async function validateLLMKeyLive(
  provider: LLMProvider,
  apiKey: string
): Promise<ValidationResult> {
  switch (provider) {
    case 'openai':
      return validateOpenAIKeyLive(apiKey);
    case 'gemini':
      return validateGeminiKeyLive(apiKey);
    default:
      return { valid: false, error: `Unknown provider: ${provider}` };
  }
}
