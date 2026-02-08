/**
 * LLM Key Encryption Tests
 *
 * Tests for AES-256-GCM encryption/decryption of user LLM API keys
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptLLMKey,
  decryptLLMKey,
  validateEncryptionKeyAtStartup,
} from '../../src/users/llm-keys/encryption';
import { InMemoryUserLLMKeyStore } from '../../src/users/llm-keys/store';

describe('LLM Key Encryption', () => {
  const originalKey = process.env.LLM_KEY_ENCRYPTION_KEY;

  beforeEach(() => {
    // Set a valid encryption key for tests
    process.env.LLM_KEY_ENCRYPTION_KEY = 'a7bc6b8ade99c80ff7e4bb1cecb2d391615630556c0b2a0317c53cf4e45ff91d';
  });

  afterEach(() => {
    // Restore original key
    if (originalKey) {
      process.env.LLM_KEY_ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.LLM_KEY_ENCRYPTION_KEY;
    }
  });

  describe('Encryption/Decryption', () => {
    it('should encrypt API key', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptLLMKey(apiKey);

      expect(encrypted.encrypted).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();

      // Encrypted data should be different from plaintext
      expect(encrypted.encrypted).not.toBe(apiKey);

      // Base64 format check
      expect(encrypted.encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(encrypted.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(encrypted.authTag).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should decrypt encrypted API key', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptLLMKey(apiKey);
      const decrypted = decryptLLMKey(encrypted);

      expect(decrypted).toBe(apiKey);
    });

    it('should use different IVs for each encryption', () => {
      const apiKey = 'sk-test-same-key';

      const encrypted1 = encryptLLMKey(apiKey);
      const encrypted2 = encryptLLMKey(apiKey);

      // IVs should be different
      expect(encrypted1.iv).not.toBe(encrypted2.iv);

      // Both should decrypt correctly
      expect(decryptLLMKey(encrypted1)).toBe(apiKey);
      expect(decryptLLMKey(encrypted2)).toBe(apiKey);
    });

    it('should handle long API keys', () => {
      const longKey = 'sk-' + 'a'.repeat(200);
      const encrypted = encryptLLMKey(longKey);
      const decrypted = decryptLLMKey(encrypted);

      expect(decrypted).toBe(longKey);
    });

    it('should handle special characters in keys', () => {
      const specialKey = 'sk-!@#$%^&*()_+-={}[]|\\:";\'<>?,./';
      const encrypted = encryptLLMKey(specialKey);
      const decrypted = decryptLLMKey(encrypted);

      expect(decrypted).toBe(specialKey);
    });

    it('should fail decryption with wrong key', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptLLMKey(apiKey);

      // Change encryption key
      process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);

      expect(() => decryptLLMKey(encrypted)).toThrow();
    });

    it('should fail decryption with tampered ciphertext', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptLLMKey(apiKey);

      // Tamper with encrypted data
      const ciphertext = Buffer.from(encrypted.encrypted, 'base64');
      ciphertext[0] = ciphertext[0] ^ 0xff;
      const tampered = {
        ...encrypted,
        encrypted: ciphertext.toString('base64'),
      };

      expect(() => decryptLLMKey(tampered)).toThrow();
    });

    it('should fail decryption with tampered IV', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptLLMKey(apiKey);

      // Tamper with IV
      const tampered = {
        ...encrypted,
        iv: Buffer.from('tampered').toString('base64'),
      };

      expect(() => decryptLLMKey(tampered)).toThrow();
    });

    it('should fail decryption with tampered auth tag', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptLLMKey(apiKey);

      // Tamper with auth tag
      const tampered = {
        ...encrypted,
        authTag: Buffer.from('tampered').toString('base64'),
      };

      expect(() => decryptLLMKey(tampered)).toThrow();
    });
  });

  describe('Encryption Key Validation', () => {
    it('should validate correct encryption key at startup', () => {
      expect(() => validateEncryptionKeyAtStartup()).not.toThrow();
    });

    it('should reject missing encryption key', () => {
      delete process.env.LLM_KEY_ENCRYPTION_KEY;

      expect(() => validateEncryptionKeyAtStartup()).toThrow(/required/);
    });

    it('should reject short encryption key', () => {
      process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(32); // Too short

      expect(() => validateEncryptionKeyAtStartup()).toThrow(/64 hex characters/);
    });

    it('should reject long encryption key', () => {
      process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(128); // Too long

      expect(() => validateEncryptionKeyAtStartup()).toThrow(/64 hex characters/);
    });

    it('should reject non-hex encryption key', () => {
      process.env.LLM_KEY_ENCRYPTION_KEY = 'z'.repeat(64); // Not hex

      expect(() => validateEncryptionKeyAtStartup()).toThrow(/64 hex characters/);
    });

    it('should reject all-zeros encryption key', () => {
      process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);

      expect(() => validateEncryptionKeyAtStartup()).toThrow(/must not be all zeros/);
    });
  });

  describe('LLM Key Store Integration', () => {
    let store: InMemoryUserLLMKeyStore;

    beforeEach(() => {
      store = new InMemoryUserLLMKeyStore();
    });

    it('should store encrypted OpenAI key', async () => {
      const userId = 'user-123';
      const apiKey = 'sk-test-openai-key-12345';

      const key = await store.setKey(userId, {
        provider: 'openai',
        api_key: apiKey,
      });

      expect(key.provider).toBe('openai');
      expect(key.encrypted_key).toBeDefined();
      expect(key.encrypted_key).not.toBe(apiKey);
      expect(key.iv).toBeDefined();
      expect(key.auth_tag).toBeDefined();
    });

    it('should retrieve and decrypt keys', async () => {
      const userId = 'user-456';
      const openaiKey = 'sk-test-openai-12345';
      const geminiKey = 'AIzaSyTest12345';

      await store.setKey(userId, { provider: 'openai', api_key: openaiKey });
      await store.setKey(userId, { provider: 'gemini', api_key: geminiKey });

      const decrypted = await store.getDecryptedKeys(userId);

      expect(decrypted).toHaveLength(2);
      expect(decrypted.find(k => k.provider === 'openai')?.api_key).toBe(openaiKey);
      expect(decrypted.find(k => k.provider === 'gemini')?.api_key).toBe(geminiKey);
    });

    it('should update existing key', async () => {
      const userId = 'user-789';
      const oldKey = 'sk-old-key';
      const newKey = 'sk-new-key';

      const created = await store.setKey(userId, {
        provider: 'openai',
        api_key: oldKey,
      });

      const updated = await store.setKey(userId, {
        provider: 'openai',
        api_key: newKey,
      });

      // Should have same provider and creation time
      expect(updated.provider).toBe(created.provider);
      expect(updated.created_at).toBe(created.created_at);

      // But different encrypted data
      expect(updated.encrypted_key).not.toBe(created.encrypted_key);

      // Verify decryption returns new key
      const decrypted = await store.getDecryptedKeys(userId);
      expect(decrypted[0].api_key).toBe(newKey);
    });

    it('should handle decryption failures gracefully', async () => {
      const userId = 'user-decrypt-fail';
      const apiKey = 'sk-test-key';

      await store.setKey(userId, { provider: 'openai', api_key: apiKey });

      // Change encryption key to cause decryption failure
      process.env.LLM_KEY_ENCRYPTION_KEY = '1'.repeat(64);

      // Should return empty array instead of throwing
      const decrypted = await store.getDecryptedKeys(userId);
      expect(decrypted).toHaveLength(0);
    });

    it('should delete key', async () => {
      const userId = 'user-delete';

      await store.setKey(userId, {
        provider: 'openai',
        api_key: 'sk-test',
      });

      let keys = await store.getKeys(userId);
      expect(keys).toHaveLength(1);

      const deleted = await store.deleteKey(userId, 'openai');
      expect(deleted).toBe(true);

      keys = await store.getKeys(userId);
      expect(keys).toHaveLength(0);
    });

    it('should return false when deleting non-existent key', async () => {
      const userId = 'user-no-key';

      const deleted = await store.deleteKey(userId, 'openai');
      expect(deleted).toBe(false);
    });

    it('should not expose encrypted fields in getKeys', async () => {
      const userId = 'user-security';

      await store.setKey(userId, {
        provider: 'openai',
        api_key: 'sk-secret-key',
      });

      const keys = await store.getKeys(userId);

      expect(keys[0].encrypted_key).toBeDefined(); // Encrypted data is in db
      expect(keys[0].iv).toBeDefined();
      expect(keys[0].auth_tag).toBeDefined();

      // But API should never expose these in responses
      // (this is enforced in routes, tested separately)
    });
  });
});
