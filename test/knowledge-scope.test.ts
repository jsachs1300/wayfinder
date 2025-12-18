import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { KnowledgeScopeContext } from '../src/types';

describe('Knowledge Scope', () => {
  let knowledgeStore: InMemoryKnowledgeStore;

  beforeEach(() => {
    knowledgeStore = new InMemoryKnowledgeStore();
  });

  describe('Global Scope (Default)', () => {
    it('should record and retrieve votes in global scope', async () => {
      const scopeContext: KnowledgeScopeContext = { scope: 'global' };

      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', scopeContext);
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', scopeContext);
      await knowledgeStore.recordVote('coding', 'claude-3-5-sonnet', scopeContext);

      const entry = await knowledgeStore.get('coding', scopeContext);
      expect(entry).not.toBeNull();
      expect(entry?.total_votes).toBe(3);
      expect(entry?.model_votes['gpt-4-turbo']).toBe(2);
      expect(entry?.model_votes['claude-3-5-sonnet']).toBe(1);
    });

    it('should calculate consensus model in global scope', async () => {
      const scopeContext: KnowledgeScopeContext = { scope: 'global' };

      // Build strong consensus
      for (let i = 0; i < 6; i++) {
        await knowledgeStore.recordVote('coding', 'gpt-4-turbo', scopeContext);
      }
      await knowledgeStore.recordVote('coding', 'claude-3-5-sonnet', scopeContext);

      const consensus = await knowledgeStore.getConsensusModel('coding', scopeContext);
      expect(consensus).toBe('gpt-4-turbo');
    });
  });

  describe('Token Scope', () => {
    it('should record and retrieve votes in token scope', async () => {
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);

      const entry = await knowledgeStore.get('coding', tokenScope);
      expect(entry).not.toBeNull();
      expect(entry?.total_votes).toBe(2);
      expect(entry?.model_votes['gpt-4o']).toBe(2);
    });

    it('should isolate knowledge between different tokens', async () => {
      const token1Scope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };
      const token2Scope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_456',
      };

      // Record votes for token 1
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', token1Scope);
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', token1Scope);

      // Record different votes for token 2
      await knowledgeStore.recordVote('coding', 'claude-3-5-sonnet', token2Scope);

      // Verify token 1 knowledge
      const entry1 = await knowledgeStore.get('coding', token1Scope);
      expect(entry1?.model_votes['gpt-4-turbo']).toBe(2);
      expect(entry1?.model_votes['claude-3-5-sonnet']).toBeUndefined();

      // Verify token 2 knowledge
      const entry2 = await knowledgeStore.get('coding', token2Scope);
      expect(entry2?.model_votes['claude-3-5-sonnet']).toBe(1);
      expect(entry2?.model_votes['gpt-4-turbo']).toBeUndefined();
    });

    it('should not leak knowledge from global to token scope', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      // Record votes in global scope
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', globalScope);

      // Token scope should have no knowledge
      const tokenEntry = await knowledgeStore.get('coding', tokenScope);
      expect(tokenEntry).toBeNull();
    });

    it('should not leak knowledge from token to global scope', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      // Record votes in token scope
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);

      // Global scope should have no knowledge
      const globalEntry = await knowledgeStore.get('coding', globalScope);
      expect(globalEntry).toBeNull();
    });

    it('should require token_id for token scope', async () => {
      const invalidScope: KnowledgeScopeContext = {
        scope: 'token',
        // Missing token_id
      };

      await expect(
        knowledgeStore.recordVote('coding', 'gpt-4-turbo', invalidScope)
      ).rejects.toThrow('token_id is required for token scope');
    });
  });

  describe('Stats by Scope', () => {
    it('should report stats for all scopes when no filter provided', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      // Create some global knowledge
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('legal', 'claude-3-opus', globalScope);

      // Create some token knowledge
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);

      const stats = await knowledgeStore.getStats();
      expect(stats.total_entries).toBe(3);
      expect(stats.entries_by_scope?.global).toBe(2);
      expect(stats.entries_by_scope?.token).toBe(1);
    });

    it('should report stats only for global scope when filtered', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);

      const stats = await knowledgeStore.getStats(globalScope);
      expect(stats.total_entries).toBe(1);
      expect(stats.entries_by_scope?.global).toBe(1);
      expect(stats.entries_by_scope?.token).toBe(0);
    });

    it('should report stats only for specific token when filtered', async () => {
      const token1Scope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };
      const token2Scope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_456',
      };

      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', token1Scope);
      await knowledgeStore.recordVote('legal', 'claude-3-opus', token2Scope);

      const stats = await knowledgeStore.getStats(token1Scope);
      expect(stats.total_entries).toBe(1);
      expect(stats.entries_by_scope?.token).toBe(1);
    });
  });

  describe('Decay by Scope', () => {
    it('should decay all scopes when no filter provided', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);

      const decayedCount = await knowledgeStore.applyDecay();
      expect(decayedCount).toBe(2);
    });

    it('should decay only global scope when filtered', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('coding', 'gpt-4o', tokenScope);

      const decayedCount = await knowledgeStore.applyDecay(globalScope);
      expect(decayedCount).toBe(1);

      // Verify token knowledge was not decayed
      const tokenEntry = await knowledgeStore.get('coding', tokenScope);
      expect(tokenEntry?.decay_factor).toBe(1); // Not decayed
    });

    it('should decay only specific token when filtered', async () => {
      const token1Scope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };
      const token2Scope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_456',
      };

      await knowledgeStore.recordVote('coding', 'gpt-4-turbo', token1Scope);
      await knowledgeStore.recordVote('coding', 'claude-3-5-sonnet', token2Scope);

      const decayedCount = await knowledgeStore.applyDecay(token1Scope);
      expect(decayedCount).toBe(1);

      // Verify only token1 was decayed
      const token2Entry = await knowledgeStore.get('coding', token2Scope);
      expect(token2Entry?.decay_factor).toBe(1); // Not decayed
    });
  });

  describe('Future Scope Types', () => {
    it('should throw NotImplemented for org scope', async () => {
      const orgScope: KnowledgeScopeContext = {
        scope: 'org',
        org_id: 'org_123',
      };

      await expect(
        knowledgeStore.recordVote('coding', 'gpt-4-turbo', orgScope)
      ).rejects.toThrow('Org-scoped knowledge is not yet implemented');
    });

    it('should throw NotImplemented for hybrid scope', async () => {
      const hybridScope: KnowledgeScopeContext = {
        scope: 'hybrid',
      };

      await expect(
        knowledgeStore.recordVote('coding', 'gpt-4-turbo', hybridScope)
      ).rejects.toThrow('Hybrid knowledge scope is not yet implemented');
    });
  });
});
