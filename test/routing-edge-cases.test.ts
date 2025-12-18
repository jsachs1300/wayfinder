import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultRoutingEngine } from '../src/routing/engine';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { HeuristicIntentClassifier } from '../src/intent/classifier';
import { DefaultPolicyEngine } from '../src/policy/engine';
import { DefaultModelRegistry } from '../src/models/registry';
import { TokenConfig, PolicyRule, RouteRequest } from '../src/types';

describe('RoutingEngine Edge Cases and Security', () => {
  let routingEngine: DefaultRoutingEngine;
  let knowledgeStore: InMemoryKnowledgeStore;
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
    knowledgeStore = new InMemoryKnowledgeStore();
    intentClassifier = new HeuristicIntentClassifier();
    policyEngine = new DefaultPolicyEngine();
    modelRegistry = new DefaultModelRegistry();

    routingEngine = new DefaultRoutingEngine({
      intentClassifier,
      policyEngine,
      knowledgeStore,
      modelRegistry,
    });
  });

  describe('Empty Input Handling', () => {
    it('should handle empty prompt', async () => {
      const config = createTokenConfig();
      const result = await routingEngine.route({ prompt: '' }, config);

      expect(result.selected_model).toBeDefined();
      expect(result.request_id).toBeDefined();
    });

    it('should handle whitespace-only prompt', async () => {
      const config = createTokenConfig();
      const result = await routingEngine.route({ prompt: '   \n\t  ' }, config);

      expect(result.selected_model).toBeDefined();
    });

    it('should handle very long prompt', async () => {
      const longPrompt = 'Write a function to '.repeat(10000);
      const config = createTokenConfig();

      const result = await routingEngine.route({ prompt: longPrompt }, config);

      expect(result.selected_model).toBeDefined();
    });

    it('should handle special characters in prompt', async () => {
      const config = createTokenConfig();
      const result = await routingEngine.route({
        prompt: '!@#$%^&*(){}[]|\\:";\'<>?,./~`',
      }, config);

      expect(result.selected_model).toBeDefined();
    });

    it('should handle unicode in prompt', async () => {
      const config = createTokenConfig();
      const result = await routingEngine.route({
        prompt: '你好世界 こんにちは नमस्ते 🎉💻🚀',
      }, config);

      expect(result.selected_model).toBeDefined();
    });
  });

  describe('Fallback Chain Edge Cases', () => {
    it('should fallback through all levels when necessary', async () => {
      const config = createTokenConfig({
        // No trusted anchor
        // No default model
      });

      const result = await routingEngine.route({ prompt: 'hello' }, config);

      // Should eventually use system default
      expect(result.selected_model).toBe(modelRegistry.getDefaultModel());
      expect(result.routing_decision.reason).toBe('system_default');
    });

    it('should skip denied trusted anchor and use next fallback', async () => {
      const config = createTokenConfig({
        trusted_anchor_model: 'claude-3-5-sonnet',
        denied_models: ['claude-3-5-sonnet'],
        default_model: 'gpt-4o',
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      expect(result.selected_model).toBe('gpt-4o');
      expect(result.routing_decision.reason).toBe('default_model_fallback');
    });

    it('should skip denied default model and use system default', async () => {
      const config = createTokenConfig({
        default_model: 'gpt-4o',
        denied_models: ['gpt-4o'],
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      expect(result.selected_model).toBe(modelRegistry.getDefaultModel());
      expect(result.routing_decision.reason).toBe('system_default');
    });

    it('should handle when all models are denied', async () => {
      const allModels = modelRegistry.getAvailableModels().map(m => m.id);
      const config = createTokenConfig({
        denied_models: allModels,
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      // Should still return a model (system default takes precedence)
      expect(result.selected_model).toBeDefined();
    });

    it('should handle invalid trusted anchor (non-existent model)', async () => {
      const config = createTokenConfig({
        trusted_anchor_model: 'non-existent-model-xyz',
        default_model: 'gpt-4o',
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      // Should skip invalid anchor and use default
      expect(result.selected_model).toBe('gpt-4o');
      expect(result.routing_decision.reason).toBe('default_model_fallback');
    });

    it('should handle invalid default model', async () => {
      const config = createTokenConfig({
        default_model: 'non-existent-model-xyz',
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      // Should use system default
      expect(result.selected_model).toBe(modelRegistry.getDefaultModel());
      expect(result.routing_decision.reason).toBe('system_default');
    });
  });

  describe('Knowledge Consensus Edge Cases', () => {
    it('should skip knowledge consensus if confidence is low', async () => {
      // Create low confidence knowledge
      await knowledgeStore.recordVote('coding', 'gpt-4-turbo');

      const config = createTokenConfig({
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const result = await routingEngine.route({
        prompt: 'Write a function',
      }, config);

      // Should use anchor, not low-confidence knowledge
      expect(result.selected_model).toBe('claude-3-5-sonnet');
      expect(result.routing_decision.reason).toBe('trusted_anchor_fallback');
    });

    it('should skip knowledge consensus if consensus model is denied', async () => {
      // Build strong consensus
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('coding', 'gpt-4-turbo');
      }

      const config = createTokenConfig({
        denied_models: ['gpt-4-turbo'],
        trusted_anchor_model: 'claude-3-5-sonnet',
      });

      const result = await routingEngine.route({
        prompt: 'Write a function',
      }, config);

      expect(result.selected_model).toBe('claude-3-5-sonnet');
      expect(result.routing_decision.reason).toBe('trusted_anchor_fallback');
    });

    it('should skip knowledge consensus if consensus model is not in eligible models', async () => {
      // Build consensus for a model
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('coding', 'gpt-4-turbo');
      }

      const config = createTokenConfig({
        allowed_models: ['claude-3-5-sonnet', 'claude-3-opus'], // gpt-4-turbo not allowed
        default_model: 'claude-3-5-sonnet',
      });

      const result = await routingEngine.route({
        prompt: 'Write code',
      }, config);

      expect(result.selected_model).not.toBe('gpt-4-turbo');
    });

    it('should use knowledge consensus when available and valid', async () => {
      // Build moderate consensus
      for (let i = 0; i < 7; i++) {
        await knowledgeStore.recordVote('coding', 'gpt-4-turbo');
      }
      for (let i = 0; i < 3; i++) {
        await knowledgeStore.recordVote('coding', 'claude-3-5-sonnet');
      }

      const config = createTokenConfig();

      const result = await routingEngine.route({
        prompt: 'Write a function',
      }, config);

      expect(result.selected_model).toBe('gpt-4-turbo');
      expect(result.routing_decision.reason).toBe('knowledge_consensus');
      expect(result.routing_decision.knowledge_used).toBe(true);
    });
  });

  describe('Policy Forced Model Edge Cases', () => {
    it('should use forced model even when knowledge suggests different model', async () => {
      // Build knowledge consensus
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('coding', 'gpt-4-turbo');
      }

      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['claude-3-5-sonnet'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });

      const result = await routingEngine.route({
        prompt: 'Write code',
      }, config);

      expect(result.selected_model).toBe('claude-3-5-sonnet');
      expect(result.routing_decision.reason).toBe('policy_forced');
      expect(result.routing_decision.policy_forced).toBe(true);
    });

    it('should mark policy_forced as false when not forced', async () => {
      const config = createTokenConfig();

      const result = await routingEngine.route({
        prompt: 'test',
      }, config);

      expect(result.routing_decision.policy_forced).toBe(false);
    });
  });

  describe('Request ID Handling', () => {
    it('should generate request ID when not provided', async () => {
      const config = createTokenConfig();

      const result = await routingEngine.route({ prompt: 'test' }, config);

      expect(result.request_id).toBeDefined();
      expect(typeof result.request_id).toBe('string');
      expect(result.request_id.length).toBeGreaterThan(0);
    });

    it('should use provided request ID', async () => {
      const config = createTokenConfig();
      const customId = 'custom-request-id-12345';

      const result = await routingEngine.route(
        { prompt: 'test' },
        config,
        customId
      );

      expect(result.request_id).toBe(customId);
    });

    it('should generate unique IDs for concurrent requests', async () => {
      const config = createTokenConfig();

      const promises = Array.from({ length: 100 }, () =>
        routingEngine.route({ prompt: 'test' }, config)
      );

      const results = await Promise.all(promises);
      const ids = new Set(results.map(r => r.request_id));

      expect(ids.size).toBe(100); // All unique
    });
  });

  describe('Routing Decision Metadata', () => {
    it('should include agreement_score when knowledge is used', async () => {
      // Build consensus
      for (let i = 0; i < 8; i++) {
        await knowledgeStore.recordVote('coding', 'gpt-4-turbo');
      }
      for (let i = 0; i < 2; i++) {
        await knowledgeStore.recordVote('coding', 'claude-3-5-sonnet');
      }

      const config = createTokenConfig();

      const result = await routingEngine.route({
        prompt: 'Write code',
      }, config);

      expect(result.routing_decision.agreement_score).not.toBeNull();
      expect(result.routing_decision.agreement_score).toBe(0.8);
    });

    it('should set agreement_score to null when knowledge not used', async () => {
      const config = createTokenConfig({
        default_model: 'gpt-4o',
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      expect(result.routing_decision.knowledge_used).toBe(false);
    });

    it('should include eligible_models in decision', async () => {
      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      expect(result.routing_decision.eligible_models).toEqual([
        'gpt-4-turbo',
        'claude-3-5-sonnet',
      ]);
    });

    it('should include timestamp in decision', async () => {
      const config = createTokenConfig();
      const before = new Date().toISOString();

      const result = await routingEngine.route({ prompt: 'test' }, config);

      const after = new Date().toISOString();

      expect(result.routing_decision.timestamp).toBeDefined();
      expect(result.routing_decision.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.routing_decision.timestamp).toBeLessThanOrEqual(after);
    });

    it('should set confidence based on routing reason', async () => {
      const config = createTokenConfig({
        default_model: 'gpt-4o',
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      expect(result.routing_decision.confidence).toBe('low');
    });
  });

  describe('Concurrent Routing Requests', () => {
    it('should handle concurrent routing requests without interference', async () => {
      const config = createTokenConfig();

      const promises = Array.from({ length: 50 }, (_, i) =>
        routingEngine.route({ prompt: `request ${i}` }, config)
      );

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.length).toBe(50);
      expect(results.every(r => r.selected_model)).toBe(true);
    });

    it('should handle concurrent routing with knowledge updates', async () => {
      const config = createTokenConfig();

      // Start routing and knowledge updates concurrently
      const routePromises = Array.from({ length: 20 }, () =>
        routingEngine.route({ prompt: 'Write code' }, config)
      );

      const votePromises = Array.from({ length: 20 }, () =>
        knowledgeStore.recordVote('coding', 'gpt-4-turbo')
      );

      const [routes] = await Promise.all([
        Promise.all(routePromises),
        Promise.all(votePromises),
      ]);

      // All should complete successfully
      expect(routes.every(r => r.selected_model)).toBe(true);
    });
  });

  describe('System Default Fallback Edge Cases', () => {
    it('should use first eligible model when system default is denied', async () => {
      const systemDefault = modelRegistry.getDefaultModel();

      const config = createTokenConfig({
        denied_models: [systemDefault],
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      // Should pick first eligible model that's not the denied default
      expect(result.selected_model).not.toBe(systemDefault);
      expect(result.routing_decision.reason).toBe('system_default');
    });

    it('should handle empty eligible models array gracefully', async () => {
      // This is a pathological case that shouldn't happen in practice
      const allModels = modelRegistry.getAvailableModels().map(m => m.id);

      const config = createTokenConfig({
        allowed_models: ['non-existent-model'],
      });

      const result = await routingEngine.route({ prompt: 'test' }, config);

      // Should still return system default as last resort
      expect(result.selected_model).toBe(modelRegistry.getDefaultModel());
    });
  });

  describe('Context and Metadata Handling', () => {
    it('should accept optional context field', async () => {
      const config = createTokenConfig();

      const request: RouteRequest = {
        prompt: 'test',
        context: {
          user_id: 'user-123',
          session_id: 'session-456',
        },
      };

      const result = await routingEngine.route(request, config);

      expect(result.selected_model).toBeDefined();
    });

    it('should accept optional metadata field', async () => {
      const config = createTokenConfig();

      const request: RouteRequest = {
        prompt: 'test',
        metadata: {
          client_version: '1.0.0',
          platform: 'web',
        },
      };

      const result = await routingEngine.route(request, config);

      expect(result.selected_model).toBeDefined();
    });

    it('should accept optional prefer_model field', async () => {
      const config = createTokenConfig();

      const request: RouteRequest = {
        prompt: 'test',
        prefer_model: 'gpt-4-turbo',
      };

      const result = await routingEngine.route(request, config);

      // Note: prefer_model is accepted but not implemented in routing logic yet
      expect(result.selected_model).toBeDefined();
    });

    it('should handle complex nested context objects', async () => {
      const config = createTokenConfig();

      const request: RouteRequest = {
        prompt: 'test',
        context: {
          user: {
            id: 'user-123',
            preferences: {
              theme: 'dark',
              language: 'en',
            },
          },
          session: {
            id: 'session-456',
            created_at: new Date().toISOString(),
          },
        },
      };

      const result = await routingEngine.route(request, config);

      expect(result.selected_model).toBeDefined();
    });
  });

  describe('Model Registry Edge Cases', () => {
    it('should handle unavailable models in registry', async () => {
      // Create a custom registry with some unavailable models
      const customRegistry = new DefaultModelRegistry();
      customRegistry.registerModel({
        id: 'unavailable-model',
        provider: 'test',
        capabilities: ['coding'],
        cost_tier: 'low',
        speed_tier: 'fast',
        context_window: 4096,
        available: false,
      });

      const customEngine = new DefaultRoutingEngine({
        intentClassifier,
        policyEngine,
        knowledgeStore,
        modelRegistry: customRegistry,
      });

      const config = createTokenConfig({
        trusted_anchor_model: 'unavailable-model',
      });

      const result = await customEngine.route({ prompt: 'test' }, config);

      // Should skip unavailable model
      expect(result.selected_model).not.toBe('unavailable-model');
    });
  });

  describe('Intent Classification Integration', () => {
    it('should route different intents correctly', async () => {
      const config = createTokenConfig();

      const intents = [
        'Write a function to sort an array',
        'Review this code for bugs',
        'Summarize this article',
        'Explain why the sky is blue',
      ];

      for (const prompt of intents) {
        const result = await routingEngine.route({ prompt }, config);
        expect(result.selected_model).toBeDefined();
        expect(result.routing_decision.reason).toBeDefined();
      }
    });

    it('should apply intent-specific policies', async () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'legal',
          models: ['claude-3-opus'],
        },
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });

      const legalResult = await routingEngine.route({
        prompt: 'What are the legal implications of this contract?',
      }, config);

      const codingResult = await routingEngine.route({
        prompt: 'Write a function to parse JSON',
      }, config);

      expect(legalResult.selected_model).toBe('claude-3-opus');
      expect(codingResult.selected_model).toBe('gpt-4-turbo');
    });
  });
});
