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
import type { TokenConfig, RouteRequest } from '../src/types';

describe('Policy-Routing Integration', () => {
  const policyEngine = createPolicyEngine();
  const modelRegistry = createModelRegistry();

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
          return {
            intent: 'coding',
            primary: {
              model: eligibleModels[0],
              score: 8,
              reason: 'Selected from eligible list',
            },
            alternate: {
              model: eligibleModels[1] || eligibleModels[0],
              score: 6,
              reason: 'Alternative from eligible list',
            },
          };
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
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
          return {
            intent: 'coding',
            primary: {
              model: eligibleModels[0],
              score: 8,
              reason: 'Selected from eligible list',
            },
            alternate: {
              model: eligibleModels[1],
              score: 6,
              reason: 'Alternative from eligible list',
            },
          };
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
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
          return {
            intent: 'coding',
            primary: {
              model: eligibleModels[0],
              score: 8,
              reason: 'Selected from eligible list',
            },
            alternate: {
              model: eligibleModels[1],
              score: 6,
              reason: 'Alternative from eligible list',
            },
          };
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
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
    it('should enforce forced model when policy rule matches', async () => {
      let receivedModels: string[] = [];

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          receivedModels = eligibleModels;
          return {
            intent: 'coding',
            primary: {
              model: eligibleModels[0],
              score: 8,
              reason: 'Selected forced model',
            },
            alternate: {
              model: eligibleModels[0],
              score: 8,
              reason: 'Only one option available',
            },
          };
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
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

      const decision = await engine.route(request, tokenConfig);

      // Verify router LLM only received the forced model
      expect(receivedModels).toEqual(['claude-3-opus']);
      expect(decision.primary.model).toBe('claude-3-opus');
    });
  });

  describe('No Policy Configuration', () => {
    it('should pass all available models when no policy restrictions', async () => {
      let receivedModels: string[] = [];

      const testRouterLLM: RouterLLM = {
        async invoke(_prompt: string, eligibleModels: string[]) {
          receivedModels = eligibleModels;
          return {
            intent: 'coding',
            primary: {
              model: eligibleModels[0],
              score: 8,
              reason: 'Selected from all models',
            },
            alternate: {
              model: eligibleModels[1],
              score: 6,
              reason: 'Alternative from all models',
            },
          };
        },
      };

      const engine = new DefaultRoutingEngine({
        routerLLM: testRouterLLM,
        policyEngine,
        modelRegistry,
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
  });
});
