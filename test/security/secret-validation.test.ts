import { describe, it, expect } from 'vitest';
import { decryptLLMKey, encryptLLMKey, validateEncryptionKeyAtStartup } from '../../src/users/llm-keys/encryption';

describe('Secret Validation (Optional)', () => {
  const hasEncryptionKey = Boolean(process.env.LLM_KEY_ENCRYPTION_KEY);

  it.skipIf(!hasEncryptionKey)('validates encryption key format and encrypt/decrypts', () => {
    validateEncryptionKeyAtStartup();

    const plaintext = 'sk-test-secret-123456';
    const encrypted = encryptLLMKey(plaintext);
    const decrypted = decryptLLMKey(encrypted);

    expect(decrypted).toBe(plaintext);
  });
});
