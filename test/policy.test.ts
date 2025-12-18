import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultPolicyEngine } from '../src/policy/engine';
import { TokenConfig, PolicyRule, IntentLabel } from '../src/types';

describe('PolicyEngine', () => {
  let engine: DefaultPolicyEngine;
  const allModels = ['gpt-4-turbo', 'gpt-4o', 'claude-3-5-sonnet', 'claude-3-opus', 'gemini-1.5-pro'];

  beforeEach(() => {
    engine = new DefaultPolicyEngine();
  });

  function createTokenConfig(overrides: Partial<TokenConfig> = {}): TokenConfig {
    return {
      id: 'test-token',
      token_hash: 'hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('Policy Precedence', () => {
    it('should apply global allow list first', () => {
      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
      expect(result.audit_trail).toHaveLength(1);
      expect(result.audit_trail[0]?.rule_type).toBe('AllowModelsGlobal');
    });

    it('should apply global deny list after allow list', () => {
      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'gemini-1.5-pro'],
        denied_models: ['gemini-1.5-pro'],
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
      expect(result.audit_trail).toHaveLength(2);
    });

    it('should apply intent restrictions after global rules', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo'],
        },
      ];

      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(['gpt-4-turbo']);
    });

    it('should force model when ForceModelByIntent matches', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'legal',
          models: ['claude-3-opus'],
        },
      ];

      const config = createTokenConfig({
        policy_rules: rules,
      });

      const result = engine.evaluate('legal', allModels, config);

      expect(result.forced_model).toBe('claude-3-opus');
      expect(result.eligible_models).toEqual(['claude-3-opus']);
    });

    it('should not force model when intent does not match', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'legal',
          models: ['claude-3-opus'],
        },
      ];

      const config = createTokenConfig({
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.forced_model).toBeNull();
      expect(result.eligible_models).toEqual(allModels);
    });
  });

  describe('Rule Priority', () => {
    it('should process rules in priority order', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
          priority: 2,
        },
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['claude-3-5-sonnet'],
          priority: 1,
        },
      ];

      const config = createTokenConfig({
        policy_rules: rules,
      });

      // Force rule has higher priority (lower number), should win
      const result = engine.evaluate('coding', allModels, config);

      expect(result.forced_model).toBe('claude-3-5-sonnet');
    });
  });

  describe('Edge Cases', () => {
    it('should return all models when no rules are defined', () => {
      const config = createTokenConfig({});

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(allModels);
      expect(result.forced_model).toBeNull();
      expect(result.audit_trail).toHaveLength(0);
    });

    it('should treat empty allowed_models as not configured', () => {
      const config = createTokenConfig({
        allowed_models: [],
      });

      const result = engine.evaluate('coding', allModels, config);

      // Empty allow list is treated as "not configured" - all models remain eligible
      expect(result.eligible_models).toEqual(allModels);
    });

    it('should handle force model not in eligible list', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['non-existent-model'],
        },
      ];

      const config = createTokenConfig({
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      // Cannot force a model that isn't available
      expect(result.forced_model).toBeNull();
    });

    it('should generate audit trail for all applied rules', () => {
      const rules: PolicyRule[] = [
        {
          type: 'DenyModelsGlobal',
          models: ['gemini-1.5-pro'],
        },
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        },
      ];

      const config = createTokenConfig({
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.audit_trail.length).toBeGreaterThan(0);
      expect(result.audit_trail.every((e) => e.timestamp)).toBe(true);
    });
  });
});
