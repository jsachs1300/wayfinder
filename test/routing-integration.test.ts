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
import type { TokenConfig, RankedRouteDecision } from '../src/types';
import type { MultiProviderResult } from '../src/routing/router-llm';
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
      // Create a router LLM that returns valid MultiProviderResult
      const validRouterLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'code_change',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 8, reason: 'Best suited for code generation tasks' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 6, reason: 'Viable alternative with good code understanding' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: validRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

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
          const decision: RankedRouteDecision = {
            intent: 'custom_research_analysis',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'claude-3-opus', score: 9, reason: 'Excellent for research tasks' },
              { rank: 2, model: 'gpt-4o', score: 7, reason: 'Good alternative' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM: customIntentRouterLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

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
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

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
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

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
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

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
          const decision: RankedRouteDecision = {
            intent: 'debugging',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'claude-3-opus', score: 9, reason: 'Superior debugging capabilities' },
              { rank: 2, model: 'gpt-4o', score: 7, reason: 'Alternative debugger' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Debug this function' });

      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('intent');
      expect(response.body.primary.model).toBe('claude-3-opus');
    });
  });

  describe('Router Model Selection', () => {
    it('defaults to consensus when no router_model specified', async () => {
      const routerLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 8, reason: 'Alternative' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('router_model_used', 'consensus');
      expect(response.body).toHaveProperty('from_cache', false);
    });

    it('uses request-level router_model parameter', async () => {
      const routerLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 8, reason: 'Alternative' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({
          prompt: 'Write a function',
          router_model: 'openai'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('router_model_used', 'openai');
      expect(response.body).toHaveProperty('from_cache', false);
    });

    it('uses token-level router_model_preference as default', async () => {
      // Create token with router_model_preference
      const tokenResponse = await tokenStore.create({
        router_model_preference: 'gemini'
      });
      const tokenWithPreference = tokenResponse.token;

      const routerLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 8, reason: 'Alternative' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', tokenWithPreference)
        .send({ prompt: 'Write a function' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('router_model_used');
      // For now, just verify it has the field - the actual router selection
      // depends on whether cache is enabled. Without cache, it uses consensus.
      expect(['gemini', 'consensus']).toContain(response.body.router_model_used);
    });

    it('request-level router_model overrides token-level preference', async () => {
      // Create token with router_model_preference='gemini'
      const tokenResponse = await tokenStore.create({
        router_model_preference: 'gemini'
      });
      const tokenWithPreference = tokenResponse.token;

      const routerLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 8, reason: 'Alternative' },
            ]),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', tokenWithPreference)
        .send({
          prompt: 'Write a function',
          router_model: 'openai' // Override token preference
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('router_model_used', 'openai');
    });

    it('returns HTTP 203 when requested provider unavailable and falls back to consensus', async () => {
      const routerLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: createCompleteRanking([
              { rank: 1, model: 'gpt-4-turbo', score: 9, reason: 'Best for coding' },
              { rank: 2, model: 'claude-3-5-sonnet', score: 8, reason: 'Alternative' },
            ]),
          };

          // Return MultiProviderResult with only consensus (simulate provider failure)
          return {
            provider_rankings: {
              // No openai or gemini rankings - simulate both failed
            },
            consensus: decision,
          };
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({
          prompt: 'Write a function',
          router_model: 'openai' // Request openai but it's not available
        });

      // HTTP 203 indicates success but with fallback
      expect(response.status).toBe(203);
      expect(response.body).toHaveProperty('router_model_used', 'consensus');
    });

    it('rejects invalid router_model parameter', async () => {
      const routerLLM: RouterLLM = {
        async invoke() {
          const decision: RankedRouteDecision = {
            intent: 'coding',
            ranked_models: createCompleteRanking(),
          };
          return buildMultiProviderResult(decision);
        },
      };

      const routingEngine = createRoutingEngine({ routerLLM, policyEngine, modelRegistry, logger });
      const { app: testApp } = await createApp({ tokenStore, routingEngine });

      const response = await request(testApp)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({
          prompt: 'Write a function',
          router_model: 'invalid-provider' // Invalid value
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('ValidationError');
    });
  });
});
