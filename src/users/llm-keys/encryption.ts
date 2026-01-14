/**
 * LLM Key Encryption
 *
 * Provides AES-256-GCM encryption/decryption for user LLM API keys.
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypted data structure
 */
export interface EncryptedData {
  encrypted: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

/**
 * Get encryption key from environment variable
 *
 * @returns Encryption key as Buffer
 * @throws Error if key is not configured or invalid
 */
function getEncryptionKey(): Buffer {
  const key = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('LLM_KEY_ENCRYPTION_KEY environment variable is required');
  }
  // Key should be 64 hex characters (32 bytes)
  if (key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error('LLM_KEY_ENCRYPTION_KEY must be 64 hex characters');
  }
  return Buffer.from(key, 'hex');
}

/**
 * Validate encryption key at startup
 * This should be called during application initialization when BYOLLM features are enabled
 *
 * @throws Error if key is not configured or invalid
 */
export function validateEncryptionKeyAtStartup(): void {
  try {
    const key = getEncryptionKey();
    // Additional validation: ensure key has enough entropy by checking it's not all zeros
    const keyHex = key.toString('hex');
    if (keyHex === '0'.repeat(64)) {
      throw new Error('LLM_KEY_ENCRYPTION_KEY must not be all zeros');
    }
    // Success - key is valid
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Encryption key validation failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Encrypt LLM API key
 *
 * @param plaintext - API key to encrypt
 * @returns Encrypted data with IV and auth tag
 */
export function encryptLLMKey(plaintext: string): EncryptedData {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt LLM API key
 *
 * @param data - Encrypted data with IV and auth tag
 * @returns Decrypted API key
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decryptLLMKey(data: EncryptedData): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(data.iv, 'base64');
  const authTag = Buffer.from(data.authTag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
