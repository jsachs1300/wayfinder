import { describe, it, expect } from 'vitest';
import { HeuristicIntentClassifier } from '../src/intent/classifier';

describe('IntentClassifier', () => {
  const classifier = new HeuristicIntentClassifier();

  describe('Intent Detection', () => {
    it('should classify coding prompts', () => {
      // Test individual prompts that should trigger coding patterns
      expect(classifier.classify('write a function to sort').label).toBe('coding');
      expect(classifier.classify('implement a binary search').label).toBe('coding');
      expect(classifier.classify('create a class for users').label).toBe('coding');
      expect(classifier.classify('fix this bug').label).toBe('coding');
      expect(classifier.classify('debug this function').label).toBe('coding');
      expect(classifier.classify('how do I implement this feature').label).toBe('coding');
    });

    it('should classify code review prompts', () => {
      expect(classifier.classify('review this code').label).toBe('code_review');
      expect(classifier.classify('check this code for bugs').label).toBe('code_review');
      expect(classifier.classify('what is wrong with this code').label).toBe('code_review');
      expect(classifier.classify('find bugs in this code').label).toBe('code_review');
    });

    it('should classify legal prompts', () => {
      const prompts = [
        'What is the legal liability here?',
        'Is this contract compliant with GDPR?',
        'Review the terms of service',
        'What are the regulatory requirements?',
      ];

      for (const prompt of prompts) {
        const result = classifier.classify(prompt);
        expect(result.label).toBe('legal');
      }
    });

    it('should classify summarization prompts', () => {
      const prompts = [
        'Summarize this article',
        'Give me a summary of the document',
        'TL;DR of this text',
        'What are the key points?',
        'Brief overview of the content',
      ];

      for (const prompt of prompts) {
        const result = classifier.classify(prompt);
        expect(result.label).toBe('summarization');
      }
    });

    it('should classify reasoning prompts', () => {
      const prompts = [
        'Explain why this approach is better',
        'What is the reason for this behavior?',
        'Analyze this problem step by step',
        'Compare and contrast these options',
        'What are the pros and cons?',
      ];

      for (const prompt of prompts) {
        const result = classifier.classify(prompt);
        expect(result.label).toBe('reasoning');
      }
    });

    it('should classify creative prompts', () => {
      expect(classifier.classify('write a story about a dragon').label).toBe('creative');
      expect(classifier.classify('write a poem about nature').label).toBe('creative');
      expect(classifier.classify('brainstorm ideas').label).toBe('creative');
      expect(classifier.classify('come up with names').label).toBe('creative');
      expect(classifier.classify('imagine a world without technology').label).toBe('creative');
    });

    it('should classify support prompts', () => {
      const prompts = [
        'Help me understand this concept',
        'How do I use this feature?',
        'What is machine learning?',
        "I'm having trouble with my account",
        'Not working properly',
      ];

      for (const prompt of prompts) {
        const result = classifier.classify(prompt);
        expect(result.label).toBe('support');
      }
    });

    it('should default to other for ambiguous prompts', () => {
      const prompts = [
        'Hello',
        'Thanks',
        'OK',
        'Lorem ipsum dolor sit amet',
      ];

      for (const prompt of prompts) {
        const result = classifier.classify(prompt);
        expect(result.label).toBe('other');
      }
    });
  });

  describe('Confidence Calculation', () => {
    it('should return higher confidence for clear intent', () => {
      const clearIntent = classifier.classify('Write a function to sort an array');
      const ambiguousIntent = classifier.classify('Hello world');

      expect(clearIntent.confidence).toBeGreaterThan(ambiguousIntent.confidence);
    });

    it('should return confidence between 0 and 1', () => {
      const result = classifier.classify('Write a function');

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return low confidence for other classification', () => {
      const result = classifier.classify('random text here');

      expect(result.label).toBe('other');
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('Raw Scores', () => {
    it('should include raw scores in result', () => {
      const result = classifier.classify('Write a function');

      expect(result.raw_scores).toBeDefined();
      expect(result.raw_scores).toHaveProperty('coding');
      expect(result.raw_scores).toHaveProperty('legal');
      expect(result.raw_scores).toHaveProperty('other');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      const result = classifier.classify('');

      expect(result.label).toBe('other');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should handle very long prompts', () => {
      const longPrompt = 'Write a function '.repeat(100);
      const result = classifier.classify(longPrompt);

      expect(result.label).toBe('coding');
    });

    it('should be case insensitive', () => {
      const lower = classifier.classify('write a function');
      const upper = classifier.classify('WRITE A FUNCTION');

      expect(lower.label).toBe(upper.label);
    });

    it('should handle prompts with multiple intents', () => {
      // This prompt has both coding and reasoning aspects
      const result = classifier.classify('Explain why this code is wrong and fix it');

      // Should pick the stronger signal
      expect(['coding', 'code_review', 'reasoning']).toContain(result.label);
    });
  });
});
