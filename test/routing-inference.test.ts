import { describe, it, expect } from 'vitest';
import { RoutingInferenceEngine, ROUTER_LLM_PROMPT } from '../src/routing';
import { createIntentClassifier } from '../src/intent';
import { createModelRegistry } from '../src/models';

const intentClassifier = createIntentClassifier();
const modelRegistry = createModelRegistry();
const inferenceEngine = new RoutingInferenceEngine(intentClassifier, modelRegistry);

describe('RoutingInferenceEngine', () => {
  it('returns primary and alternate model selections with confidence and intent', () => {
    const result = inferenceEngine.infer({ prompt: 'write a function to sort an array' });

    expect(result.primary.model).toBeDefined();
    expect(modelRegistry.isValidModel(result.primary.model)).toBe(true);
    expect(result.alternate.model).toBeDefined();
    expect(modelRegistry.isValidModel(result.alternate.model)).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(10);
    expect(result.intent).toBe('code_change');
    expect(result.intent_version).toBe(1);
    expect(result.timestamp).toBeTruthy();
  });

  it('honors a preferred model when it is valid', () => {
    const preferred = modelRegistry.getDefaultModel();
    const result = inferenceEngine.infer({
      prompt: 'Summarize this document',
      prefer_model: preferred,
    });

    expect(result.primary.model).toBe(preferred);
    expect(result.intent).toBe('summarization');
  });

  it('returns cached results on repeated prompts', () => {
    const first = inferenceEngine.infer({ prompt: 'Plan a project timeline' });
    const second = inferenceEngine.infer({ prompt: 'Plan a project timeline' });

    expect(second).toBe(first);
  });

  it('includes the router prompt instructions', () => {
    expect(ROUTER_LLM_PROMPT).toContain('You are an objective, vendor-neutral judge');
    expect(ROUTER_LLM_PROMPT).toContain('Respond only with valid JSON');
    expect(ROUTER_LLM_PROMPT).toContain('intent');
  });
});
