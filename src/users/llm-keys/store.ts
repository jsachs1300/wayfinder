/**
 * User LLM Key Store
 *
 * Storage for user-provided LLM API keys (BYOLLM feature).
 * Keys are encrypted at rest using AES-256-GCM.
 */

import type Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type { UserLLMKey, UserLLMKeyCreateRequest, DecryptedLLMKey, LLMProvider } from './types';
import { encryptLLMKey, decryptLLMKey, type EncryptedData } from './encryption';

const USER_LLM_KEYS_PREFIX = 'wayfinder:user:';
const USER_LLM_KEYS_SUFFIX = ':llm_keys';

/**
 * User LLM Key Store Interface
 */
export interface UserLLMKeyStore {
  /**
   * Set or update LLM key for a provider
   * If key already exists for provider, it will be updated
   */
  setKey(userId: string, request: UserLLMKeyCreateRequest): Promise<UserLLMKey>;

  /**
   * Get all LLM keys for a user (metadata only, not decrypted)
   */
  getKeys(userId: string): Promise<UserLLMKey[]>;

  /**
   * Get decrypted LLM keys for a user
   */
  getDecryptedKeys(userId: string): Promise<DecryptedLLMKey[]>;

  /**
   * Delete LLM key for a provider
   */
  deleteKey(userId: string, provider: LLMProvider): Promise<boolean>;

  /**
   * Update validation status for a key
   */
  updateValidationStatus(
    userId: string,
    provider: LLMProvider,
    status: 'valid' | 'invalid' | 'unknown',
    error?: string
  ): Promise<void>;

  /**
   * Update last used timestamp
   */
  updateLastUsed(userId: string, provider: LLMProvider): Promise<void>;
}

/**
 * In-memory LLM Key Store (for testing)
 */
export class InMemoryUserLLMKeyStore implements UserLLMKeyStore {
  private keys: Map<string, UserLLMKey[]> = new Map();

  async setKey(userId: string, request: UserLLMKeyCreateRequest): Promise<UserLLMKey> {
    const userKeys = this.keys.get(userId) || [];
    const now = new Date().toISOString();

    // Check if key already exists for this provider
    const existingIndex = userKeys.findIndex((k) => k.provider === request.provider);

    // Encrypt the API key
    const encrypted = encryptLLMKey(request.api_key);

    const key: UserLLMKey = {
      id: uuidv4(),
      user_id: userId,
      provider: request.provider,
      encrypted_key: encrypted.encrypted,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      key_version: 1,
      is_active: true,
      created_at: existingIndex >= 0 ? (userKeys[existingIndex]?.created_at ?? now) : now,
      updated_at: now,
      last_used_at: null,
      validation_status: 'unknown',
      validation_error: null,
    };

    if (existingIndex >= 0) {
      // Update existing key
      userKeys[existingIndex] = key;
    } else {
      // Add new key
      userKeys.push(key);
    }

    this.keys.set(userId, userKeys);
    return key;
  }

  async getKeys(userId: string): Promise<UserLLMKey[]> {
    return this.keys.get(userId) || [];
  }

  async getDecryptedKeys(userId: string): Promise<DecryptedLLMKey[]> {
    const userKeys = this.keys.get(userId) || [];
    const decrypted: DecryptedLLMKey[] = [];

    for (const key of userKeys) {
      if (!key.is_active) continue;

      try {
        const apiKey = decryptLLMKey({
          encrypted: key.encrypted_key,
          iv: key.iv,
          authTag: key.auth_tag,
        });

        decrypted.push({
          provider: key.provider,
          api_key: apiKey,
        });
      } catch (error) {
        // Skip keys that fail to decrypt
        console.error(`Failed to decrypt key for provider ${key.provider}:`, error);
      }
    }

    return decrypted;
  }

  async deleteKey(userId: string, provider: LLMProvider): Promise<boolean> {
    const userKeys = this.keys.get(userId) || [];
    const initialLength = userKeys.length;

    const filtered = userKeys.filter((k) => k.provider !== provider);

    if (filtered.length === initialLength) {
      return false; // No key found
    }

    this.keys.set(userId, filtered);
    return true;
  }

  async updateValidationStatus(
    userId: string,
    provider: LLMProvider,
    status: 'valid' | 'invalid' | 'unknown',
    error?: string
  ): Promise<void> {
    const userKeys = this.keys.get(userId) || [];
    const key = userKeys.find((k) => k.provider === provider);

    if (key) {
      key.validation_status = status;
      key.validation_error = error || null;
      key.updated_at = new Date().toISOString();
    }
  }

