/**
 * Routing Integration Tests
 *
 * Tests the full routing flow with the canonical RouteDecision contract:
 * - Engine invokes router LLM and validates response
 * - Routes handler projects response and excludes intent from HTTP
 * - Invalid router LLM responses are rejected with proper error codes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import type { RouterLLM } from '../src/routing';
import { createRoutingEngine } from '../src/routing';
import type { TokenConfig } from '../src/types';
import { createTokenStore, InMemoryTokenStore } from '../src/tokens';
import { createPolicyEngine } from '../src/policy';
import { createModelRegistry } from '../src/models';
import type { Logger } from '../src/logging/logger';

describe('Routing Integration', () => {
  let app: any;
  let tokenStore: InMemoryTokenStore;
  let testToken: string;
  const policyEngine = createPolicyEngine();
  const modelRegistry = createModelRegistry();
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    // Create token store and token
    tokenStore = createTokenStore() as InMemoryTokenStore;
    const tokenResponse = await tokenStore.create({});
    testToken = tokenResponse.token;
  });

  describe('Valid Router LLM Response', () => {
    it('returns primary and alternate without intent', async () => {
      // Create a router LLM that returns valid RouteDecision
      const validRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            primary: {
              model: 'gpt-4',
              score: 8,
              reason: 'Best suited for code generation tasks',
            },
            alternate: {
              model: 'claude-3-sonnet',
              score: 6,
              reason: 'Viable alternative with good code understanding',
            },
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: validRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function to calculate fibonacci' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('primary');
      expect(response.body).toHaveProperty('alternate');
      expect(response.body).toHaveProperty('request_id');
      expect(response.body).not.toHaveProperty('intent');

      expect(response.body.primary).toEqual({
        model: 'gpt-4',
        score: 8,
        reason: 'Best suited for code generation tasks',
      });

      expect(response.body.alternate).toEqual({
        model: 'claude-3-sonnet',
        score: 6,
        reason: 'Viable alternative with good code understanding',
      });
    });

    it('accepts free text intent from router LLM', async () => {
      const customIntentRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'custom_research_analysis',
            primary: {
              model: 'claude-3-opus',
              score: 9,
              reason: 'Excellent for research tasks',
            },
            alternate: {
              model: 'gpt-4',
              score: 7,
              reason: 'Good alternative',
            },
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: customIntentRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Analyze this dataset' });

      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('intent');
    });
  });

  describe('Invalid Router LLM Response', () => {
    it('rejects response missing intent', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
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
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('RouterLLMContractViolation');
      expect(response.body.message).toContain('violated canonical schema');
    });

    it('rejects response missing primary', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            alternate: {
              model: 'claude-3-sonnet',
              score: 6,
              reason: 'Good alternative',
            },
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('RouterLLMContractViolation');
    });

    it('rejects response missing alternate', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            primary: {
              model: 'gpt-4',
              score: 8,
              reason: 'Best for code generation',
            },
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('RouterLLMContractViolation');
    });

    it('rejects score out of range', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            primary: {
              model: 'gpt-4',
              score: 15, // Invalid: > 10
              reason: 'Best for code generation',
            },
            alternate: {
              model: 'claude-3-sonnet',
              score: 6,
              reason: 'Good alternative',
            },
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('RouterLLMContractViolation');
    });

    it('rejects additional properties', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
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
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('RouterLLMContractViolation');
    });

    it('rejects array of alternates', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
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
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('RouterLLMContractViolation');
    });
  });

  describe('Intent Advisory Only', () => {
    it('logs intent but does not expose it in response', async () => {
      const routerLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'debugging',
            primary: {
              model: 'claude-3-opus',
              score: 9,
              reason: 'Superior debugging capabilities',
            },
            alternate: {
              model: 'gpt-4',
              score: 7,
              reason: 'Alternative debugger',
            },
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Debug this function' });

      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('intent');
      expect(response.body.primary.model).toBe('claude-3-opus');
    });
  });
});
