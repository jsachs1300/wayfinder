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

  // All available models for complete ranking
  const allModels = [
    'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini',
    'claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku',
    'gemini-1.5-pro', 'gemini-1.5-flash',
    'llama-3.1-70b', 'llama-3.1-8b',
    'mistral-large', 'mistral-medium'
  ];

  // Helper to create complete ranked models list
  function createCompleteRanking(overrides?: { rank?: number; model?: string; score?: number; reason?: string }[]) {
    const ranking = allModels.map((model, idx) => ({
      rank: idx + 1,
      model,
      score: 10 - idx * 0.5,
      reason: `Reason for ${model}`,
    }));

    if (overrides) {
      overrides.forEach((override) => {
        const targetIdx = (override.rank || 1) - 1; // Convert rank to index

        if (override.model && override.model !== ranking[targetIdx].model) {
          // If changing the model, we need to swap to avoid duplicates
          const sourceIdx = ranking.findIndex((r) => r.model === override.model);
          if (sourceIdx >= 0) {
            // Swap the models to avoid duplicates
            const temp = ranking[targetIdx].model;
            ranking[targetIdx].model = override.model;
            ranking[sourceIdx].model = temp;
          }
        }

        // Apply other overrides (score, reason)
        if (override.rank) {
          ranking[targetIdx].rank = override.rank;
        }
        if (override.score !== undefined) {
          ranking[targetIdx].score = override.score;
        }
        if (override.reason) {
          ranking[targetIdx].reason = override.reason;
        }
      });
    }

    return ranking;
  }

  beforeEach(async () => {
    // Create token store and token
    tokenStore = createTokenStore() as InMemoryTokenStore;
    const tokenResponse = await tokenStore.create({});
    testToken = tokenResponse.token;
  });

  describe('Valid Router LLM Response', () => {
    it('returns primary and alternate without intent', async () => {
      // Create a router LLM that returns valid RankedRouteDecision
      const validRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 8, reason: 'Best suited for code generation tasks' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 6, reason: 'Viable alternative with good code understanding' },
            ]),
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
        model: 'gpt-4-turbo',
        score: 8,
        reason: 'Best suited for code generation tasks',
      });

      expect(response.body.alternate).toEqual({
        model: 'claude-3-5-sonnet',
        score: 6,
        reason: 'Viable alternative with good code understanding',
      });
    });

    it('accepts free text intent from router LLM', async () => {
      const customIntentRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'custom_research_analysis',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'claude-3-opus', score: 9, reason: 'Excellent for research tasks' },
              { rank: 2, model: 'gpt-4o', score: 7, reason: 'Good alternative' },
            ]),
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
    it('rejects response missing ranked_models', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
          } as any;
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: invalidRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('InternalError');
    });

    it('rejects response with empty ranked_models', async () => {
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            ranked_models: [],
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
      expect(response.body.error).toBe('InternalError');
    });

    it('rejects incomplete ranking (missing models)', async () => {
      // All eligible models must be ranked - incomplete rankings are rejected
      const invalidRouterLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'code_change',
            ranked_models: [
              {
                rank: 1,
                model: 'gpt-4-turbo',
                score: 8,
                reason: 'Best for code generation',
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

      // Incomplete rankings are rejected by validation
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('InternalError');
    });
  });

  describe('Intent Advisory Only', () => {
    it('logs intent but does not expose it in response', async () => {
      const routerLLM: RouterLLM = {
        async invoke() {
          return {
            intent: 'debugging',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'claude-3-opus', score: 9, reason: 'Superior debugging capabilities' },
              { rank: 2, model: 'gpt-4o', score: 7, reason: 'Alternative debugger' },
            ]),
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
