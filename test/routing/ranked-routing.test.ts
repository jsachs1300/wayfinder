/**
 * Ranked Routing Utilities Tests
 *
 * Tests for ranked routing conversion and validation including:
 * - toLegacyRouteDecision conversion
 * - validateRankedRouteDecision validation
 */

import { describe, it, expect } from 'vitest';
import { toLegacyRouteDecision, validateRankedRouteDecision } from '../../src/routing/ranked-routing';
import type { RankedRouteDecision } from '../../src/types';

describe('toLegacyRouteDecision', () => {
  it('should convert ranked decision to legacy format with top 2 models', () => {
    const ranked: RankedRouteDecision = {
      intent: 'coding',
      ranked_models: [
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Excellent for coding' },
        { rank: 2, model: 'claude-3-sonnet', score: 8, reason: 'Good alternative' },
        { rank: 3, model: 'mistral-large', score: 7, reason: 'Solid option' },
      ],
    };

    const legacy = toLegacyRouteDecision(ranked);

    expect(legacy).toEqual({
      intent: 'coding',
      primary: {
        model: 'gpt-4-turbo',
        score: 9,
        reason: 'Excellent for coding',
      },
      alternate: {
        model: 'claude-3-sonnet',
        score: 8,
        reason: 'Good alternative',
      },
    });
  });

  it('should use primary as alternate when only one model available', () => {
    const ranked: RankedRouteDecision = {
      intent: 'coding',
      ranked_models: [
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Only option' },
      ],
    };

    const legacy = toLegacyRouteDecision(ranked);

    expect(legacy.primary.model).toBe('gpt-4-turbo');
    expect(legacy.alternate.model).toBe('gpt-4-turbo');
    expect(legacy.alternate.score).toBe(7.2); // 9 * 0.8
    expect(legacy.alternate.reason).toBe('Fallback to primary (only available option)');
  });

  it('should sort by rank before conversion (defensive)', () => {
    const ranked: RankedRouteDecision = {
      intent: 'coding',
      ranked_models: [
        { rank: 3, model: 'mistral-large', score: 7, reason: 'Third' },
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'First' },
        { rank: 2, model: 'claude-3-sonnet', score: 8, reason: 'Second' },
      ],
    };

    const legacy = toLegacyRouteDecision(ranked);

    expect(legacy.primary.model).toBe('gpt-4-turbo');
    expect(legacy.alternate.model).toBe('claude-3-sonnet');
  });

  it('should throw error if ranked list is empty', () => {
    const ranked: RankedRouteDecision = {
      intent: 'coding',
      ranked_models: [],
    };

    expect(() => toLegacyRouteDecision(ranked)).toThrow('Ranked list must contain at least one model');
  });
});

describe('validateRankedRouteDecision', () => {
  const eligibleModels = ['gpt-4-turbo', 'claude-3-sonnet', 'mistral-large'];

  it('should validate correct ranked decision', () => {
    const raw = {
      intent: 'coding',
      ranked_models: [
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
        { rank: 2, model: 'claude-3-sonnet', score: 8, reason: 'Good alternative' },
        { rank: 3, model: 'mistral-large', score: 7, reason: 'Solid option' },
      ],
    };

    const validated = validateRankedRouteDecision(raw, eligibleModels);

    expect(validated).toEqual({
      intent: 'coding',
      ranked_models: [
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
        { rank: 2, model: 'claude-3-sonnet', score: 8, reason: 'Good alternative' },
        { rank: 3, model: 'mistral-large', score: 7, reason: 'Solid option' },
      ],
    });
  });

  it('should sort ranked models by rank', () => {
    const raw = {
      intent: 'coding',
      ranked_models: [
        { rank: 3, model: 'mistral-large', score: 7, reason: 'Third' },
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'First' },
        { rank: 2, model: 'claude-3-sonnet', score: 8, reason: 'Second' },
      ],
    };

    const validated = validateRankedRouteDecision(raw, eligibleModels);

    expect(validated.ranked_models[0].rank).toBe(1);
    expect(validated.ranked_models[1].rank).toBe(2);
    expect(validated.ranked_models[2].rank).toBe(3);
  });

  it('should trim whitespace from intent and reasons', () => {
    const raw = {
      intent: '  coding  ',
      ranked_models: [
        { rank: 1, model: 'gpt-4-turbo', score: 9, reason: '  Best for coding  ' },
      ],
    };

    const validated = validateRankedRouteDecision(raw, ['gpt-4-turbo']);

    expect(validated.intent).toBe('coding');
    expect(validated.ranked_models[0].reason).toBe('Best for coding');
  });

  describe('Validation Errors', () => {
    it('should throw error if intent is missing', () => {
      const raw = {
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow('missing or invalid intent');
    });

    it('should throw error if intent is empty string', () => {
      const raw = {
        intent: '   ',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow('missing or invalid intent');
    });

    it('should throw error if ranked_models is not an array', () => {
      const raw = {
        intent: 'coding',
        ranked_models: 'not an array',
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow('must be non-empty array');
    });

    it('should throw error if ranked_models is empty', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow('must be non-empty array');
    });

    it('should throw error if rank is not a positive integer', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 0, model: 'gpt-4-turbo', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, ['gpt-4-turbo'])).toThrow('Invalid rank');
    });

    it('should throw error if rank is not an integer', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1.5, model: 'gpt-4-turbo', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, ['gpt-4-turbo'])).toThrow('Invalid rank');
    });

    it('should throw error if model is empty string', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: '', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow('must be non-empty string');
    });

    it('should throw error if model is not in eligible list (security check)', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'unauthorized-model', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow(
        'is not in eligible models list'
      );
      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow(
        'policy bypass attempt or router LLM hallucination'
      );
    });

    it('should throw error if score is less than 0', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: -1, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, ['gpt-4-turbo'])).toThrow('must be 0-10');
    });

    it('should throw error if score is greater than 10', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 11, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, ['gpt-4-turbo'])).toThrow('must be 0-10');
    });

    it('should throw error if reason is empty string', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 9, reason: '   ' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, ['gpt-4-turbo'])).toThrow('must be non-empty string');
    });

    it('should throw error if not all eligible models are ranked', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow(
        'expected 3 models, got 1'
      );
      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow(
        'All eligible models must be ranked'
      );
    });

    it('should throw error if duplicate models are present', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'test' },
          { rank: 2, model: 'gpt-4-turbo', score: 8, reason: 'duplicate' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, ['gpt-4-turbo'])).toThrow(
        'duplicate models found'
      );
    });

    it('should throw error if ranks are not sequential', () => {
      const raw = {
        intent: 'coding',
        ranked_models: [
          { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'test' },
          { rank: 3, model: 'claude-3-sonnet', score: 8, reason: 'test' },
          { rank: 4, model: 'mistral-large', score: 7, reason: 'test' },
        ],
      };

      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow(
        'ranks must be sequential starting from 1'
      );
      expect(() => validateRankedRouteDecision(raw, eligibleModels)).toThrow(
        'Expected rank 2, got 3'
      );
    });
  });
});
