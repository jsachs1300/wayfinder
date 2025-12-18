import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';

describe('KnowledgeStore', () => {
  let store: InMemoryKnowledgeStore;

  beforeEach(async () => {
    store = new InMemoryKnowledgeStore();
  });

  describe('Agreement Score Calculation', () => {
    it('should calculate agreement_score as max_votes / total_votes', async () => {
      // Record 8 votes for model A, 2 for model B
      for (let i = 0; i < 8; i++) {
        await store.recordVote('coding', 'model-a');
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('coding', 'model-b');
      }

      const entry = await store.get('coding');

      expect(entry).not.toBeNull();
      expect(entry!.agreement_score).toBe(0.8); // 8/10 = 0.8
    });

    it('should return 1.0 agreement when only one model has votes', async () => {
      await store.recordVote('coding', 'model-a');
      await store.recordVote('coding', 'model-a');
      await store.recordVote('coding', 'model-a');

      const entry = await store.get('coding');

      expect(entry!.agreement_score).toBe(1); // 3/3 = 1.0
    });

    it('should handle equal distribution (disagreement)', async () => {
      await store.recordVote('coding', 'model-a');
      await store.recordVote('coding', 'model-b');

      const entry = await store.get('coding');

      expect(entry!.agreement_score).toBe(0.5); // 1/2 = 0.5
    });
  });

  describe('Confidence Level Calculation', () => {
    it('should assign strong confidence when agreement >= 0.8 with enough votes', async () => {
      // 10 votes for same model = 100% agreement
      for (let i = 0; i < 10; i++) {
        await store.recordVote('coding', 'model-a');
      }

      const entry = await store.get('coding');

      expect(entry!.confidence_level).toBe('strong');
    });

    it('should assign moderate confidence when agreement >= 0.6', async () => {
      // 7 votes for A, 3 for B = 70% agreement
      for (let i = 0; i < 7; i++) {
        await store.recordVote('coding', 'model-a');
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', 'model-b');
      }

      const entry = await store.get('coding');

      expect(entry!.agreement_score).toBe(0.7);
      expect(entry!.confidence_level).toBe('moderate');
    });

    it('should assign low confidence when agreement < 0.6', async () => {
      // 3 votes for A, 3 for B, 2 for C = 37.5% agreement
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', 'model-a');
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', 'model-b');
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('coding', 'model-c');
      }

      const entry = await store.get('coding');

      expect(entry!.agreement_score).toBe(0.375); // 3/8
      expect(entry!.confidence_level).toBe('low');
    });

    it('should require minimum votes for strong confidence', async () => {
      // High agreement but only 2 votes
      await store.recordVote('coding', 'model-a');
      await store.recordVote('coding', 'model-a');

      const entry = await store.get('coding');

      // 100% agreement but not enough votes
      expect(entry!.agreement_score).toBe(1);
      expect(entry!.confidence_level).not.toBe('strong');
    });
  });

  describe('Knowledge Decay Behavior', () => {
    it('should reduce vote counts on decay', async () => {
      // Initial votes
      for (let i = 0; i < 10; i++) {
        await store.recordVote('coding', 'model-a');
      }

      const before = await store.get('coding');
      expect(before!.total_votes).toBe(10);

      // Apply decay
      await store.applyDecay();

      const after = await store.get('coding');
      expect(after!.total_votes).toBeLessThan(10);
    });

    it('should never delete entries on decay', async () => {
      await store.recordVote('coding', 'model-a');

      // Apply many decay cycles
      for (let i = 0; i < 100; i++) {
        await store.applyDecay();
      }

      const entry = await store.get('coding');

      // Entry should still exist
      expect(entry).not.toBeNull();
      expect(entry!.model_votes['model-a']).toBeGreaterThan(0);
    });

    it('should reduce decay_factor over time', async () => {
      await store.recordVote('coding', 'model-a');
      const before = await store.get('coding');

      await store.applyDecay();

      const after = await store.get('coding');
      expect(after!.decay_factor).toBeLessThan(before!.decay_factor);
    });

    it('should maintain relative vote proportions after decay', async () => {
      // 8 votes for A, 2 for B
      for (let i = 0; i < 8; i++) {
        await store.recordVote('coding', 'model-a');
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('coding', 'model-b');
      }

      const before = await store.get('coding');
      const ratioBefore =
        before!.model_votes['model-a']! / before!.model_votes['model-b']!;

      await store.applyDecay();

      const after = await store.get('coding');
      const ratioAfter =
        after!.model_votes['model-a']! / after!.model_votes['model-b']!;

      // Ratio should remain approximately the same
      expect(Math.abs(ratioBefore - ratioAfter)).toBeLessThan(0.01);
    });
  });

  describe('Consensus Model Selection', () => {
    it('should return model with most votes as consensus', async () => {
      for (let i = 0; i < 7; i++) {
        await store.recordVote('coding', 'model-a');
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', 'model-b');
      }

      const consensus = await store.getConsensusModel('coding');

      expect(consensus).toBe('model-a');
    });

    it('should return null for low confidence entries', async () => {
      // Only 1 vote = low confidence
      await store.recordVote('coding', 'model-a');

      const consensus = await store.getConsensusModel('coding');

      expect(consensus).toBeNull();
    });

    it('should return null for non-existent cluster', async () => {
      const consensus = await store.getConsensusModel('non-existent');

      expect(consensus).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('should track entries by confidence level', async () => {
      // Create strong confidence entry
      for (let i = 0; i < 10; i++) {
        await store.recordVote('strong-intent', 'model-a');
      }

      // Create moderate confidence entry
      for (let i = 0; i < 7; i++) {
        await store.recordVote('moderate-intent', 'model-a');
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('moderate-intent', 'model-b');
      }

      // Create low confidence entry
      await store.recordVote('low-intent', 'model-a');

      const stats = await store.getStats();

      expect(stats.total_entries).toBe(3);
      expect(stats.entries_by_confidence.strong).toBe(1);
      expect(stats.entries_by_confidence.moderate).toBe(1);
      expect(stats.entries_by_confidence.low).toBe(1);
    });

    it('should calculate average agreement score', async () => {
      // Entry 1: 100% agreement
      for (let i = 0; i < 5; i++) {
        await store.recordVote('intent-1', 'model-a');
      }

      // Entry 2: 50% agreement
      await store.recordVote('intent-2', 'model-a');
      await store.recordVote('intent-2', 'model-b');

      const stats = await store.getStats();

      expect(stats.average_agreement_score).toBe(0.75); // (1 + 0.5) / 2
    });
  });
});