  async updateLastUsed(userId: string, provider: LLMProvider): Promise<void> {
    const userKeys = this.keys.get(userId) || [];
    const key = userKeys.find((k) => k.provider === provider);

    if (key) {
      key.last_used_at = new Date().toISOString();
    }
  }
}

/**
 * Redis-backed LLM Key Store (for production)
 */
export class RedisUserLLMKeyStore implements UserLLMKeyStore {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private getRedisKey(userId: string): string {
    return `${USER_LLM_KEYS_PREFIX}${userId}${USER_LLM_KEYS_SUFFIX}`;
  }

  async setKey(userId: string, request: UserLLMKeyCreateRequest): Promise<UserLLMKey> {
    const redisKey = this.getRedisKey(userId);
    const existingData = await this.redis.get(redisKey);
    const userKeys: UserLLMKey[] = existingData ? JSON.parse(existingData) : [];
    const now = new Date().toISOString();

    // Check if key already exists for this provider
    const existingIndex = userKeys.findIndex((k) => k.provider === request.provider);

    // Encrypt the API key
    const encrypted = encryptLLMKey(request.api_key);

    const key: UserLLMKey = {
      id: uuidv4(),
      user_id: userId,
      provider: request.provider,
      encrypted_key: encrypted.encrypted,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      key_version: 1,
      is_active: true,
      created_at: existingIndex >= 0 ? (userKeys[existingIndex]?.created_at ?? now) : now,
      updated_at: now,
      last_used_at: null,
      validation_status: 'unknown',
      validation_error: null,
    };

    if (existingIndex >= 0) {
      // Update existing key
      userKeys[existingIndex] = key;
    } else {
      // Add new key
      userKeys.push(key);
    }

    await this.redis.set(redisKey, JSON.stringify(userKeys));
    return key;
  }

  async getKeys(userId: string): Promise<UserLLMKey[]> {
    const redisKey = this.getRedisKey(userId);
    const data = await this.redis.get(redisKey);
    return data ? JSON.parse(data) : [];
  }

  async getDecryptedKeys(userId: string): Promise<DecryptedLLMKey[]> {
    const userKeys = await this.getKeys(userId);
    const decrypted: DecryptedLLMKey[] = [];

    for (const key of userKeys) {
      if (!key.is_active) continue;

      try {
        const apiKey = decryptLLMKey({
          encrypted: key.encrypted_key,
          iv: key.iv,
          authTag: key.auth_tag,
        });

        decrypted.push({
          provider: key.provider,
          api_key: apiKey,
        });
      } catch (error) {
        // Skip keys that fail to decrypt
        console.error(`Failed to decrypt key for provider ${key.provider}:`, error);
      }
    }

    return decrypted;
  }

  async deleteKey(userId: string, provider: LLMProvider): Promise<boolean> {
    const redisKey = this.getRedisKey(userId);
    const userKeys = await this.getKeys(userId);
    const initialLength = userKeys.length;

    const filtered = userKeys.filter((k) => k.provider !== provider);

    if (filtered.length === initialLength) {
      return false; // No key found
    }

    if (filtered.length === 0) {
      await this.redis.del(redisKey);
    } else {
      await this.redis.set(redisKey, JSON.stringify(filtered));
    }

    return true;
  }

  async updateValidationStatus(
    userId: string,
    provider: LLMProvider,
    status: 'valid' | 'invalid' | 'unknown',
    error?: string
  ): Promise<void> {
    const redisKey = this.getRedisKey(userId);
    const userKeys = await this.getKeys(userId);
    const key = userKeys.find((k) => k.provider === provider);

    if (key) {
      key.validation_status = status;
      key.validation_error = error || null;
      key.updated_at = new Date().toISOString();
      await this.redis.set(redisKey, JSON.stringify(userKeys));
    }
  }

  async updateLastUsed(userId: string, provider: LLMProvider): Promise<void> {
    const redisKey = this.getRedisKey(userId);
    const userKeys = await this.getKeys(userId);
    const key = userKeys.find((k) => k.provider === provider);

    if (key) {
      key.last_used_at = new Date().toISOString();
      await this.redis.set(redisKey, JSON.stringify(userKeys));
    }
  }
}

/**
 * Create LLM key store based on environment
 */
export function createUserLLMKeyStore(redis?: Redis): UserLLMKeyStore {
  if (redis) {
    return new RedisUserLLMKeyStore(redis);
  }
  return new InMemoryUserLLMKeyStore();
}
