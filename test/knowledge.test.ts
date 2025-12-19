import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { KnowledgeScopeContext } from '../src/types';
import { createModelRegistry } from '../src/models';

describe('KnowledgeStore', () => {
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

  describe('Agreement Score Calculation', () => {
    it('should calculate agreement_score as max_votes / total_votes', async () => {
      // Record 8 votes for model A, 2 for model B
      for (let i = 0; i < 8; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('coding', modelB, globalScope);
      }

      const entry = await store.get('coding', globalScope);

      expect(entry).not.toBeNull();
      expect(entry!.agreement_score).toBeCloseTo(0.8, 3); // 8/10 = 0.8
    });

    it('should return 1.0 agreement when only one model has votes', async () => {
      await store.recordVote('coding', modelA, globalScope);
      await store.recordVote('coding', modelA, globalScope);
      await store.recordVote('coding', modelA, globalScope);

      const entry = await store.get('coding', globalScope);

      expect(entry!.agreement_score).toBe(1); // 3/3 = 1.0
    });

    it('should handle equal distribution (disagreement)', async () => {
      await store.recordVote('coding', modelA, globalScope);
      await store.recordVote('coding', modelB, globalScope);

      const entry = await store.get('coding', globalScope);

      expect(entry!.agreement_score).toBeCloseTo(0.5, 3); // 1/2 = 0.5
    });
  });

  describe('Confidence Level Calculation', () => {
    it('should assign strong confidence when agreement >= 0.8 with enough votes', async () => {
      // 10 votes for same model = 100% agreement
      for (let i = 0; i < 10; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }

      const entry = await store.get('coding', globalScope);

      expect(entry!.confidence_level).toBe('strong');
    });

    it('should assign moderate confidence when agreement >= 0.6', async () => {
      // 7 votes for A, 3 for B = 70% agreement
      for (let i = 0; i < 7; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', modelB, globalScope);
      }

      const entry = await store.get('coding', globalScope);

      expect(entry!.agreement_score).toBeCloseTo(0.7, 3);
      expect(entry!.confidence_level).toBe('moderate');
    });

    it('should assign low confidence when agreement < 0.6', async () => {
      // 3 votes for A, 3 for B, 2 for C = 37.5% agreement
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', modelB, globalScope);
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('coding', modelC, globalScope);
      }

      const entry = await store.get('coding', globalScope);

      expect(entry!.agreement_score).toBe(0.375); // 3/8
      expect(entry!.confidence_level).toBe('low');
    });

    it('should require minimum votes for strong confidence', async () => {
      // High agreement but only 2 votes
      await store.recordVote('coding', modelA, globalScope);
      await store.recordVote('coding', modelA, globalScope);

      const entry = await store.get('coding', globalScope);

      // 100% agreement but not enough votes
      expect(entry!.agreement_score).toBe(1);
      expect(entry!.confidence_level).not.toBe('strong');
    });
  });

  describe('Knowledge Decay Behavior', () => {
    it('applies decay lazily on read', async () => {
      vi.useFakeTimers();
      const start = new Date('2024-01-01T00:00:00.000Z');
      vi.setSystemTime(start);

      for (let i = 0; i < 10; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }

      const immediate = await store.get('coding', globalScope);
      expect(immediate!.total_votes).toBe(10);

      const later = new Date(start.getTime() + 60 * 60 * 1000);
      vi.setSystemTime(later);

      const decayed = await store.get('coding', globalScope);
      expect(decayed!.total_votes).toBeLessThan(immediate!.total_votes);
      expect(decayed!.decay_factor).toBeLessThan(1);
    });

    it('maintains proportions when decayed at read time', async () => {
      vi.useFakeTimers();
      const start = new Date('2024-01-01T00:00:00.000Z');
      vi.setSystemTime(start);

      for (let i = 0; i < 8; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }
      for (let i = 0; i < 2; i++) {
        await store.recordVote('coding', modelB, globalScope);
      }

      const baseline = await store.get('coding', globalScope);
      const ratioBefore = baseline!.model_votes[modelA]! / baseline!.model_votes[modelB]!;

      vi.setSystemTime(new Date(start.getTime() + 30 * 60 * 1000));
      const decayed = await store.get('coding', globalScope);
      const ratioAfter = decayed!.model_votes[modelA]! / decayed!.model_votes[modelB]!;

      expect(Math.abs(ratioBefore - ratioAfter)).toBeLessThan(0.01);
    });
  });

  describe('Consensus Model Selection', () => {
    it('should return model with most votes as consensus', async () => {
      for (let i = 0; i < 7; i++) {
        await store.recordVote('coding', modelA, globalScope);
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('coding', modelB, globalScope);
      }

      const consensus = await store.getConsensusModel('coding', globalScope);

      expect(consensus).toBe(modelA);
    });

    it('should return null for low confidence entries', async () => {
      // Only 1 vote = low confidence
      await store.recordVote('coding', modelA, globalScope);

      const consensus = await store.getConsensusModel('coding', globalScope);

      expect(consensus).toBeNull();
    });

    it('should return null for non-existent cluster', async () => {
      const consensus = await store.getConsensusModel('non-existent', globalScope);

      expect(consensus).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('should track entries by confidence level', async () => {
      // Create strong confidence entry
      for (let i = 0; i < 10; i++) {
        await store.recordVote('strong-intent', modelA, globalScope);
      }

      // Create moderate confidence entry
      for (let i = 0; i < 7; i++) {
        await store.recordVote('moderate-intent', modelA, globalScope);
      }
      for (let i = 0; i < 3; i++) {
        await store.recordVote('moderate-intent', modelB, globalScope);
      }

      // Create low confidence entry
      await store.recordVote('low-intent', modelA, globalScope);

      const stats = await store.getStats();

      expect(stats.total_entries).toBe(3);
      expect(stats.total_raw_score).toBeCloseTo(21, 6);
      expect(stats.entries_by_confidence.strong).toBe(1);
      expect(stats.entries_by_confidence.moderate).toBe(1);
      expect(stats.entries_by_confidence.low).toBe(1);
      expect(stats.average_agreement_score).toBeCloseTo(0.9);
      expect(stats.approximate_effective_score).toBeLessThanOrEqual(stats.total_raw_score);
    });

    it('should calculate average agreement score', async () => {
      // Entry 1: 100% agreement
      for (let i = 0; i < 5; i++) {
        await store.recordVote('intent-1', modelA, globalScope);
      }

      // Entry 2: 50% agreement
      await store.recordVote('intent-2', modelA, globalScope);
      await store.recordVote('intent-2', modelB, globalScope);

      const stats = await store.getStats();

      expect(stats.average_agreement_score).toBeCloseTo(0.75); // (1 + 0.5) / 2
      expect(stats.total_raw_score).toBeCloseTo(7, 6);
    });
  });
});
