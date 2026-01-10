/**
 * Policy-Routing Integration Tests
 *
 * Verifies that the routing engine correctly integrates with the policy engine:
 * - Policy evaluation determines eligible models before router LLM invocation
 * - Global allow/deny rules are enforced
 * - Router LLM receives only policy-filtered models
 * - Policy bypass attempts are rejected
 */

import { describe, it, expect } from 'vitest';
import { DefaultRoutingEngine } from '../src/routing/engine';
import type { RouterLLM } from '../src/routing/engine';
import { createPolicyEngine } from '../src/policy';
import { createModelRegistry } from '../src/models';
import type { TokenConfig, RouteRequest, RankedRouteDecision } from '../src/types';
import type { MultiProviderResult } from '../src/routing/router-llm';
import type { Logger } from '../src/logging/logger';

describe('Policy-Routing Integration', () => {
  const policyEngine = createPolicyEngine();
  const modelRegistry = createModelRegistry();

  // Mock logger for tests
  const mockLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  // Helper to build MultiProviderResult from RankedRouteDecision
  function buildMultiProviderResult(decision: RankedRouteDecision): MultiProviderResult {
    const now = new Date().toISOString();
    return {
      provider_rankings: {
        openai: {
          provider: 'openai',
          decision,
          generated_at: now,
        },
        gemini: {
          provider: 'gemini',
          decision,
          generated_at: now,
        },
      },
      consensus: decision,
    };
  }

  function createTokenConfig(overrides: Partial<TokenConfig> = {}): TokenConfig {
    return {
      id: 'test-token',
      token_hash: 'hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('Global Allow/Deny Rules', () => {
    it('should only pass allowed models to router LLM', async () => {
      let receivedModels: string[] = [];

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          receivedModels = eligibleModels;
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: eligibleModels.map((model, idx) => ({
              rank: idx + 1,
              model,
              score: Math.max(3, 8 - idx),
              reason: idx === 0 ? 'Selected from eligible list' : 'Alternative from eligible list',
            })),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: mockLogger,
      });

      const tokenConfig = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      await engine.route(request, tokenConfig);

      // Verify router LLM only received allowed models
      expect(receivedModels).toEqual(
        expect.arrayContaining(['gpt-4-turbo', 'claude-3-5-sonnet'])
      );
      expect(receivedModels).not.toContain('gpt-4o');
      expect(receivedModels).not.toContain('gemini-1.5-pro');
    });

    it('should exclude denied models from router LLM', async () => {
      let receivedModels: string[] = [];

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          receivedModels = eligibleModels;
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: eligibleModels.map((model, idx) => ({
              rank: idx + 1,
              model,
              score: Math.max(3, 8 - idx),
              reason: idx === 0 ? 'Selected from eligible list' : 'Alternative from eligible list',
            })),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: mockLogger,
      });

      const tokenConfig = createTokenConfig({
        denied_models: ['gpt-4o', 'gpt-4o-mini'],
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      await engine.route(request, tokenConfig);

      // Verify router LLM did not receive denied models
      expect(receivedModels).not.toContain('gpt-4o');
      expect(receivedModels).not.toContain('gpt-4o-mini');

      // But should have other available models
      expect(receivedModels.length).toBeGreaterThan(0);
      expect(receivedModels).toContain('gpt-4-turbo');
    });

    it('should apply both allow and deny rules correctly', async () => {
      let receivedModels: string[] = [];

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          receivedModels = eligibleModels;
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: eligibleModels.map((model, idx) => ({
              rank: idx + 1,
              model,
              score: Math.max(3, 8 - idx),
              reason: idx === 0 ? 'Selected from eligible list' : 'Alternative from eligible list',
            })),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: mockLogger,
      });

      const tokenConfig = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'gpt-4o', 'claude-3-5-sonnet'],
        denied_models: ['gpt-4o'],
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      await engine.route(request, tokenConfig);

      // Verify router LLM received allowed models minus denied ones
      expect(receivedModels).toEqual(
        expect.arrayContaining(['gpt-4-turbo', 'claude-3-5-sonnet'])
      );
      expect(receivedModels).not.toContain('gpt-4o'); // Denied
      expect(receivedModels).not.toContain('gemini-1.5-pro'); // Not in allowed list
    });
  });

  describe('Forced Model Policy', () => {
    it('should skip router LLM and return forced model directly', async () => {
      let llmWasCalled = false;

      const testRouterLLM: RouterLLM = {
        async invoke() {
          llmWasCalled = true;
          throw new Error('Router LLM should not be called when model is forced by policy');
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: mockLogger,
      });

      const tokenConfig = createTokenConfig({
        policy_rules: [
          {
            type: 'ForceModelByIntent',
            intent: 'other', // Using 'other' since that's the placeholder intent
            models: ['claude-3-opus'],
          },
        ],
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      const result = await engine.route(request, tokenConfig);

      // Verify router LLM was NOT called (per REQUIREMENTS.md §7.2)
      expect(llmWasCalled).toBe(false);

      // Verify result structure
      expect(result.decision).toBeDefined();
      expect(result.policyMetadata).toBeDefined();
      expect(result.policyMetadata.forcedModel).toBe('claude-3-opus');
      expect(result.policyMetadata.eligibleModelsCount).toBe(1);

      // Verify forced model is used for both primary and alternate
      expect(result.decision.primary.model).toBe('claude-3-opus');
      expect(result.decision.alternate.model).toBe('claude-3-opus');

      // Verify deterministic high confidence score
      expect(result.decision.primary.score).toBe(10);
      expect(result.decision.alternate.score).toBe(10);

      // Verify reasoning indicates policy enforcement
      expect(result.decision.primary.reason).toContain('forced by policy');
      expect(result.decision.primary.reason).toContain('REQUIREMENTS.md §7.2');
    });
  });

  describe('No Policy Configuration', () => {
    it('should pass all available models when no policy restrictions', async () => {
      let receivedModels: string[] = [];

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          receivedModels = eligibleModels;
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: eligibleModels.map((model, idx) => ({
              rank: idx + 1,
              model,
              score: Math.max(3, 8 - idx),
              reason: idx === 0 ? 'Selected from all models' : 'Alternative from all models',
            })),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: mockLogger,
      });

      const tokenConfig = createTokenConfig({
        // No policy restrictions
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      await engine.route(request, tokenConfig);

      // Verify router LLM received all available models
      const allAvailableModels = modelRegistry.getAvailableModels();
      expect(receivedModels.length).toBe(allAvailableModels.length);

      // Check some expected models are present
      expect(receivedModels).toContain('gpt-4-turbo');
      expect(receivedModels).toContain('claude-3-5-sonnet');
      expect(receivedModels).toContain('claude-3-opus');
    });
  });

  describe('Error Cases', () => {
    it('should throw error when policy results in no eligible models', async () => {
      const testRouterLLM: RouterLLM = {
        async invoke() {
          throw new Error('Should not be called');
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: mockLogger,
      });

      // Create a token config that denies all models
      const tokenConfig = createTokenConfig({
        allowed_models: ['non-existent-model'],
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      // Expect the routing to throw an error about no eligible models
      await expect(engine.route(request, tokenConfig)).rejects.toThrow(
        /No eligible models available after policy evaluation/
      );
      await expect(engine.route(request, tokenConfig)).rejects.toThrow(
        /check your token configuration/
      );
    });

    it('should throw error when forced model is not in registry', async () => {
      const testRouterLLM: RouterLLM = {
        async invoke() {
          throw new Error('Should not be called');
        },
      };

      // Create a mock policy engine that returns a forced model not in registry
      const mockPolicyEngine = {
        evaluate: () => ({
          eligible_models: [],
          forced_model: 'non-existent-model-xyz',
          audit_trail: [],
        }),
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine: mockPolicyEngine as any,
        modelRegistry,
        logger: mockLogger,
      });

      const tokenConfig = createTokenConfig({});

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      // Expect error about forced model not in registry
      await expect(engine.route(request, tokenConfig)).rejects.toThrow(
        /Policy forced model 'non-existent-model-xyz' not found in model registry/
      );
    });

    it('should only warn once per token for intent-based rules', async () => {
      let warnCount = 0;
      const testLogger: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => { warnCount++; },
        error: () => {},
      };

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          const decision: RankedRouteDecision = {
            intent: 'other',
            ranked_models: eligibleModels.map((model, idx) => ({
              rank: idx + 1,
              model,
              score: Math.max(3, 8 - idx),
              reason: 'Test',
            })),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
        logger: testLogger,
      });

      const tokenConfig = createTokenConfig({
        policy_rules: [
          {
            type: 'ForceModelByIntent',
            intent: 'coding',
            models: ['gpt-4-turbo'],
          },
        ],
      });

      const request: RouteRequest = {
        prompt: 'Write a function',
      };

      // Make 3 routing requests with same token
      await engine.route(request, tokenConfig);
      await engine.route(request, tokenConfig);
      await engine.route(request, tokenConfig);

      // Should only warn once despite 3 requests
      expect(warnCount).toBe(1);
    });
  });
});
