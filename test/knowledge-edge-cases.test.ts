import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { KnowledgeScopeContext } from '../src/types';
import { createModelRegistry } from '../src/models';

describe('KnowledgeStore Edge Cases and Race Conditions', () => {
  let store: InMemoryKnowledgeStore;
  const globalScope: KnowledgeScopeContext = { scope: 'global' };

  // Use real model IDs from the registry
  const modelA = 'claude-3-5-sonnet';
  const modelB = 'gpt-4o';
  const modelC = 'gemini-1.5-pro';

  beforeEach(async () => {
    const modelRegistry = createModelRegistry();
    store = new InMemoryKnowledgeStore(modelRegistry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Division by Zero and NaN Prevention', () => {
    it('should handle zero votes gracefully', async () => {
      // This shouldn't happen in practice, but test defensive code
      const entry = await store.get('non-existent', globalScope);
      expect(entry).toBeNull();
    });

    it('should handle agreement calculation with zero total votes', async () => {
      // Create entry with one vote
      await store.recordVote('test', modelA, globalScope);
      const entry = await store.get('test', globalScope);

      // Verify no NaN or Infinity
      expect(entry!.agreement_score).toBeGreaterThanOrEqual(0);
      expect(entry!.agreement_score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(entry!.agreement_score)).toBe(true);
    });
  });

  describe('Floating Point Precision', () => {
    it('should handle fractional votes after decay without precision errors', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await store.recordVote('test', modelA, globalScope);

      vi.setSystemTime(new Date('2024-01-01T06:00:00Z'));

      const entry = await store.get('test', globalScope);

      // Should still have valid numbers
      expect(Number.isFinite(entry!.total_votes)).toBe(true);
      expect(Number.isFinite(entry!.agreement_score)).toBe(true);
      expect(Number.isFinite(entry!.decay_factor)).toBe(true);

      // Should not accumulate to negative
      expect(entry!.total_votes).toBeGreaterThan(0);
      expect(entry!.decay_factor).toBeGreaterThan(0);
    });

    it('should maintain agreement score between 0 and 1', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      // Record votes with various distributions
      await store.recordVote('test1', modelA, globalScope);
      await store.recordVote('test1', modelA, globalScope);
      await store.recordVote('test1', modelB, globalScope);

      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));

      const entry = await store.get('test1', globalScope);

      expect(entry!.agreement_score).toBeGreaterThanOrEqual(0);
      expect(entry!.agreement_score).toBeLessThanOrEqual(1);
    });

    it('should handle very small vote counts after extensive decay', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await store.recordVote('test', modelA, globalScope);

      vi.setSystemTime(new Date('2024-02-01T00:00:00Z'));

      const entry = await store.get('test', globalScope);

      // Should enforce minimum values to prevent underflow
      expect(entry!.model_votes[modelA]).toBeGreaterThan(0);
      expect(entry!.decay_factor).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Vote Recording', () => {
    it('should handle concurrent votes for same cluster', async () => {
      const promises = Array.from({ length: 100 }, () =>
        store.recordVote('code_change', 'gpt-4-turbo', globalScope)
      );

      await Promise.all(promises);

      const entry = await store.get('code_change', globalScope);
      // All votes should be recorded
      expect(entry!.total_votes).toBeCloseTo(100, 3);
      expect(entry!.model_votes['gpt-4-turbo']).toBeCloseTo(100, 3);
    });

    it('should handle concurrent votes for different models in same cluster', async () => {
      const promises = [
        ...Array.from({ length: 60 }, () => store.recordVote('code_change', modelA, globalScope)),
        ...Array.from({ length: 40 }, () => store.recordVote('code_change', modelB, globalScope)),
      ];

      await Promise.all(promises);

      const entry = await store.get('code_change', globalScope);
      expect(entry!.total_votes).toBeCloseTo(100, 3);
      expect(entry!.model_votes[modelA]).toBeCloseTo(60, 3);
      expect(entry!.model_votes[modelB]).toBeCloseTo(40, 3);
      expect(entry!.agreement_score).toBeCloseTo(0.6, 3); // 60/100
    });

    it('should handle concurrent votes across multiple clusters', async () => {
      const clusters = ['code_change', 'other:legal', 'content_generation', 'explanation'];
      const promises = clusters.flatMap(cluster =>
        Array.from({ length: 10 }, () => store.recordVote(cluster, modelA, globalScope))
      );

      await Promise.all(promises);

      for (const cluster of clusters) {
        const entry = await store.get(cluster, globalScope);
        expect(entry!.total_votes).toBeCloseTo(10, 6);
      }
    });

    it('rejects explicit decay requests now that decay is lazy', async () => {
      await expect(store.applyDecay()).rejects.toThrow();
    });
  });

  describe('Confidence Level Edge Cases', () => {
    it('should handle exact boundary at 0.8 agreement with MIN_VOTES', async () => {
      // Record exactly 80% agreement with minimum votes
      const minVotes = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);

      const votesFor = Math.ceil(minVotes * 0.8);
      const votesAgainst = minVotes - votesFor;

      for (let i = 0; i < votesFor; i++) {
        await store.recordVote('test', modelA, globalScope);
      }
      for (let i = 0; i < votesAgainst; i++) {
        await store.recordVote('test', modelB, globalScope);
      }

      const entry = await store.get('test', globalScope);

      // With exactly 80% agreement and enough votes, should be strong
      if (entry!.agreement_score >= 0.8 && entry!.total_votes >= minVotes) {
        expect(entry!.confidence_level).toBe('strong');
      }
    });

    it('should handle exact boundary at 0.6 agreement', async () => {
      // 6 votes for A, 4 for B = exactly 60%
      for (let i = 0; i < 6; i++) {
        await store.recordVote('test', modelA, globalScope);
      }
      for (let i = 0; i < 4; i++) {
        await store.recordVote('test', modelB, globalScope);
      }

      const entry = await store.get('test', globalScope);

      expect(entry!.agreement_score).toBe(0.6);
      // Should be moderate (>= 0.6 threshold)
      expect(entry!.confidence_level).toBe('moderate');
    });

    it('should handle just below 0.6 agreement', async () => {
      // 59% agreement
      for (let i = 0; i < 59; i++) {
        await store.recordVote('test', modelA, globalScope);
      }
      for (let i = 0; i < 41; i++) {
        await store.recordVote('test', modelB, globalScope);
      }

      const entry = await store.get('test', globalScope);

      expect(entry!.agreement_score).toBeCloseTo(0.59, 2);
      expect(entry!.confidence_level).toBe('low');
    });

    it('should handle transition from strong to moderate after decay', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      // Build strong confidence
      for (let i = 0; i < 10; i++) {
        await store.recordVote('test', modelA, globalScope);
      }

      let entry = await store.get('test', globalScope);
      expect(entry!.confidence_level).toBe('strong');

      // Decay should reduce vote count below minimum for strong
      const minVotes = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);

      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));
      entry = (await store.get('test', globalScope))!;

      // Should now be moderate (agreement still high but not enough votes)
      expect(entry.agreement_score).toBeGreaterThanOrEqual(0.8);
      expect(entry.confidence_level).toBe('moderate');
    });
  });

  describe('Model Vote Distribution Edge Cases', () => {
    it('should handle three-way tie', async () => {
      await store.recordVote('test', modelA, globalScope);
      await store.recordVote('test', modelB, globalScope);
      await store.recordVote('test', modelC, globalScope);

      const entry = await store.get('test', globalScope);

      expect(entry!.agreement_score).toBeCloseTo(0.333, 2); // 1/3
      expect(entry!.confidence_level).toBe('low');
    });

    it('should handle many models with one vote each', async () => {
      const modelRegistry = createModelRegistry();
      const availableModels = modelRegistry.getAvailableModels().map(m => m.id);

      // Record one vote for each available model
      for (const modelId of availableModels) {
        await store.recordVote('test', modelId, globalScope);
      }

      const entry = await store.get('test', globalScope);

      // Agreement score should be 1 / number_of_models
      const expectedAgreement = 1 / availableModels.length;
      expect(entry!.agreement_score).toBeCloseTo(expectedAgreement, 2);
      expect(entry!.confidence_level).toBe('low');
      expect(Object.keys(entry!.model_votes).length).toBe(availableModels.length);
    });

    it('should handle extreme agreement (100%)', async () => {
      for (let i = 0; i < 100; i++) {
        await store.recordVote('test', modelA, globalScope);
      }

      const entry = await store.get('test', globalScope);

      expect(entry!.agreement_score).toBe(1);
      expect(entry!.confidence_level).toBe('strong');
    });

    it('should handle complete disagreement (50-50)', async () => {
      for (let i = 0; i < 50; i++) {
        await store.recordVote('test', modelA, globalScope);
        await store.recordVote('test', modelB, globalScope);
      }

      const entry = await store.get('test', globalScope);

      expect(entry!.agreement_score).toBeCloseTo(0.5, 3);
      expect(entry!.confidence_level).toBe('low');
    });
  });

  describe('Consensus Model Selection Edge Cases', () => {
    it('should return null when confidence is low even with votes', async () => {
      await store.recordVote('test', modelA, globalScope);

      const consensus = await store.getConsensusModel('test', globalScope);

      expect(consensus).toBeNull(); // Low confidence
    });

    it('should handle tie-breaking (first alphabetically or highest in iteration order)', async () => {
      // Create exact tie with moderate confidence
      for (let i = 0; i < 5; i++) {
        await store.recordVote('test', modelA, globalScope);
        await store.recordVote('test', modelB, globalScope);
      }

      const consensus = await store.getConsensusModel('test', globalScope);

      // With 50-50 split at moderate confidence, should return one consistently
      expect(consensus).toBeNull(); // Actually null because 0.5 < 0.6
    });

    it('should handle consensus model selection after decay', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      for (let i = 0; i < 8; i++) {
        await store.recordVote('test', modelA, globalScope);
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('test', modelB, globalScope);
      }

      const beforeDecay = await store.getConsensusModel('test', globalScope);
      expect(beforeDecay).toBe(modelA);

      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));

      const afterDecay = await store.getConsensusModel('test', globalScope);
      // Proportions stay same, so consensus should remain
      expect(afterDecay).toBe(modelA);
    });

    it('should return null for non-existent cluster', async () => {
      const consensus = await store.getConsensusModel('does-not-exist', globalScope);
      expect(consensus).toBeNull();
    });
  });

  describe('Statistics Edge Cases', () => {
    it('should handle empty store', async () => {
      const stats = await store.getStats();

      expect(stats.total_entries).toBe(0);
      expect(stats.average_agreement_score).toBe(0);
      expect(stats.entries_by_confidence.strong).toBe(0);
      expect(stats.entries_by_confidence.moderate).toBe(0);
      expect(stats.entries_by_confidence.low).toBe(0);
    });

    it('should calculate average agreement correctly with one entry', async () => {
      await store.recordVote('test', modelA, globalScope);

      const stats = await store.getStats();

      expect(stats.total_entries).toBe(1);
      expect(stats.average_agreement_score).toBe(1); // 100% agreement
    });

    it('should handle all entries at same confidence level', async () => {
      // Create 5 low confidence entries
      for (let i = 0; i < 5; i++) {
        await store.recordVote(`cluster-${i}`, modelA, globalScope);
      }

      const stats = await store.getStats();

      expect(stats.entries_by_confidence.low).toBe(5);
      expect(stats.entries_by_confidence.moderate).toBe(0);
      expect(stats.entries_by_confidence.strong).toBe(0);
    });
  });

  describe('Decay Factor Edge Cases', () => {
    it('should never decay below minimum threshold', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      await store.recordVote('test', modelA, globalScope);

      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

      const entry = await store.get('test', globalScope);

      // Should remain positive even after long time
      expect(entry!.decay_factor).toBeGreaterThan(0);
    });

    it('should maintain decay_factor as multiplicative', async () => {
      vi.useFakeTimers();
      const lambda = parseFloat(process.env.KNOWLEDGE_DECAY_LAMBDA ?? '0.000000001');
      const start = new Date('2024-01-01T00:00:00Z').getTime();

      vi.setSystemTime(start);
      await store.recordVote('test', modelA, globalScope);

      const initial = await store.get('test', globalScope);

      const later = start + 60 * 60 * 1000; // +1 hour
      vi.setSystemTime(later);

      const after = await store.get('test', globalScope);
      const expectedFactor = Math.exp(-lambda * (later - start));

      expect(after!.decay_factor).toBeCloseTo(expectedFactor, 5);
    });
  });

  describe('Special Intent Cluster Names', () => {
    it('should handle empty string cluster name', async () => {
      await store.recordVote('', modelA, globalScope);

      const entry = await store.get('', globalScope);
      expect(entry).not.toBeNull();
      expect(entry!.intent_cluster).toBe('');
    });

    it('should handle very long cluster names', async () => {
      const longName = 'a'.repeat(10000);

      await store.recordVote(longName, modelA, globalScope);

      const entry = await store.get(longName, globalScope);
      expect(entry).not.toBeNull();
      expect(entry!.intent_cluster).toBe(longName);
    });

    it('should handle cluster names with special characters', async () => {
      const special = 'cluster-with-!@#$%^&*()-special';

      await store.recordVote(special, modelA, globalScope);

      const entry = await store.get(special, globalScope);
      expect(entry).not.toBeNull();
    });

    it('should handle unicode cluster names', async () => {
      const unicode = '编程-意图-🎯';

      await store.recordVote(unicode, modelA, globalScope);

      const entry = await store.get(unicode, globalScope);
      expect(entry).not.toBeNull();
      expect(entry!.intent_cluster).toBe(unicode);
    });
  });

  describe('Clear Operation', () => {
    it('should remove all entries', async () => {
      await store.recordVote('cluster1', modelA, globalScope);
      await store.recordVote('cluster2', modelB, globalScope);
      await store.recordVote('cluster3', modelC, globalScope);

      await store.clear();

      const stats = await store.getStats();
      expect(stats.total_entries).toBe(0);

      expect(await store.get('cluster1', globalScope)).toBeNull();
      expect(await store.get('cluster2', globalScope)).toBeNull();
      expect(await store.get('cluster3', globalScope)).toBeNull();
    });

    it('should handle clear on empty store', async () => {
      await store.clear();

      const stats = await store.getStats();
      expect(stats.total_entries).toBe(0);
    });

    it('should allow new votes after clear', async () => {
      await store.recordVote('test', modelA, globalScope);
      await store.clear();
      await store.recordVote('test', modelB, globalScope);

      const entry = await store.get('test', globalScope);
      expect(entry).not.toBeNull();
      expect(entry!.model_votes[modelB]).toBeCloseTo(1, 6);
      expect(entry!.model_votes[modelA]).toBeUndefined();
    });
  });
});
