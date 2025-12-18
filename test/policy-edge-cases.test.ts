import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultPolicyEngine } from '../src/policy/engine';
import { TokenConfig, PolicyRule, IntentLabel } from '../src/types';

describe('PolicyEngine Edge Cases and Security', () => {
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

  describe('Empty and Null Configuration Edge Cases', () => {
    it('should handle completely empty token config', () => {
      const config = createTokenConfig({});

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(allModels);
      expect(result.forced_model).toBeNull();
      expect(result.audit_trail).toHaveLength(0);
    });

    it('should handle empty availableModels array', () => {
      const config = createTokenConfig({});

      const result = engine.evaluate('coding', [], config);

      expect(result.eligible_models).toEqual([]);
      expect(result.forced_model).toBeNull();
    });

    it('should handle null policy_rules', () => {
      const config = createTokenConfig({
        policy_rules: undefined,
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(allModels);
    });

    it('should handle empty policy_rules array', () => {
      const config = createTokenConfig({
        policy_rules: [],
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(allModels);
      expect(result.audit_trail).toHaveLength(0);
    });

    it('should handle empty allowed_models array', () => {
      const config = createTokenConfig({
        allowed_models: [],
      });

      const result = engine.evaluate('coding', allModels, config);

      // Empty array should be treated as "not configured" - allow all
      expect(result.eligible_models).toEqual(allModels);
    });

    it('should handle empty denied_models array', () => {
      const config = createTokenConfig({
        denied_models: [],
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(allModels);
    });
  });

  describe('Policy Rule Priority Edge Cases', () => {
    it('should handle rules with undefined priority (default to 100)', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo'],
          // priority undefined
        },
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['claude-3-5-sonnet'],
          priority: 50,
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Force rule with priority 50 should execute before restrict (100)
      expect(result.forced_model).toBe('claude-3-5-sonnet');
    });

    it('should handle negative priority values', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
          priority: 1,
        },
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['claude-3-5-sonnet'],
          priority: -100, // Should execute first
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Negative priority should win
      expect(result.forced_model).toBe('claude-3-5-sonnet');
    });

    it('should handle identical priorities (stable sort)', () => {
      const rules: PolicyRule[] = [
        {
          type: 'DenyModelsGlobal',
          models: ['gpt-4-turbo'],
          priority: 1,
        },
        {
          type: 'DenyModelsGlobal',
          models: ['gpt-4o'],
          priority: 1,
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Both should be applied
      expect(result.eligible_models).not.toContain('gpt-4-turbo');
      expect(result.eligible_models).not.toContain('gpt-4o');
    });

    it('should stop processing after ForceModelByIntent', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['claude-3-5-sonnet'],
          priority: 1,
        },
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo'], // Should not be processed
          priority: 2,
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.forced_model).toBe('claude-3-5-sonnet');
      expect(result.eligible_models).toEqual(['claude-3-5-sonnet']);
      // Only force rule should be in audit trail
      expect(result.audit_trail.length).toBe(1);
    });
  });

  describe('ForceModelByIntent Edge Cases', () => {
    it('should not force model when intent does not match', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'legal',
          models: ['claude-3-opus'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.forced_model).toBeNull();
      expect(result.audit_trail.length).toBe(0);
    });

    it('should force first eligible model from list', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['non-existent-model', 'claude-3-5-sonnet', 'gpt-4-turbo'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Should pick first eligible (claude-3-5-sonnet)
      expect(result.forced_model).toBe('claude-3-5-sonnet');
    });

    it('should not force when no models in list are eligible', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['non-existent-1', 'non-existent-2'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.forced_model).toBeNull();
      // Should still have audit entry documenting the attempt
      expect(result.audit_trail.length).toBe(1);
      expect(result.audit_trail[0]?.rule_type).toBe('ForceModelByIntent');
    });

    it('should respect global deny before force', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo'],
        },
      ];

      const config = createTokenConfig({
        denied_models: ['gpt-4-turbo'],
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      // Model is denied globally, so can't be forced
      expect(result.forced_model).toBeNull();
      expect(result.eligible_models).not.toContain('gpt-4-turbo');
    });

    it('should handle empty models array in ForceModelByIntent', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: [],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.forced_model).toBeNull();
    });
  });

  describe('RestrictModelsByIntent Edge Cases', () => {
    it('should only apply restriction when intent matches', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'legal',
          models: ['claude-3-opus'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Intent doesn't match, so no restriction
      expect(result.eligible_models).toEqual(allModels);
      expect(result.audit_trail.length).toBe(0);
    });

    it('should restrict to intersection of allowed models', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'non-existent'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
    });

    it('should handle restriction to no models (empty result)', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['non-existent-model'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual([]);
    });

    it('should combine with global allow list correctly', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'gemini-1.5-pro'],
        },
      ];

      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      // Should be intersection of both
      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
    });

    it('should not add audit entry if no models removed', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: allModels, // All models in list
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // No models removed, no audit entry needed
      expect(result.audit_trail.length).toBe(0);
    });
  });

  describe('Global Allow/Deny Edge Cases', () => {
    it('should apply allow list before deny list', () => {
      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'gemini-1.5-pro'],
        denied_models: ['gemini-1.5-pro'],
      });

      const result = engine.evaluate('coding', allModels, config);

      // Allow first (3 models), then deny (remove gemini)
      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
      expect(result.audit_trail.length).toBe(2);
    });

    it('should handle allowed and denied containing same model', () => {
      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        denied_models: ['gpt-4-turbo'], // Also in allowed
      });

      const result = engine.evaluate('coding', allModels, config);

      // Allow first, then deny wins
      expect(result.eligible_models).toEqual(['claude-3-5-sonnet']);
    });

    it('should handle denying all models', () => {
      const config = createTokenConfig({
        denied_models: allModels,
      });

      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual([]);
    });

    it('should handle allowing non-existent models', () => {
      const config = createTokenConfig({
        allowed_models: ['non-existent-1', 'non-existent-2'],
      });

      const result = engine.evaluate('coding', allModels, config);

      // No available models match the allow list
      expect(result.eligible_models).toEqual([]);
    });

    it('should handle denying non-existent models', () => {
      const config = createTokenConfig({
        denied_models: ['non-existent-1', 'non-existent-2'],
      });

      const result = engine.evaluate('coding', allModels, config);

      // Should not affect eligible models
      expect(result.eligible_models).toEqual(allModels);
    });
  });

  describe('Multiple Rules Interaction', () => {
    it('should handle multiple deny rules', () => {
      const rules: PolicyRule[] = [
        {
          type: 'DenyModelsGlobal',
          models: ['gpt-4-turbo'],
        },
        {
          type: 'DenyModelsGlobal',
          models: ['gpt-4o'],
        },
        {
          type: 'DenyModelsGlobal',
          models: ['gemini-1.5-pro'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      expect(result.eligible_models).toEqual(['claude-3-5-sonnet', 'claude-3-opus']);
    });

    it('should handle multiple restrict rules for same intent', () => {
      const rules: PolicyRule[] = [
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'gemini-1.5-pro'],
          priority: 1,
        },
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
          priority: 2,
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Second restriction further narrows
      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
    });

    it('should handle complex rule chain', () => {
      const rules: PolicyRule[] = [
        {
          type: 'AllowModelsGlobal',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'gemini-1.5-pro'],
          priority: 1,
        },
        {
          type: 'DenyModelsGlobal',
          models: ['gemini-1.5-pro'],
          priority: 2,
        },
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'claude-3-opus'],
          priority: 3,
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      // Allow: [gpt-4-turbo, claude-3-5-sonnet, gemini-1.5-pro]
      // Deny gemini: [gpt-4-turbo, claude-3-5-sonnet]
      // Restrict: [gpt-4-turbo, claude-3-5-sonnet] (intersection)
      expect(result.eligible_models).toEqual(['gpt-4-turbo', 'claude-3-5-sonnet']);
    });
  });

  describe('Audit Trail Completeness', () => {
    it('should include all applied rules in audit trail', () => {
      const rules: PolicyRule[] = [
        {
          type: 'DenyModelsGlobal',
          models: ['gpt-4o'],
        },
        {
          type: 'RestrictModelsByIntent',
          intent: 'coding',
          models: ['gpt-4-turbo', 'claude-3-5-sonnet'],
        },
      ];

      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo', 'claude-3-5-sonnet', 'gpt-4o'],
        policy_rules: rules,
      });

      const result = engine.evaluate('coding', allModels, config);

      // Should have entries for: allow list, deny, restrict
      expect(result.audit_trail.length).toBeGreaterThanOrEqual(2);

      const ruleTypes = result.audit_trail.map(e => e.rule_type);
      expect(ruleTypes).toContain('AllowModelsGlobal');
      expect(ruleTypes).toContain('DenyModelsGlobal');
    });

    it('should include timestamps in all audit entries', () => {
      const config = createTokenConfig({
        allowed_models: ['gpt-4-turbo'],
        denied_models: ['gpt-4o'],
      });

      const result = engine.evaluate('coding', allModels, config);

      for (const entry of result.audit_trail) {
        expect(entry.timestamp).toBeDefined();
        expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
      }
    });

    it('should include intent in audit entries when applicable', () => {
      const rules: PolicyRule[] = [
        {
          type: 'ForceModelByIntent',
          intent: 'coding',
          models: ['claude-3-5-sonnet'],
        },
      ];

      const config = createTokenConfig({ policy_rules: rules });
      const result = engine.evaluate('coding', allModels, config);

      const forceEntry = result.audit_trail.find(e => e.rule_type === 'ForceModelByIntent');
      expect(forceEntry?.intent).toBe('coding');
    });
  });

  describe('Intent Variations', () => {
    const allIntents: IntentLabel[] = [
      'code_review',
      'coding',
      'legal',
      'summarization',
      'reasoning',
      'creative',
      'support',
      'other',
    ];

    it('should handle all valid intent types', () => {
      for (const intent of allIntents) {
        const rules: PolicyRule[] = [
          {
            type: 'RestrictModelsByIntent',
            intent,
            models: ['gpt-4-turbo'],
          },
        ];

        const config = createTokenConfig({ policy_rules: rules });
        const result = engine.evaluate(intent, allModels, config);

        expect(result.eligible_models).toEqual(['gpt-4-turbo']);
      }
    });

    it('should handle intent mismatch across all intent types', () => {
      for (const ruleIntent of allIntents) {
        for (const requestIntent of allIntents) {
          if (ruleIntent === requestIntent) continue;

          const rules: PolicyRule[] = [
            {
              type: 'RestrictModelsByIntent',
              intent: ruleIntent,
              models: ['gpt-4-turbo'],
            },
          ];

          const config = createTokenConfig({ policy_rules: rules });
          const result = engine.evaluate(requestIntent, allModels, config);

          // Should not apply restriction
          expect(result.eligible_models).toEqual(allModels);
        }
      }
    });
  });

  describe('Model Name Edge Cases', () => {
    it('should handle models with special characters', () => {
      const specialModels = ['model-v1.0', 'model@2.0', 'model_v3', 'model:beta'];

      const config = createTokenConfig({
        allowed_models: specialModels,
      });

      const result = engine.evaluate('coding', specialModels, config);

      expect(result.eligible_models).toEqual(specialModels);
    });

    it('should handle case-sensitive model names', () => {
      const config = createTokenConfig({
        allowed_models: ['GPT-4-turbo'], // Different case
      });

      const result = engine.evaluate('coding', allModels, config);

      // Should not match 'gpt-4-turbo' (case sensitive)
      expect(result.eligible_models).toEqual([]);
    });

    it('should handle very long model names', () => {
      const longName = 'very-long-model-name-' + 'a'.repeat(1000);
      const models = [longName];

      const config = createTokenConfig({
        allowed_models: [longName],
      });

      const result = engine.evaluate('coding', models, config);

      expect(result.eligible_models).toEqual([longName]);
    });
  });
});
