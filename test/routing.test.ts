import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultRoutingEngine } from '../src/routing/engine';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { HeuristicIntentClassifier } from '../src/intent/classifier';
import { createModelRegistry } from '../src/models';
import { DefaultPolicyEngine } from '../src/policy/engine';
import { DefaultModelRegistry } from '../src/models/registry';
import { TokenConfig, PolicyRule, KnowledgeScopeContext } from '../src/types';

describe('RoutingEngine', () => {
  let routingEngine: DefaultRoutingEngine;
  let knowledgeStore: InMemoryKnowledgeStore;

  // Use real model IDs from the registry
  const modelA = 'claude-3-5-sonnet';
  const modelB = 'gpt-4o';
  const globalScope: KnowledgeScopeContext = { scope: 'global' };
  let intentClassifier: HeuristicIntentClassifier;
  let policyEngine: DefaultPolicyEngine;
  let modelRegistry: DefaultModelRegistry;

  function createTokenConfig(overrides: Partial<TokenConfig> = {}): TokenConfig {
    return {
      id: 'test-token',
      token_hash: 'hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confidence_threshold: 0.6,
      ...overrides,
    };
  }

  beforeEach(async () => {
    modelRegistry = createModelRegistry();
    knowledgeStore = new InMemoryKnowledgeStore(modelRegistry);
    intentClassifier = new HeuristicIntentClassifier();
    policyEngine = new DefaultPolicyEngine();

    routingEngine = new DefaultRoutingEngine({
      intentClassifier,
      policyEngine,
      knowledgeStore,
      modelRegistry,
    });
  });

  describe('Routing Fallback Logic', () => {
    it('should use forced model when policy requires it', async () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'other:legal',
          models: ['claude-3-opus'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = await routingEngine.route(
        { prompt: 'What is the legal liability here?' },
        config
      );

      expect(result.selected_model).toBe('claude-3-opus');
      expect(result.routing_decision.reason).toBe('policy_forced');
      expect(result.routing_decision.policy_forced).toBe(true);
    });

    it('should use knowledge consensus when confidence is high', async () => {
      // Build up strong consensus for 'code_change' intent
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      }

      const config = createTokenConfig();
      const result = await routingEngine.route(
        { prompt: 'Write a function to sort an array' },
        config
      );

      expect(result.selected_model).toBe('gpt-4-turbo');
      expect(result.routing_decision.reason).toBe('knowledge_consensus');
      expect(result.routing_decision.knowledge_used).toBe(true);
    });

    it('should use trusted anchor when knowledge confidence is low', async () => {
      // Only record a few votes (low confidence)
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);

      const config = createTokenConfig({
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const result = await routingEngine.route(
        { prompt: 'Write a function' },
        config
      );

      expect(result.selected_model).toBe('claude-3-5-sonnet');
      expect(result.routing_decision.reason).toBe('trusted_anchor_fallback');
    });

    it('should use default model when no trusted anchor is set', async () => {
      const config = createTokenConfig({
        default_model: 'gemini-1.5-pro',
      });

      const result = await routingEngine.route(
        { prompt: 'Hello world' },
        config
      );

      expect(result.selected_model).toBe('gemini-1.5-pro');
      expect(result.routing_decision.reason).toBe('default_model_fallback');
    });

    it('should fallback to system default when nothing else is configured', async () => {
      const config = createTokenConfig({});

      const result = await routingEngine.route(
        { prompt: 'Hello world' },
        config
      );

      expect(result.selected_model).toBe(modelRegistry.getDefaultModel());
      expect(result.routing_decision.reason).toBe('system_default');
    });
  });

  describe('Policy and Knowledge Interaction', () => {
    it('should respect policy even when knowledge suggests different model', async () => {
      // Build consensus for gpt-4-turbo
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      }

      // But policy denies gpt-4-turbo
      const config = createTokenConfig({
        denied_models: ['gpt-4-turbo'],
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const result = await routingEngine.route(
        { prompt: 'Write a function' },
        config
      );

      // Should use anchor since consensus model is denied
      expect(result.selected_model).toBe('claude-3-5-sonnet');
      expect(result.routing_decision.reason).toBe('trusted_anchor_fallback');
    });

    it('should skip ineligible trusted anchor', async () => {
      const config = createTokenConfig({
        denied_models: ['claude-3-5-sonnet'],
        trusted_anchor_model: 'claude-3-5-sonnet',
        default_model: 'gpt-4o',
      });

      const result = await routingEngine.route(
        { prompt: 'Hello' },
        config
      );

      // Anchor is denied, should use default
      expect(result.selected_model).toBe('gpt-4o');
      expect(result.routing_decision.reason).toBe('default_model_fallback');
    });
  });

  describe('Response Structure', () => {
    it('should include all required fields in response', async () => {
      const config = createTokenConfig();

      const result = await routingEngine.route(
        { prompt: 'Test prompt' },
        config,
        'test-request-id'
      );

      expect(result).toHaveProperty('selected_model');
      expect(result).toHaveProperty('routing_decision');
      expect(result).toHaveProperty('request_id');
      expect(result.request_id).toBe('test-request-id');

      expect(result.routing_decision).toHaveProperty('reason');
      expect(result.routing_decision).toHaveProperty('confidence');
      expect(result.routing_decision).toHaveProperty('eligible_models');
      expect(result.routing_decision).toHaveProperty('timestamp');
      expect(result.routing_decision).toHaveProperty('knowledge_used');
      expect(result.routing_decision).toHaveProperty('policy_forced');
    });

    it('should include agreement score when knowledge is used', async () => {
      // Build moderate consensus
      for (let i = 0; i < 6; i++) {
        await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', globalScope);
      }
      for (let i = 0; i < 2; i++) {
        await knowledgeStore.recordVote('code_change', 'claude-3-5-sonnet', globalScope);
      }

      const config = createTokenConfig();
      const result = await routingEngine.route(
        { prompt: 'Write code' },
        config
      );

      expect(result.routing_decision.agreement_score).not.toBeNull();
      expect(result.routing_decision.agreement_score).toBeGreaterThan(0);
    });
  });
});
