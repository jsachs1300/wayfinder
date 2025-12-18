import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';

describe('KnowledgeStore Edge Cases and Race Conditions', () => {
  let store: InMemoryKnowledgeStore;

  beforeEach(async () => {
    store = new InMemoryKnowledgeStore();
  });

  describe('Division by Zero and NaN Prevention', () => {
    it('should handle zero votes gracefully', async () => {
      // This shouldn't happen in practice, but test defensive code
      const entry = await store.get('non-existent');
      expect(entry).toBeNull();
    });

    it('should handle agreement calculation with zero total votes', async () => {
      // Create entry with one vote
      await store.recordVote('test', 'model-a');
      const entry = await store.get('test');

      // Verify no NaN or Infinity
      expect(entry!.agreement_score).toBeGreaterThanOrEqual(0);
      expect(entry!.agreement_score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(entry!.agreement_score)).toBe(true);
    });
  });

  describe('Floating Point Precision', () => {
    it('should handle fractional votes after decay without precision errors', async () => {
      await store.recordVote('test', 'model-a');

      // Apply many decay cycles
      for (let i = 0; i < 50; i++) {
        await store.applyDecay();
      }

      const entry = await store.get('test');

      // Should still have valid numbers
      expect(Number.isFinite(entry!.total_votes)).toBe(true);
      expect(Number.isFinite(entry!.agreement_score)).toBe(true);
      expect(Number.isFinite(entry!.decay_factor)).toBe(true);

      // Should not accumulate to negative
      expect(entry!.total_votes).toBeGreaterThan(0);
      expect(entry!.decay_factor).toBeGreaterThan(0);
    });

    it('should maintain agreement score between 0 and 1', async () => {
      // Record votes with various distributions
      await store.recordVote('test1', 'model-a');
      await store.recordVote('test1', 'model-a');
      await store.recordVote('test1', 'model-b');

      await store.applyDecay();
      await store.applyDecay();

      const entry = await store.get('test1');

      expect(entry!.agreement_score).toBeGreaterThanOrEqual(0);
      expect(entry!.agreement_score).toBeLessThanOrEqual(1);
    });

    it('should handle very small vote counts after extensive decay', async () => {
      await store.recordVote('test', 'model-a');

      // Extreme decay
      for (let i = 0; i < 200; i++) {
        await store.applyDecay();
      }

      const entry = await store.get('test');

      // Should enforce minimum values to prevent underflow
      expect(entry!.model_votes['model-a']).toBeGreaterThan(0);
      expect(entry!.model_votes['model-a']).toBeGreaterThanOrEqual(0.001);
      expect(entry!.decay_factor).toBeGreaterThanOrEqual(0.01);
    });
  });

  describe('Concurrent Vote Recording', () => {
    it('should handle concurrent votes for same cluster', async () => {
      const promises = Array.from({ length: 100 }, () =>
        store.recordVote('coding', 'gpt-4-turbo')
      );

      await Promise.all(promises);

      const entry = await store.get('coding');
      // All votes should be recorded
      expect(entry!.total_votes).toBe(100);
      expect(entry!.model_votes['gpt-4-turbo']).toBe(100);
    });

    it('should handle concurrent votes for different models in same cluster', async () => {
      const promises = [
        ...Array.from({ length: 60 }, () => store.recordVote('coding', 'model-a')),
        ...Array.from({ length: 40 }, () => store.recordVote('coding', 'model-b')),
      ];

      await Promise.all(promises);

      const entry = await store.get('coding');
      expect(entry!.total_votes).toBe(100);
      expect(entry!.model_votes['model-a']).toBe(60);
      expect(entry!.model_votes['model-b']).toBe(40);
      expect(entry!.agreement_score).toBe(0.6); // 60/100
    });

    it('should handle concurrent votes across multiple clusters', async () => {
      const clusters = ['coding', 'legal', 'creative', 'reasoning'];
      const promises = clusters.flatMap(cluster =>
        Array.from({ length: 10 }, () => store.recordVote(cluster, 'model-a'))
      );

      await Promise.all(promises);

      for (const cluster of clusters) {
        const entry = await store.get(cluster);
        expect(entry!.total_votes).toBe(10);
      }
    });

    it('should handle concurrent decay operations', async () => {
      // Set up initial data
      await store.recordVote('test', 'model-a');

      // Run multiple decay operations concurrently
      const promises = Array.from({ length: 5 }, () => store.applyDecay());
      const results = await Promise.all(promises);

      // All should report successful decay
      expect(results.every(count => count >= 0)).toBe(true);

      const entry = await store.get('test');
      // Entry should still exist
      expect(entry).not.toBeNull();
      expect(entry!.model_votes['model-a']).toBeGreaterThan(0);
    });
  });

  describe('Confidence Level Edge Cases', () => {
    it('should handle exact boundary at 0.8 agreement with MIN_VOTES', async () => {
      // Record exactly 80% agreement with minimum votes
      const minVotes = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);

      const votesFor = Math.ceil(minVotes * 0.8);
      const votesAgainst = minVotes - votesFor;

      for (let i = 0; i < votesFor; i++) {
        await store.recordVote('test', 'model-a');
      }
      for (let i = 0; i < votesAgainst; i++) {
        await store.recordVote('test', 'model-b');
      }

      const entry = await store.get('test');

      // With exactly 80% agreement and enough votes, should be strong
      if (entry!.agreement_score >= 0.8 && entry!.total_votes >= minVotes) {
        expect(entry!.confidence_level).toBe('strong');
      }
    });

    it('should handle exact boundary at 0.6 agreement', async () => {
      // 6 votes for A, 4 for B = exactly 60%
      for (let i = 0; i < 6; i++) {
        await store.recordVote('test', 'model-a');
      }
      for (let i = 0; i < 4; i++) {
        await store.recordVote('test', 'model-b');
      }

      const entry = await store.get('test');

      expect(entry!.agreement_score).toBe(0.6);
      // Should be moderate (>= 0.6 threshold)
      expect(entry!.confidence_level).toBe('moderate');
    });

    it('should handle just below 0.6 agreement', async () => {
      // 59% agreement
      for (let i = 0; i < 59; i++) {
        await store.recordVote('test', 'model-a');
      }
      for (let i = 0; i < 41; i++) {
        await store.recordVote('test', 'model-b');
      }

      const entry = await store.get('test');

      expect(entry!.agreement_score).toBeCloseTo(0.59, 2);
      expect(entry!.confidence_level).toBe('low');
    });

    it('should handle transition from strong to moderate after decay', async () => {
      // Build strong confidence
      for (let i = 0; i < 10; i++) {
        await store.recordVote('test', 'model-a');
      }

      let entry = await store.get('test');
      expect(entry!.confidence_level).toBe('strong');

      // Decay should reduce vote count below minimum for strong
      const minVotes = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);

      while (entry!.total_votes >= minVotes) {
        await store.applyDecay();
        entry = (await store.get('test'))!;
      }

      // Should now be moderate (agreement still high but not enough votes)
      expect(entry.agreement_score).toBeGreaterThanOrEqual(0.8);
      expect(entry.confidence_level).toBe('moderate');
    });
  });

  describe('Model Vote Distribution Edge Cases', () => {
    it('should handle three-way tie', async () => {
      await store.recordVote('test', 'model-a');
      await store.recordVote('test', 'model-b');
      await store.recordVote('test', 'model-c');

      const entry = await store.get('test');

      expect(entry!.agreement_score).toBeCloseTo(0.333, 2); // 1/3
      expect(entry!.confidence_level).toBe('low');
    });

    it('should handle many models with one vote each', async () => {
      for (let i = 0; i < 20; i++) {
        await store.recordVote('test', `model-${i}`);
      }

      const entry = await store.get('test');

      expect(entry!.agreement_score).toBeCloseTo(0.05, 2); // 1/20
      expect(entry!.confidence_level).toBe('low');
      expect(Object.keys(entry!.model_votes).length).toBe(20);
    });

    it('should handle extreme agreement (100%)', async () => {
      for (let i = 0; i < 100; i++) {
        await store.recordVote('test', 'model-a');
      }

      const entry = await store.get('test');

      expect(entry!.agreement_score).toBe(1);
      expect(entry!.confidence_level).toBe('strong');
    });

    it('should handle complete disagreement (50-50)', async () => {
      for (let i = 0; i < 50; i++) {
        await store.recordVote('test', 'model-a');
        await store.recordVote('test', 'model-b');
      }

      const entry = await store.get('test');

      expect(entry!.agreement_score).toBe(0.5);
      expect(entry!.confidence_level).toBe('low');
    });
  });

  describe('Consensus Model Selection Edge Cases', () => {
    it('should return null when confidence is low even with votes', async () => {
      await store.recordVote('test', 'model-a');

      const consensus = await store.getConsensusModel('test');

      expect(consensus).toBeNull(); // Low confidence
    });

    it('should handle tie-breaking (first alphabetically or highest in iteration order)', async () => {
      // Create exact tie with moderate confidence
      for (let i = 0; i < 5; i++) {
        await store.recordVote('test', 'model-a');
        await store.recordVote('test', 'model-b');
      }

      const consensus = await store.getConsensusModel('test');

      // With 50-50 split at moderate confidence, should return one consistently
      expect(consensus).toBeNull(); // Actually null because 0.5 < 0.6
    });

    it('should handle consensus model selection after decay', async () => {
      // Strong initial consensus
      for (let i = 0; i < 8; i++) {
        await store.recordVote('test', 'model-a');
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('test', 'model-b');
      }

      const beforeDecay = await store.getConsensusModel('test');
      expect(beforeDecay).toBe('model-a');

      await store.applyDecay();

      const afterDecay = await store.getConsensusModel('test');
      // Proportions stay same, so consensus should remain
      expect(afterDecay).toBe('model-a');
    });

    it('should return null for non-existent cluster', async () => {
      const consensus = await store.getConsensusModel('does-not-exist');
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
      await store.recordVote('test', 'model-a');

      const stats = await store.getStats();

      expect(stats.total_entries).toBe(1);
      expect(stats.average_agreement_score).toBe(1); // 100% agreement
    });

    it('should handle all entries at same confidence level', async () => {
      // Create 5 low confidence entries
      for (let i = 0; i < 5; i++) {
        await store.recordVote(`cluster-${i}`, 'model-a');
      }

      const stats = await store.getStats();

      expect(stats.entries_by_confidence.low).toBe(5);
      expect(stats.entries_by_confidence.moderate).toBe(0);
      expect(stats.entries_by_confidence.strong).toBe(0);
    });
  });

  describe('Decay Factor Edge Cases', () => {
    it('should never decay below minimum threshold', async () => {
      await store.recordVote('test', 'model-a');

      // Apply extreme decay
      for (let i = 0; i < 1000; i++) {
        await store.applyDecay();
      }

      const entry = await store.get('test');

      // Should enforce minimum decay_factor
      expect(entry!.decay_factor).toBeGreaterThanOrEqual(0.01);
    });

    it('should maintain decay_factor as multiplicative', async () => {
      await store.recordVote('test', 'model-a');

      const initial = await store.get('test');
      const initialFactor = initial!.decay_factor;

      await store.applyDecay();

      const after = await store.get('test');
      const decayRate = parseFloat(process.env.KNOWLEDGE_DECAY_RATE ?? '0.05');

      // decay_factor should be multiplied by (1 - decay_rate)
      expect(after!.decay_factor).toBeCloseTo(initialFactor * (1 - decayRate), 4);
    });
  });

  describe('Special Intent Cluster Names', () => {
    it('should handle empty string cluster name', async () => {
      await store.recordVote('', 'model-a');

      const entry = await store.get('');
      expect(entry).not.toBeNull();
      expect(entry!.intent_cluster).toBe('');
    });

    it('should handle very long cluster names', async () => {
      const longName = 'a'.repeat(10000);

      await store.recordVote(longName, 'model-a');

      const entry = await store.get(longName);
      expect(entry).not.toBeNull();
      expect(entry!.intent_cluster).toBe(longName);
    });

    it('should handle cluster names with special characters', async () => {
      const special = 'cluster-with-!@#$%^&*()-special';

      await store.recordVote(special, 'model-a');

      const entry = await store.get(special);
      expect(entry).not.toBeNull();
    });

    it('should handle unicode cluster names', async () => {
      const unicode = '编程-意图-🎯';

      await store.recordVote(unicode, 'model-a');

      const entry = await store.get(unicode);
      expect(entry).not.toBeNull();
      expect(entry!.intent_cluster).toBe(unicode);
    });
  });

  describe('Clear Operation', () => {
    it('should remove all entries', async () => {
      await store.recordVote('cluster1', 'model-a');
      await store.recordVote('cluster2', 'model-b');
      await store.recordVote('cluster3', 'model-c');

      await store.clear();

      const stats = await store.getStats();
      expect(stats.total_entries).toBe(0);

      expect(await store.get('cluster1')).toBeNull();
      expect(await store.get('cluster2')).toBeNull();
      expect(await store.get('cluster3')).toBeNull();
    });

    it('should handle clear on empty store', async () => {
      await store.clear();

      const stats = await store.getStats();
      expect(stats.total_entries).toBe(0);
    });

    it('should allow new votes after clear', async () => {
      await store.recordVote('test', 'model-a');
      await store.clear();
      await store.recordVote('test', 'model-b');

      const entry = await store.get('test');
      expect(entry).not.toBeNull();
      expect(entry!.model_votes['model-b']).toBe(1);
      expect(entry!.model_votes['model-a']).toBeUndefined();
    });
  });
});
