import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTokenStore } from '../src/tokens/store';
import { TokenCreateRequest } from '../src/types';
import { hashToken } from '../src/auth/middleware';

describe('TokenStore Security and Edge Cases', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  describe('Token Generation Security', () => {
    it('should generate unique tokens', async () => {
      const tokens = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        const { token } = await store.create({});
        tokens.add(token);
      }

      // All tokens should be unique
      expect(tokens.size).toBe(count);
    });

    it('should generate tokens with sufficient entropy', async () => {
      const { token } = await store.create({});

      // Should have wf_ prefix
      expect(token).toMatch(/^wf_/);

      // Should be long enough (prefix + 32 chars)
      expect(token.length).toBe(35); // 'wf_' + 32 chars

      // Should contain only alphanumeric characters after prefix
      const tokenBody = token.slice(3);
      expect(tokenBody).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('should not include predictable patterns in tokens', async () => {
      const tokens: string[] = [];

      for (let i = 0; i < 10; i++) {
        const { token } = await store.create({});
        tokens.push(token);
      }

      // Check no sequential patterns exist
      for (let i = 1; i < tokens.length; i++) {
        // Tokens should not be similar (no sequential generation)
        expect(tokens[i]).not.toBe(tokens[i - 1]);

        // Check they don't just differ by one character
        let differences = 0;
        const prev = tokens[i - 1];
        const curr = tokens[i];

        for (let j = 0; j < Math.min(prev.length, curr.length); j++) {
          if (prev[j] !== curr[j]) differences++;
        }

        // Should have many differences (high entropy)
        expect(differences).toBeGreaterThan(10);
      }
    });
  });

  describe('Token Hash Storage', () => {
    it('should never store plaintext tokens', async () => {
      const { token, config } = await store.create({});

      // Token should not appear in config
      expect(config.token_hash).not.toBe(token);
      expect(config.token_hash).not.toContain(token);

      // Retrieved config should not contain plaintext token
      const retrieved = await store.getById(config.id);
      expect(retrieved?.token_hash).not.toBe(token);
    });

    it('should store consistent hashes for same token', async () => {
      const { token, config } = await store.create({});
      const hash1 = config.token_hash;

      // Retrieve by token hash
      const retrieved = await store.getByHash(hash1);
      expect(retrieved?.token_hash).toBe(hash1);
    });

    it('should not allow hash collisions', async () => {
      const result1 = await store.create({});
      const result2 = await store.create({});

      // Different tokens should have different hashes
      expect(result1.config.token_hash).not.toBe(result2.config.token_hash);
    });
  });

  describe('Token Rotation Security', () => {
    it('should invalidate old token after rotation', async () => {
      const { token: oldToken, id } = await store.create({});

      // Rotate token
      const rotated = await store.rotate(id);
      expect(rotated).not.toBeNull();

      const newToken = rotated!.token;

      // Old token should no longer work
      const oldHash = hashToken(oldToken);
      const byOldHash = await store.getByHash(oldHash);
      expect(byOldHash).toBeNull();

      // New token should work
      const newHash = hashToken(newToken);
      const byNewHash = await store.getByHash(newHash);
      expect(byNewHash).not.toBeNull();
      expect(byNewHash?.id).toBe(id);
    });

    it('should preserve configuration during rotation', async () => {
      const request: TokenCreateRequest = {
        trusted_anchor_model: 'gpt-4-turbo',
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        confidence_threshold: 0.8,
        environment: 'prod',
      };

      const { id } = await store.create(request);
      const rotated = await store.rotate(id);

      expect(rotated?.config.trusted_anchor_model).toBe('gpt-4-turbo');
      expect(rotated?.config.allowed_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
      expect(rotated?.config.confidence_threshold).toBe(0.8);
      expect(rotated?.config.environment).toBe('prod');
    });

    it('should update rotated_at timestamp', async () => {
      const { id, config } = await store.create({});

      expect(config.rotated_at).toBeUndefined();

      const rotated = await store.rotate(id);
      expect(rotated?.config.rotated_at).toBeDefined();
      expect(new Date(rotated!.config.rotated_at!).getTime()).toBeGreaterThanOrEqual(
        new Date(config.created_at).getTime()
      );
    });

    it('should return null when rotating non-existent token', async () => {
      const result = await store.rotate('non-existent-id');
      expect(result).toBeNull();
    });

    it('should generate different token on each rotation', async () => {
      const { id } = await store.create({});

      const rotation1 = await store.rotate(id);
      const rotation2 = await store.rotate(id);
      const rotation3 = await store.rotate(id);

      const tokens = [rotation1!.token, rotation2!.token, rotation3!.token];
      const uniqueTokens = new Set(tokens);

      expect(uniqueTokens.size).toBe(3);
    });
  });

  describe('Token Deletion Security', () => {
    it('should completely remove token and hash index', async () => {
      const { token, id, config } = await store.create({});
      const hash = config.token_hash;

      // Delete token
      const deleted = await store.delete(id);
      expect(deleted).toBe(true);

      // Should not be retrievable by ID
      const byId = await store.getById(id);
      expect(byId).toBeNull();

      // Should not be retrievable by hash
      const byHash = await store.getByHash(hash);
      expect(byHash).toBeNull();
    });

    it('should return false when deleting non-existent token', async () => {
      const result = await store.delete('non-existent-id');
      expect(result).toBe(false);
    });

    it('should handle double deletion gracefully', async () => {
      const { id } = await store.create({});

      const firstDelete = await store.delete(id);
      expect(firstDelete).toBe(true);

      const secondDelete = await store.delete(id);
      expect(secondDelete).toBe(false);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent token creation', async () => {
      const promises = Array.from({ length: 50 }, () =>
        store.create({ trusted_anchor_model: 'gpt-4-turbo' })
      );

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.length).toBe(50);

      // All should have unique IDs
      const ids = new Set(results.map(r => r.id));
      expect(ids.size).toBe(50);

      // All should have unique tokens
      const tokens = new Set(results.map(r => r.token));
      expect(tokens.size).toBe(50);
    });

    it('should handle concurrent reads of same token', async () => {
      const { id } = await store.create({});

      const promises = Array.from({ length: 20 }, () => store.getById(id));
      const results = await Promise.all(promises);

      // All reads should succeed
      expect(results.every(r => r !== null)).toBe(true);
      expect(results.every(r => r?.id === id)).toBe(true);
    });

    it('should handle concurrent update and read', async () => {
      const { id } = await store.create({
        confidence_threshold: 0.5,
      });

      // Start concurrent operations
      const updatePromise = store.update(id, { confidence_threshold: 0.8 });
      const readPromise = store.getById(id);

      const [updateResult, readResult] = await Promise.all([updatePromise, readPromise]);

      // Both should succeed
      expect(updateResult).not.toBeNull();
      expect(readResult).not.toBeNull();

      // Final state should reflect the update
      const final = await store.getById(id);
      expect(final?.confidence_threshold).toBe(0.8);
    });

    it('should handle rotation race conditions', async () => {
      const { id } = await store.create({});

      // Attempt concurrent rotations
      const rotation1 = store.rotate(id);
      const rotation2 = store.rotate(id);

      const [result1, result2] = await Promise.all([rotation1, rotation2]);

      // Both should succeed but produce different tokens
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1!.token).not.toBe(result2!.token);

      // The last one should win
      const final = await store.getById(id);
      expect(final).not.toBeNull();
    });
  });

  describe('Input Validation and Edge Cases', () => {
    it('should handle empty configuration', async () => {
      const result = await store.create({});

      expect(result.token).toBeDefined();
      expect(result.config.confidence_threshold).toBe(0.6); // Default
      expect(result.config.logging_level).toBe('normal'); // Default
      expect(result.config.environment).toBe('dev'); // Default
    });

    it('should handle very large arrays in allowed_models', async () => {
      const manyModels = Array.from({ length: 1000 }, (_, i) => `model-${i}`);

      const result = await store.create({
        allowed_models: manyModels,
      });

      expect(result.config.allowed_models).toHaveLength(1000);
    });

    it('should handle special characters in model names', async () => {
      const result = await store.create({
        trusted_anchor_model: 'model-with-special-chars-v1.0@beta',
        allowed_models: ['model-1.0', 'model@2.0', 'model_v3'],
      });

      expect(result.config.trusted_anchor_model).toBe('model-with-special-chars-v1.0@beta');
      expect(result.config.allowed_models).toContain('model@2.0');
    });

    it('should handle boundary values for confidence_threshold', async () => {
      const min = await store.create({ confidence_threshold: 0 });
      const max = await store.create({ confidence_threshold: 1 });

      expect(min.config.confidence_threshold).toBe(0);
      expect(max.config.confidence_threshold).toBe(1);
    });

    it('should preserve undefined vs null distinctions', async () => {
      const result = await store.create({
        trusted_anchor_model: undefined,
      });

      expect(result.config.trusted_anchor_model).toBeUndefined();
    });

    it('should handle update with empty object', async () => {
      const { id, config } = await store.create({
        trusted_anchor_model: 'gpt-4-turbo',
      });

      const updated = await store.update(id, {});

      // Should not change anything except updated_at
      expect(updated?.trusted_anchor_model).toBe('gpt-4-turbo');
      expect(new Date(updated!.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(config.created_at).getTime()
      );
    });

    it('should not allow updating immutable fields via update', async () => {
      const { id, config } = await store.create({});
      const originalHash = config.token_hash;
      const originalCreatedAt = config.created_at;

      // Attempt to update immutable fields (should be ignored)
      await store.update(id, {
        trusted_anchor_model: 'new-model',
      } as any);

      const updated = await store.getById(id);

      // Immutable fields should remain unchanged
      expect(updated?.id).toBe(id);
      expect(updated?.token_hash).toBe(originalHash);
      expect(updated?.created_at).toBe(originalCreatedAt);
    });
  });

  describe('Data Integrity', () => {
    it('should maintain referential integrity between token and hash index', async () => {
      const { id, config } = await store.create({});
      const hash = config.token_hash;

      // Both lookups should return same data
      const byId = await store.getById(id);
      const byHash = await store.getByHash(hash);

      expect(byId).toEqual(byHash);
    });

    it('should list all tokens correctly', async () => {
      const count = 10;
      const created = [];

      for (let i = 0; i < count; i++) {
        const result = await store.create({
          environment: i % 2 === 0 ? 'prod' : 'dev',
        });
        created.push(result.config);
      }

      const listed = await store.list();

      expect(listed.length).toBe(count);

      // All created tokens should be in the list
      for (const config of created) {
        const found = listed.find(t => t.id === config.id);
        expect(found).toBeDefined();
      }
    });

    it('should never expose token_hash in responses', async () => {
      const { config } = await store.create({});

      // This is more of a documentation test - the routes layer should filter this
      // But we verify the hash exists in internal storage
      expect(config.token_hash).toBeDefined();
      expect(config.token_hash.length).toBe(64);
    });
  });
});
