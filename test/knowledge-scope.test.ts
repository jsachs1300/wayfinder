import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { KnowledgeScopeContext } from '../src/types';
import { createModelRegistry } from '../src/models';

describe('Knowledge Scope', () => {
  let knowledgeStore: InMemoryKnowledgeStore;

  // Use real model IDs from the registry
  const modelA = 'claude-3-5-sonnet';
  const modelB = 'gpt-4o';

  beforeEach(() => {
    const modelRegistry = createModelRegistry();
    knowledgeStore = new InMemoryKnowledgeStore(modelRegistry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Global Scope (Default)', () => {
    it('should record and retrieve votes in global scope', async () => {
      const scopeContext: KnowledgeScopeContext = { scope: 'global' };

      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', scopeContext);
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', scopeContext);
      await knowledgeStore.recordVote('code_change', 'claude-3-5-sonnet', scopeContext);

      const entry = await knowledgeStore.get('code_change', scopeContext);
      expect(entry).not.toBeNull();
      expect(entry?.total_votes).toBeCloseTo(3, 6);
      expect(entry?.model_votes['gpt-4-turbo']).toBeCloseTo(2, 6);
      expect(entry?.model_votes['claude-3-5-sonnet']).toBeCloseTo(1, 6);
    });

    it('should calculate consensus model in global scope', async () => {
      const scopeContext: KnowledgeScopeContext = { scope: 'global' };

      // Build strong consensus
      for (let i = 0; i < 6; i++) {
        await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', scopeContext);
      }
      await knowledgeStore.recordVote('code_change', 'claude-3-5-sonnet', scopeContext);

      const consensus = await knowledgeStore.getConsensusModel('code_change', scopeContext);
      expect(consensus).toBe('gpt-4-turbo');
    });
  });

  describe('Token Scope', () => {
    it('should record and retrieve votes in token scope', async () => {
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);
      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);

      const entry = await knowledgeStore.get('code_change', tokenScope);
      expect(entry).not.toBeNull();
      expect(entry?.total_votes).toBeCloseTo(2, 6);
      expect(entry?.model_votes['gpt-4o']).toBeCloseTo(2, 6);
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
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', token1Scope);
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', token1Scope);

      // Record different votes for token 2
      await knowledgeStore.recordVote('code_change', 'claude-3-5-sonnet', token2Scope);

      // Verify token 1 knowledge
      const entry1 = await knowledgeStore.get('code_change', token1Scope);
      expect(entry1?.model_votes['gpt-4-turbo']).toBeCloseTo(2, 6);
      expect(entry1?.model_votes['claude-3-5-sonnet']).toBeUndefined();

      // Verify token 2 knowledge
      const entry2 = await knowledgeStore.get('code_change', token2Scope);
      expect(entry2?.model_votes['claude-3-5-sonnet']).toBeCloseTo(1, 6);
      expect(entry2?.model_votes['gpt-4-turbo']).toBeUndefined();
    });

    it('should not leak knowledge from global to token scope', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      // Record votes in global scope
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);

      // Token scope should have no knowledge
      const tokenEntry = await knowledgeStore.get('code_change', tokenScope);
      expect(tokenEntry).toBeNull();
    });

    it('should not leak knowledge from token to global scope', async () => {
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      // Record votes in token scope
      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);
      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);

      // Global scope should have no knowledge
      const globalEntry = await knowledgeStore.get('code_change', globalScope);
      expect(globalEntry).toBeNull();
    });

    it('should require token_id for token scope', async () => {
      const invalidScope: KnowledgeScopeContext = {
        scope: 'token',
        // Missing token_id
      };

      await expect(
        knowledgeStore.recordVote('code_change', 'gpt-4-turbo', invalidScope)
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
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('other:legal', 'claude-3-opus', globalScope);

      // Create some token knowledge
      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);

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

      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);

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

      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', token1Scope);
      await knowledgeStore.recordVote('other:legal', 'claude-3-opus', token2Scope);

      const stats = await knowledgeStore.getStats(token1Scope);
      expect(stats.total_entries).toBe(1);
      expect(stats.entries_by_scope?.token).toBe(1);
    });
  });

  describe('Decay by Scope', () => {
    it('rejects manual decay calls and relies on lazy decay', async () => {
      await expect(knowledgeStore.applyDecay()).rejects.toThrow();
    });

    it('applies lazy decay independently per scope on reads', async () => {
      vi.useFakeTimers();
      const globalScope: KnowledgeScopeContext = { scope: 'global' };
      const tokenScope: KnowledgeScopeContext = {
        scope: 'token',
        token_id: 'token_123',
      };

      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      await knowledgeStore.recordVote('code_change', 'gpt-4o', tokenScope);

      const immediateGlobal = await knowledgeStore.get('code_change', globalScope);
      const immediateToken = await knowledgeStore.get('code_change', tokenScope);

      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
      const decayedGlobal = await knowledgeStore.get('code_change', globalScope);
      const decayedToken = await knowledgeStore.get('code_change', tokenScope);

      expect(decayedGlobal!.total_votes).toBeLessThan(immediateGlobal!.total_votes);
      expect(decayedToken!.total_votes).toBeLessThan(immediateToken!.total_votes);
    });
  });

  describe('Future Scope Types', () => {
    it('should throw NotImplemented for org scope', async () => {
      const orgScope: KnowledgeScopeContext = {
        scope: 'org',
        org_id: 'org_123',
      };

      await expect(
        knowledgeStore.recordVote('code_change', 'gpt-4-turbo', orgScope)
      ).rejects.toThrow('Org-scoped knowledge is not yet implemented');
    });

    it('should throw NotImplemented for hybrid scope', async () => {
      const hybridScope: KnowledgeScopeContext = {
        scope: 'hybrid',
      };

      await expect(
        knowledgeStore.recordVote('code_change', 'gpt-4-turbo', hybridScope)
      ).rejects.toThrow('Hybrid knowledge scope is not yet implemented');
    });
  });
});
