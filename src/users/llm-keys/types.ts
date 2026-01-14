/**
 * User LLM Key Types
 *
 * Types for storing and managing user-provided LLM API keys (BYOLLM feature).
 */

/**
 * Supported LLM providers for BYOLLM
 */
export type LLMProvider = 'openai' | 'gemini';

/**
 * User's configured LLM API key (stored encrypted)
 */
export interface UserLLMKey {
  /** Unique identifier (UUID v4) */
  id: string;

  /** Owner user ID */
  user_id: string;

  /** LLM provider */
  provider: LLMProvider;

  /** Encrypted API key (AES-256-GCM) */
  encrypted_key: string;

  /** Initialization vector for decryption */
  iv: string;

  /** Auth tag for GCM mode */
  auth_tag: string;

  /** Key version (for rotation support) */
  key_version: number;

  /** Whether this key is active */
  is_active: boolean;

  /** ISO 8601 timestamp */
  created_at: string;

  /** ISO 8601 timestamp */
  updated_at: string;

  /** ISO 8601 timestamp of last successful use */
  last_used_at: string | null;

  /** Last validation status */
  validation_status: 'valid' | 'invalid' | 'unknown';

  /** Last validation error message */
  validation_error: string | null;
}

/**
 * Request to add/update user LLM key
 */
export interface UserLLMKeyCreateRequest {
  provider: LLMProvider;
  api_key: string; // Plaintext, will be encrypted before storage
}

/**
 * Decrypted key for internal use only
 */
export interface DecryptedLLMKey {
  provider: LLMProvider;
  api_key: string;
}
