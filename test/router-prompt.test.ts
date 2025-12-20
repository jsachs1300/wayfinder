/**
 * Router Prompt Builder Tests
 *
 * Verifies that the v1.0 router prompt is correctly constructed with
 * injected runtime values and contains no hardcoded data.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRouterPrompt,
  getRouteDecisionSchema,
  getCanonicalIntentList,
} from '../src/routing/prompts/builder';

describe('Router Prompt Builder v1.0', () => {
  describe('Placeholder Injection', () => {
    it('injects JSON schema into prompt', () => {
      const schema = getRouteDecisionSchema();
      const prompt = buildRouterPrompt({
        schema,
        intentList: ['code_change', 'debugging'],
        modelList: ['gpt-4', 'claude-3-sonnet'],
        userPrompt: 'Write a function',
      });

      expect(prompt).toContain('"type": "object"');
      expect(prompt).toContain('"intent"');
      expect(prompt).toContain('"primary"');
      expect(prompt).toContain('"alternate"');
      expect(prompt).not.toContain('{{ROUTER_JSON_SCHEMA}}');
    });

    it('injects intent list into prompt', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change', 'debugging', 'explanation'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('- code_change');
      expect(prompt).toContain('- debugging');
      expect(prompt).toContain('- explanation');
      expect(prompt).not.toContain('{{INTENT_LIST}}');
    });

    it('injects model list into prompt', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4', 'claude-3-opus', 'claude-3-sonnet'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('- gpt-4');
      expect(prompt).toContain('- claude-3-opus');
      expect(prompt).toContain('- claude-3-sonnet');
      expect(prompt).not.toContain('{{MODEL_LIST}}');
    });

    it('injects user prompt into prompt', () => {
      const userPrompt = 'Write a function to calculate fibonacci numbers';
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt,
      });

      expect(prompt).toContain(userPrompt);
      expect(prompt).not.toContain('{{USER_PROMPT}}');
    });

    it('replaces all placeholders', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      // Verify no placeholders remain
      expect(prompt).not.toContain('{{ROUTER_JSON_SCHEMA}}');
      expect(prompt).not.toContain('{{INTENT_LIST}}');
      expect(prompt).not.toContain('{{MODEL_LIST}}');
      expect(prompt).not.toContain('{{USER_PROMPT}}');
    });
  });

  describe('Prompt Content Verification', () => {
    it('contains no hardcoded model names', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['test-model-1', 'test-model-2'],
        userPrompt: 'Test',
      });

      // Common model names that should NOT be hardcoded
      const hardcodedModels = [
        'gpt-4',
        'gpt-3.5',
        'claude-3-opus',
        'claude-3-sonnet',
        'claude-2',
        'gemini',
      ];

      // Extract the part before model injection
      const beforeModelList = prompt.split('- test-model-1')[0];

      hardcodedModels.forEach((model) => {
        expect(beforeModelList).not.toContain(model);
      });
    });

    it('contains no hardcoded intent names', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['test_intent'],
        modelList: ['test-model'],
        userPrompt: 'Test',
      });

      // Extract the part before intent injection
      const beforeIntentList = prompt.split('- test_intent')[0];

      // Common intents that should NOT be hardcoded
      const hardcodedIntents = [
        'code_change',
        'debugging',
        'architecture_design',
        'explanation',
      ];

      hardcodedIntents.forEach((intent) => {
        expect(beforeIntentList).not.toContain(intent);
      });
    });

    it('contains scoring calibration guidance', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('10 = clear best choice');
      expect(prompt).toContain('7 = solid choice');
      expect(prompt).toContain('5 = marginally acceptable');
      expect(prompt).toContain('0–3 = poor or unsuitable');
    });

    it('contains cost awareness guidance', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt.toLowerCase()).toContain('cost');
      expect(prompt.toLowerCase()).toContain('efficient');
    });

    it('contains reason field guidance', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('short, concrete');
      expect(prompt).toContain('Do not mention routing systems');
    });

    it('requires JSON only response', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('JSON only');
      expect(prompt).toContain('No markdown');
    });

    it('specifies other:<category> format for unknown intents', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('other:<category>');
      expect(prompt).toContain('exactly one lowercase word');
    });

    it('enforces primary.score >= alternate.score', () => {
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt).toContain('primary.score must be >= alternate.score');
    });
  });

  describe('Schema Definition', () => {
    it('returns valid JSON schema structure', () => {
      const schema = getRouteDecisionSchema();

      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema).toHaveProperty('required');
      expect(schema).toHaveProperty('additionalProperties', false);
    });

    it('defines intent, primary, and alternate properties', () => {
      const schema = getRouteDecisionSchema() as any;

      expect(schema.properties).toHaveProperty('intent');
      expect(schema.properties).toHaveProperty('primary');
      expect(schema.properties).toHaveProperty('alternate');
    });

    it('marks all top-level fields as required', () => {
      const schema = getRouteDecisionSchema() as any;

      expect(schema.required).toContain('intent');
      expect(schema.required).toContain('primary');
      expect(schema.required).toContain('alternate');
    });

    it('defines score as integer with 0-10 range', () => {
      const schema = getRouteDecisionSchema() as any;

      expect(schema.properties.primary.properties.score.type).toBe('integer');
      expect(schema.properties.primary.properties.score.minimum).toBe(0);
      expect(schema.properties.primary.properties.score.maximum).toBe(10);

      expect(schema.properties.alternate.properties.score.type).toBe('integer');
      expect(schema.properties.alternate.properties.score.minimum).toBe(0);
      expect(schema.properties.alternate.properties.score.maximum).toBe(10);
    });

    it('disallows additional properties at all levels', () => {
      const schema = getRouteDecisionSchema() as any;

      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.primary.additionalProperties).toBe(false);
      expect(schema.properties.alternate.additionalProperties).toBe(false);
    });
  });

  describe('Canonical Intent List', () => {
    it('returns intents from REQUIREMENTS.md', () => {
      const intents = getCanonicalIntentList();

      expect(intents).toContain('code_change');
      expect(intents).toContain('debugging');
      expect(intents).toContain('architecture_design');
      expect(intents).toContain('explanation');
      expect(intents).toContain('summarization');
      expect(intents).toContain('data_analysis');
      expect(intents).toContain('content_generation');
      expect(intents).toContain('planning');
    });

    it('does not include "other" in intent list', () => {
      const intents = getCanonicalIntentList();

      expect(intents).not.toContain('other');
    });

    it('returns exactly 8 canonical intents', () => {
      const intents = getCanonicalIntentList();

      expect(intents).toHaveLength(8);
    });
  });

  describe('Production Readiness', () => {
    it('builds prompt deterministically', () => {
      const config = {
        schema: getRouteDecisionSchema(),
        intentList: ['code_change', 'debugging'],
        modelList: ['gpt-4', 'claude-3-sonnet'],
        userPrompt: 'Write a function',
      };

      const prompt1 = buildRouterPrompt(config);
      const prompt2 = buildRouterPrompt(config);

      expect(prompt1).toBe(prompt2);
    });

    it('handles model list with varying lengths', () => {
      const prompt1 = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['model-a'],
        userPrompt: 'Test',
      });

      const prompt2 = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['model-a', 'model-b', 'model-c', 'model-d', 'model-e'],
        userPrompt: 'Test',
      });

      expect(prompt1).toContain('- model-a');
      expect(prompt1).not.toContain('model-b');

      expect(prompt2).toContain('- model-a');
      expect(prompt2).toContain('- model-b');
      expect(prompt2).toContain('- model-c');
      expect(prompt2).toContain('- model-d');
      expect(prompt2).toContain('- model-e');
    });

    it('handles intent list with varying lengths', () => {
      const prompt1 = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      const prompt2 = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: getCanonicalIntentList(),
        modelList: ['gpt-4'],
        userPrompt: 'Test',
      });

      expect(prompt1).toContain('- code_change');
      expect(prompt1).not.toContain('- debugging');

      expect(prompt2).toContain('- code_change');
      expect(prompt2).toContain('- debugging');
      expect(prompt2).toContain('- architecture_design');
    });

    it('handles special characters in user prompt', () => {
      const userPrompt = 'Write a function with "quotes" and \'apostrophes\' and {braces}';
      const prompt = buildRouterPrompt({
        schema: getRouteDecisionSchema(),
        intentList: ['code_change'],
        modelList: ['gpt-4'],
        userPrompt,
      });

      expect(prompt).toContain(userPrompt);
    });
  });
});
