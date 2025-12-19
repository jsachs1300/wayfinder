import { describe, it, expect } from 'vitest';
import { HeuristicIntentClassifier } from '../src/intent/classifier';

const classifier = new HeuristicIntentClassifier();

describe('IntentClassifier', () => {
  describe('Intent Detection', () => {
    it('should classify code change prompts', () => {
      expect(classifier.classify('write a function to sort').label).toBe('code_change');
      expect(classifier.classify('implement a binary search').label).toBe('code_change');
      expect(classifier.classify('create a class for users').label).toBe('code_change');
      expect(classifier.classify('add a feature to this api').label).toBe('code_change');
      expect(classifier.classify('review this code').label).toBe('code_change');
    });

    it('should classify debugging prompts', () => {
      expect(classifier.classify('fix this bug').label).toBe('debugging');
      expect(classifier.classify('debug this function').label).toBe('debugging');
      expect(classifier.classify('why is this error happening?').label).toBe('debugging');
      expect(classifier.classify('stack trace shows null reference').label).toBe('debugging');
    });

    it('should classify architecture design prompts', () => {
      const prompts = [
        'design a microservice architecture',
        'what is the best pattern for this module?',
        'high level approach for this system',
      ];

      for (const prompt of prompts) {
        expect(classifier.classify(prompt).label).toBe('architecture_design');
      }
    });

    it('should classify explanation prompts', () => {
      const prompts = [
        'Explain why this approach is better',
        'what is the reason for this behavior?',
        'walk me through how this works',
      ];

      for (const prompt of prompts) {
        expect(classifier.classify(prompt).label).toBe('explanation');
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
        expect(classifier.classify(prompt).label).toBe('summarization');
      }
    });

    it('should classify data analysis prompts', () => {
      const prompts = [
        'Analyze this dataset',
        'run analysis on this csv file',
        'derive insights from the data',
      ];

      for (const prompt of prompts) {
        expect(classifier.classify(prompt).label).toBe('data_analysis');
      }
    });

    it('should classify content generation prompts', () => {
      expect(classifier.classify('write a story about a dragon').label).toBe(
        'content_generation'
      );
      expect(classifier.classify('write a poem about nature').label).toBe(
        'content_generation'
      );
      expect(classifier.classify('brainstorm ideas').label).toBe('content_generation');
      expect(classifier.classify('come up with names').label).toBe('content_generation');
    });

    it('should classify planning prompts', () => {
      const prompts = [
        'plan a project timeline',
        'create a checklist for launch',
        'organize tasks into milestones',
      ];

      for (const prompt of prompts) {
        expect(classifier.classify(prompt).label).toBe('planning');
      }
    });

    it('should default to other for ambiguous prompts', () => {
      const prompts = ['Hello', 'Thanks', 'OK', 'Lorem ipsum dolor sit amet'];

      for (const prompt of prompts) {
        const result = classifier.classify(prompt);
        expect(result.label.startsWith('other:')).toBe(true);
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

      expect(result.label.startsWith('other:')).toBe(true);
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('Raw Scores', () => {
    it('should include raw scores in result', () => {
      const result = classifier.classify('Write a function');

      expect(result.raw_scores).toBeDefined();
      expect(result.raw_scores).toHaveProperty('code_change');
      expect(result.raw_scores).toHaveProperty('content_generation');
      expect(result.raw_scores).toHaveProperty('other:general');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      const result = classifier.classify('');

      expect(result.label.startsWith('other:')).toBe(true);
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should handle very long prompts', () => {
      const longPrompt = 'Write a function '.repeat(100);
      const result = classifier.classify(longPrompt);

      expect(result.label).toBe('code_change');
    });

    it('should be case insensitive', () => {
      const lower = classifier.classify('write a function');
      const upper = classifier.classify('WRITE A FUNCTION');

      expect(lower.label).toBe(upper.label);
    });

    it('should handle prompts with multiple intents', () => {
      const result = classifier.classify('Explain why this code is wrong and fix it');

      expect(['code_change', 'debugging', 'explanation']).toContain(result.label);
    });
  });
});
