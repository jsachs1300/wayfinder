/**
 * Router LLM Contract Tests
 *
 * These tests verify the canonical RouteDecision schema and contract:
 * - Router LLM responses require intent, primary, and alternate
 * - User-facing responses exclude intent
 * - Exactly one primary and one alternate are returned
 * - Invalid schemas are rejected
 */

import { describe, it, expect } from 'vitest';
import {
  validateRouteDecision,
  safeValidateRouteDecision,
  projectRouteResponse,
} from '../src/routing';

describe('Router LLM Contract', () => {
  describe('RouteDecision Validation', () => {
    it('validates a correct RouteDecision', () => {
      const validDecision = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      const result = validateRouteDecision(validDecision);
      expect(result).toEqual(validDecision);
    });

    it('requires intent field', () => {
      const missingIntent = {
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(missingIntent)).toThrow();
    });

    it('requires primary field', () => {
      const missingPrimary = {
        intent: 'code_change',
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(missingPrimary)).toThrow();
    });

    it('requires alternate field', () => {
      const missingAlternate = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
      };

      expect(() => validateRouteDecision(missingAlternate)).toThrow();
    });

    it('rejects empty intent string', () => {
      const emptyIntent = {
        intent: '',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(emptyIntent)).toThrow();
    });

    it('accepts free text intent (no enum restriction)', () => {
      const customIntent = {
        intent: 'custom_research_task',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for research',
        },
        alternate: {
          model: 'claude-3-opus',
          score: 7,
          reason: 'Alternative for research',
        },
      };

      const result = validateRouteDecision(customIntent);
      expect(result.intent).toBe('custom_research_task');
    });

    it('validates score range (0-10)', () => {
      const invalidScoreTooHigh = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 11,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(invalidScoreTooHigh)).toThrow();

      const invalidScoreTooLow = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: -1,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(invalidScoreTooLow)).toThrow();
    });

    it('requires model identifier', () => {
      const missingModel = {
        intent: 'code_change',
        primary: {
          model: '',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(missingModel)).toThrow();
    });

    it('requires reason string', () => {
      const missingReason = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: '',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(missingReason)).toThrow();
    });

    it('rejects additional properties in RouteDecision', () => {
      const extraProperties = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
        extraField: 'not allowed',
      };

      expect(() => validateRouteDecision(extraProperties)).toThrow();
    });

    it('rejects additional properties in ModelRecommendation', () => {
      const extraProperties = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
          extraField: 'not allowed',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(extraProperties)).toThrow();
    });

    it('safeValidateRouteDecision returns success for valid input', () => {
      const validDecision = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      const result = safeValidateRouteDecision(validDecision);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validDecision);
      }
    });

    it('safeValidateRouteDecision returns error for invalid input', () => {
      const invalidDecision = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 11, // Invalid: > 10
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      const result = safeValidateRouteDecision(invalidDecision);
      expect(result.success).toBe(false);
    });
  });

  describe('Projection Layer', () => {
    it('projects RouteDecision to user-facing RouteResponse', () => {
      const decision = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      const response = projectRouteResponse(decision, 'test-request-id');

      expect(response).toEqual({
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
        request_id: 'test-request-id',
      });
    });

    it('excludes intent from user-facing response', () => {
      const decision = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      const response = projectRouteResponse(decision, 'test-request-id');

      expect(response).not.toHaveProperty('intent');
    });

    it('preserves primary and alternate exactly', () => {
      const decision = {
        intent: 'debugging',
        primary: {
          model: 'claude-3-opus',
          score: 9,
          reason: 'Superior reasoning for debugging',
        },
        alternate: {
          model: 'gpt-4',
          score: 7,
          reason: 'Alternative with good debugging capabilities',
        },
      };

      const response = projectRouteResponse(decision, 'req-123');

      expect(response.primary).toEqual(decision.primary);
      expect(response.alternate).toEqual(decision.alternate);
    });

    it('includes request_id in response', () => {
      const decision = {
        intent: 'summarization',
        primary: {
          model: 'gpt-4',
          score: 7,
          reason: 'Fast summarization',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 7,
          reason: 'Equal quality alternative',
        },
      };

      const requestId = 'request-xyz-789';
      const response = projectRouteResponse(decision, requestId);

      expect(response.request_id).toBe(requestId);
    });
  });

  describe('Contract Guarantees', () => {
    it('ensures exactly one primary and one alternate', () => {
      const decision = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      const validated = validateRouteDecision(decision);
      const response = projectRouteResponse(validated, 'test-id');

      // Verify exactly one primary
      expect(response.primary).toBeDefined();
      expect(typeof response.primary).toBe('object');
      expect(response.primary.model).toBe('gpt-4');

      // Verify exactly one alternate
      expect(response.alternate).toBeDefined();
      expect(typeof response.alternate).toBe('object');
      expect(response.alternate.model).toBe('claude-3-sonnet');
    });

    it('rejects arrays of alternates', () => {
      const multipleAlternates = {
        intent: 'code_change',
        primary: {
          model: 'gpt-4',
          score: 8,
          reason: 'Best for code generation',
        },
        alternate: [
          {
            model: 'claude-3-sonnet',
            score: 6,
            reason: 'Good alternative',
          },
          {
            model: 'claude-3-opus',
            score: 7,
            reason: 'Another alternative',
          },
        ],
      };

      expect(() => validateRouteDecision(multipleAlternates)).toThrow();
    });

    it('fails hard on schema violation (no auto-repair)', () => {
      const invalidDecision = {
        intent: 'code_change',
        primary: {
          // Missing score
          model: 'gpt-4',
          reason: 'Best for code generation',
        },
        alternate: {
          model: 'claude-3-sonnet',
          score: 6,
          reason: 'Good alternative',
        },
      };

      expect(() => validateRouteDecision(invalidDecision)).toThrow();
    });
  });
});
