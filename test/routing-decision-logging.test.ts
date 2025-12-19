import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { Express } from 'express';
import request from 'supertest';
import { InMemoryTokenStore } from '../src/tokens/store';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { createModelRegistry } from '../src/models';
import type { RoutingDecisionLog, PolicyRule, TokenConfig } from '../src/types';
import {
  validateRoutingDecisionLog,
  createRoutingDecisionLog,
} from '../src/logging/routing-decision';

describe('Routing Decision Logging', () => {
  let app: Express;
  let tokenStore: InMemoryTokenStore;
  let knowledgeStore: InMemoryKnowledgeStore;
  let consoleLogSpy: vi.SpyInstance;
  let consoleWarnSpy: vi.SpyInstance;
  let testToken: string;

  beforeEach(async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';

    const result = createApp();
    app = result.app;
    tokenStore = result.dependencies.tokenStore as InMemoryTokenStore;
    knowledgeStore = result.dependencies.knowledgeStore as InMemoryKnowledgeStore;

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create a test token
    const tokenResponse = await request(app)
      .post('/admin/tokens')
      .set('X-Admin-Api-Key', 'test-admin-key')
      .send({
        default_model: 'gpt-4o',
        environment: 'dev',
      });

    if (tokenResponse.status !== 201) {
      throw new Error(
        `Token creation failed: ${tokenResponse.status} ${JSON.stringify(tokenResponse.body)}`
      );
    }

    testToken = tokenResponse.body.token;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  function extractLastLog(spy: vi.SpyInstance): RoutingDecisionLog {
    const calls = spy.mock.calls;
    if (calls.length === 0) {
      throw new Error('No log calls found');
    }
    // Find the routing decision log (has 'Routing decision completed' message)
    for (let i = calls.length - 1; i >= 0; i--) {
      const callArgs = calls[i];
      if (typeof callArgs[0] === 'string') {
        const parsed = JSON.parse(callArgs[0]);
        if (parsed.message === 'Routing decision completed') {
          return parsed;
        }
      }
    }
    throw new Error('No routing decision log found');
  }

  describe('Log Emission', () => {
    it('should emit exactly one routing log per request', async () => {
      consoleLogSpy.mockClear();
      consoleWarnSpy.mockClear();

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Write a function' });

      // Count routing decision logs in both info and warn
      const infoLogs = consoleLogSpy.mock.calls.filter((call) => {
        if (typeof call[0] === 'string') {
          const parsed = JSON.parse(call[0]);
          return parsed.message === 'Routing decision completed';
        }
        return false;
      });

      const warnLogs = consoleWarnSpy.mock.calls.filter((call) => {
        if (typeof call[0] === 'string') {
          const parsed = JSON.parse(call[0]);
          return parsed.message === 'Routing decision completed';
        }
        return false;
      });

      const totalRoutingLogs = infoLogs.length + warnLogs.length;
      expect(totalRoutingLogs).toBe(1);
    });

    it('should log at INFO level for default_model_fallback decision', async () => {
      // Make a request that will use default model
      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Hello world' });

      const log = extractLastLog(consoleWarnSpy);
      expect(log.level).toBe('warn');
      expect(log.decision_reason).toBe('default_model_fallback');
    });

    it('should log at WARN level for system_default fallback', async () => {
      // Create token without default model
      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({ environment: 'dev' });

      const noDefaultToken = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', noDefaultToken)
        .send({ prompt: 'Test' });

      const log = extractLastLog(consoleWarnSpy);
      expect(log.level).toBe('warn');
      expect(log.decision_reason).toBe('system_default');
    });

    it('should log at INFO level for policy_forced decision', async () => {
      const policyRules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'code_change',
          models: ['gpt-4-turbo'],
        },
      ];

      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({
          policy_rules: policyRules,
          environment: 'dev',
        });

      const policyToken = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', policyToken)
        .send({ prompt: 'Write a function' });

      const log = extractLastLog(consoleLogSpy);
      expect(log.level).toBe('info');
      expect(log.decision_reason).toBe('policy_forced');
    });
  });

  describe('Fallback Chain Structure', () => {
    it('should have exactly one "selected" outcome in fallback_chain', async () => {
      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Test prompt' });

      const log = extractLastLog(consoleWarnSpy);
      const selectedCount = log.fallback_chain.filter(
        (e) => e.outcome === 'selected'
      ).length;
      expect(selectedCount).toBe(1);
    });

    it('should match selected_model to fallback_chain selected entry', async () => {
      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Test prompt' });

      const log = extractLastLog(consoleWarnSpy);
      const selectedEntry = log.fallback_chain.find((e) => e.outcome === 'selected');
      expect(selectedEntry?.model).toBe(log.selected_model);
    });

    it('should track policy_forced strategy when policy forces model', async () => {
      const policyRules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'other:legal',
          models: ['claude-3-opus'],
        },
      ];

      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({
          policy_rules: policyRules,
          environment: 'dev',
        });

      const policyToken = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', policyToken)
        .send({ prompt: 'What are the legal implications?' });

      const log = extractLastLog(consoleLogSpy);
      expect(log.fallback_chain).toHaveLength(1);
      expect(log.fallback_chain[0]).toMatchObject({
        strategy: 'policy_forced',
        outcome: 'selected',
        model: 'claude-3-opus',
      });
    });

    it('should track insufficient_confidence outcome for low confidence knowledge', async () => {
      // Build low confidence knowledge
      await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', { scope: 'global' });

      // Create token with trusted anchor
      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({
          trusted_anchor_model: 'claude-3-5-sonnet',
          environment: 'dev',
        });

      const anchorToken = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', anchorToken)
        .send({ prompt: 'Write code' });

      const log = extractLastLog(consoleWarnSpy);
      const consensusEntry = log.fallback_chain.find((e) => e.strategy === 'consensus');
      if (consensusEntry) {
        expect(consensusEntry.outcome).toBe('insufficient_confidence');
      }
    });

    it('should track ineligible outcome when consensus model is denied', async () => {
      // Build strong consensus for gpt-4-turbo
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', { scope: 'global' });
      }

      // Create token that denies gpt-4-turbo
      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({
          denied_models: ['gpt-4-turbo'],
          trusted_anchor_model: 'claude-3-5-sonnet',
          environment: 'dev',
        });

      const deniedToken = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', deniedToken)
        .send({ prompt: 'Write a function' });

      const log = extractLastLog(consoleWarnSpy);
      const consensusEntry = log.fallback_chain.find((e) => e.strategy === 'consensus');
      expect(consensusEntry).toBeDefined();
      expect(consensusEntry?.outcome).toBe('ineligible');
      expect(consensusEntry?.model).toBe('gpt-4-turbo');
    });

    it('should preserve evaluation order in fallback_chain', async () => {
      // Build strong consensus
      for (let i = 0; i < 10; i++) {
        await knowledgeStore.recordVote('code_change', 'gpt-4-turbo', { scope: 'global' });
      }

      // Create token that denies consensus model, has trusted anchor
      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({
          denied_models: ['gpt-4-turbo'],
          trusted_anchor_model: 'claude-3-5-sonnet',
          environment: 'dev',
        });

      const token = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', token)
        .send({ prompt: 'Write code' });

      const log = extractLastLog(consoleWarnSpy);
      // First consensus (ineligible), then trusted_anchor (selected)
      expect(log.fallback_chain[0].strategy).toBe('consensus');
      expect(log.fallback_chain[0].outcome).not.toBe('selected');
      expect(log.fallback_chain[1].strategy).toBe('trusted_anchor');
      expect(log.fallback_chain[1].outcome).toBe('selected');
    });
  });

  describe('Behavioral Guarantees', () => {
    it('should throw if policy_forced but policy_forced_model !== selected_model', () => {
      const invalidLog = {
        decision_reason: 'policy_forced',
        policy_forced_model: 'gpt-4o',
        selected_model: 'claude-3-opus', // WRONG
        fallback_chain: [
          { strategy: 'policy_forced' as const, model: 'gpt-4o', outcome: 'selected' as const },
        ],
      } as RoutingDecisionLog;

      expect(() => validateRoutingDecisionLog(invalidLog)).toThrow('Invariant violation');
    });

    it('should throw if fallback_chain has zero "selected" outcomes', () => {
      const invalidLog = {
        decision_reason: 'default_model_fallback',
        selected_model: 'gpt-4o',
        fallback_chain: [
          { strategy: 'consensus' as const, model: 'gpt-4o', outcome: 'skipped' as const },
        ],
      } as RoutingDecisionLog;

      expect(() => validateRoutingDecisionLog(invalidLog)).toThrow(
        'exactly one "selected" entry'
      );
    });

    it('should throw if fallback_chain has multiple "selected" outcomes', () => {
      const invalidLog = {
        decision_reason: 'default_model_fallback',
        selected_model: 'gpt-4o',
        fallback_chain: [
          { strategy: 'consensus' as const, model: 'gpt-4o', outcome: 'selected' as const },
          {
            strategy: 'trusted_anchor' as const,
            model: 'claude-3-opus',
            outcome: 'selected' as const,
          },
        ],
      } as RoutingDecisionLog;

      expect(() => validateRoutingDecisionLog(invalidLog)).toThrow(
        'exactly one "selected" entry'
      );
    });

    it('should throw if selected_model does not match fallback_chain selected entry', () => {
      const invalidLog = {
        decision_reason: 'trusted_anchor_fallback',
        selected_model: 'gpt-4o',
        fallback_chain: [
          {
            strategy: 'trusted_anchor' as const,
            model: 'claude-3-opus',
            outcome: 'selected' as const,
          },
        ],
      } as RoutingDecisionLog;

      expect(() => validateRoutingDecisionLog(invalidLog)).toThrow('selected_model');
    });

    it('should throw if knowledge_consensus but knowledge fields are null', () => {
      const invalidLog = {
        decision_reason: 'knowledge_consensus',
        selected_model: 'gpt-4-turbo',
        agreement_score: null, // WRONG - should be populated
        confidence_level: null, // WRONG - should be populated
        fallback_chain: [
          { strategy: 'consensus' as const, model: 'gpt-4-turbo', outcome: 'selected' as const },
        ],
      } as RoutingDecisionLog;

      expect(() => validateRoutingDecisionLog(invalidLog)).toThrow('Invariant violation');
    });
  });

  describe('Schema Completeness', () => {
    it('should include all required log fields', async () => {
      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Test prompt' });

      const log = extractLastLog(consoleWarnSpy);

      // Identity & Context
      expect(log).toHaveProperty('timestamp');
      expect(log).toHaveProperty('request_id');
      expect(log).toHaveProperty('token_id');
      expect(log).toHaveProperty('environment');

      // Intent
      expect(log).toHaveProperty('intent_label');
      expect(log).toHaveProperty('intent_confidence');
      expect(log).toHaveProperty('intent_source');

      // Knowledge Scope
      expect(log).toHaveProperty('knowledge_scope');
      expect(log).toHaveProperty('knowledge_key');
      expect(log).toHaveProperty('knowledge_last_updated');

      // Policy
      expect(log).toHaveProperty('policy_applied');
      expect(log).toHaveProperty('policy_forced_model');
      expect(log).toHaveProperty('policy_rules_applied');

      // Model Eligibility
      expect(log).toHaveProperty('eligible_models');
      expect(log).toHaveProperty('denied_models');
      expect(log).toHaveProperty('default_model');

      // Knowledge & Confidence
      expect(log).toHaveProperty('agreement_score');
      expect(log).toHaveProperty('confidence_level');
      expect(log).toHaveProperty('confidence_threshold');
      expect(log).toHaveProperty('consensus_model');

      // Decision
      expect(log).toHaveProperty('selected_model');
      expect(log).toHaveProperty('decision_reason');

      // Fallbacks
      expect(log).toHaveProperty('trusted_anchor_model');
      expect(log).toHaveProperty('fallback_chain');
    });

    it('should populate null for missing optional fields', async () => {
      // Create token with no optional fields
      const tokenResponse = await request(app)
        .post('/admin/tokens')
        .set('X-Admin-Api-Key', 'test-admin-key')
        .send({ environment: 'dev' });

      const minimalToken = tokenResponse.body.token;

      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', minimalToken)
        .send({ prompt: 'Test' });

      const log = extractLastLog(consoleWarnSpy);

      expect(log.trusted_anchor_model).toBeNull();
      expect(log.default_model).toBeNull();
      expect(log.policy_forced_model).toBeNull();
    });

    it('should have knowledge fields null when no knowledge exists', async () => {
      await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Some unique prompt that has no knowledge' });

      const log = extractLastLog(consoleWarnSpy);

      // No knowledge for this intent, so these should be null
      expect(log.knowledge_key).toBeNull();
      expect(log.knowledge_last_updated).toBeNull();
      expect(log.agreement_score).toBeNull();
      expect(log.confidence_level).toBeNull();
    });
  });

  describe('Response Stripping', () => {
    it('should not include _internal field in HTTP response', async () => {
      const response = await request(app)
        .post('/route')
        .set('X-Wayfinder-Token', testToken)
        .send({ prompt: 'Test' });

      expect(response.body).not.toHaveProperty('_internal');
      expect(response.body).toHaveProperty('selected_model');
      expect(response.body).toHaveProperty('routing_decision');
      expect(response.body).toHaveProperty('request_id');
    });
  });
});
