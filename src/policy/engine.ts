import {
  PolicyRule,
  PolicyEvaluationResult,
  PolicyAuditEntry,
  IntentLabel,
  TokenConfig,
} from '../types';

/**
 * Policy engine interface
 */
export interface PolicyEngine {
  evaluate(
    intent: IntentLabel,
    availableModels: string[],
    tokenConfig: TokenConfig
  ): PolicyEvaluationResult;
}

/**
 * Default policy engine implementation
 *
 * Evaluation order:
 * 1. Global allow/deny (from token config)
 * 2. Intent-based restrictions (RestrictModelsByIntent)
 * 3. Forced model (ForceModelByIntent)
 */
export class DefaultPolicyEngine implements PolicyEngine {
  evaluate(
    intent: IntentLabel,
    availableModels: string[],
    tokenConfig: TokenConfig
  ): PolicyEvaluationResult {
    const auditTrail: PolicyAuditEntry[] = [];
    let eligibleModels = [...availableModels];
    let forcedModel: string | null = null;

    // Step 1: Apply global allow list (if specified, only these are allowed)
    if (tokenConfig.allowed_models && tokenConfig.allowed_models.length > 0) {
      const previousCount = eligibleModels.length;
      eligibleModels = eligibleModels.filter((m) =>
        tokenConfig.allowed_models!.includes(m)
      );

      if (eligibleModels.length !== previousCount) {
        auditTrail.push({
          rule_type: 'AllowModelsGlobal',
          action: 'allow',
          models_affected: tokenConfig.allowed_models,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Step 2: Apply global deny list
    if (tokenConfig.denied_models && tokenConfig.denied_models.length > 0) {
      const deniedSet = new Set(tokenConfig.denied_models);
      const previousModels = [...eligibleModels];
      eligibleModels = eligibleModels.filter((m) => !deniedSet.has(m));

      const removed = previousModels.filter((m) => deniedSet.has(m));
      if (removed.length > 0) {
        auditTrail.push({
          rule_type: 'DenyModelsGlobal',
          action: 'deny',
          models_affected: removed,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Step 3: Apply policy rules from token config
    if (tokenConfig.policy_rules && tokenConfig.policy_rules.length > 0) {
      // Sort by priority (lower number = higher priority)
      const sortedRules = [...tokenConfig.policy_rules].sort(
        (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
      );

      for (const rule of sortedRules) {
        const result = this.applyRule(rule, intent, eligibleModels);

        if (result.auditEntry) {
          auditTrail.push(result.auditEntry);
        }

        eligibleModels = result.eligibleModels;

        if (result.forcedModel) {
          forcedModel = result.forcedModel;
          // Force model takes precedence, stop processing
          break;
        }
      }
    }

    return {
      eligible_models: eligibleModels,
      forced_model: forcedModel,
      audit_trail: auditTrail,
    };
  }

  private applyRule(
    rule: PolicyRule,
    intent: IntentLabel,
    currentModels: string[]
  ): {
    eligibleModels: string[];
    forcedModel: string | null;
    auditEntry: PolicyAuditEntry | null;
  } {
    switch (rule.type) {
      case 'ForceModelByIntent':
        return this.applyForceModelByIntent(rule, intent, currentModels);

      case 'RestrictModelsByIntent':
        return this.applyRestrictModelsByIntent(rule, intent, currentModels);

      case 'AllowModelsGlobal':
        return this.applyAllowModelsGlobal(rule, currentModels);

      case 'DenyModelsGlobal':
        return this.applyDenyModelsGlobal(rule, currentModels);

      default:
        return {
          eligibleModels: currentModels,
          forcedModel: null,
          auditEntry: null,
        };
    }
  }

  private applyForceModelByIntent(
    rule: PolicyRule,
    intent: IntentLabel,
    currentModels: string[]
  ): {
    eligibleModels: string[];
    forcedModel: string | null;
    auditEntry: PolicyAuditEntry | null;
  } {
    // Only apply if intent matches
    if (rule.intent !== intent) {
      return {
        eligibleModels: currentModels,
        forcedModel: null,
        auditEntry: null,
      };
    }

    // Force the first model in the rule's model list that's eligible
    const forcedModel = rule.models.find((m) => currentModels.includes(m));

    if (!forcedModel) {
      // No eligible model to force
      return {
        eligibleModels: currentModels,
        forcedModel: null,
        auditEntry: {
          rule_type: 'ForceModelByIntent',
          action: 'force',
          models_affected: rule.models,
          intent,
          timestamp: new Date().toISOString(),
        },
      };
    }

    return {
      eligibleModels: [forcedModel],
      forcedModel,
      auditEntry: {
        rule_type: 'ForceModelByIntent',
        action: 'force',
        models_affected: [forcedModel],
        intent,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private applyRestrictModelsByIntent(
    rule: PolicyRule,
    intent: IntentLabel,
    currentModels: string[]
  ): {
    eligibleModels: string[];
    forcedModel: string | null;
    auditEntry: PolicyAuditEntry | null;
  } {
    // Only apply if intent matches
    if (rule.intent !== intent) {
      return {
        eligibleModels: currentModels,
        forcedModel: null,
        auditEntry: null,
      };
    }

    // Restrict to only models in the rule's list
    const restrictedSet = new Set(rule.models);
    const newModels = currentModels.filter((m) => restrictedSet.has(m));
    const removed = currentModels.filter((m) => !restrictedSet.has(m));

    if (removed.length > 0) {
      return {
        eligibleModels: newModels,
        forcedModel: null,
        auditEntry: {
          rule_type: 'RestrictModelsByIntent',
          action: 'restrict',
          models_affected: removed,
          intent,
          timestamp: new Date().toISOString(),
        },
      };
    }

    return {
      eligibleModels: newModels,
      forcedModel: null,
      auditEntry: null,
    };
  }

  private applyAllowModelsGlobal(
    rule: PolicyRule,
    currentModels: string[]
  ): {
    eligibleModels: string[];
    forcedModel: string | null;
    auditEntry: PolicyAuditEntry | null;
  } {
    const allowSet = new Set(rule.models);
    const newModels = currentModels.filter((m) => allowSet.has(m));

    if (newModels.length !== currentModels.length) {
      return {
        eligibleModels: newModels,
        forcedModel: null,
        auditEntry: {
          rule_type: 'AllowModelsGlobal',
          action: 'allow',
          models_affected: rule.models,
          timestamp: new Date().toISOString(),
        },
      };
    }

    return {
      eligibleModels: newModels,
      forcedModel: null,
      auditEntry: null,
    };
  }

  private applyDenyModelsGlobal(
    rule: PolicyRule,
    currentModels: string[]
  ): {
    eligibleModels: string[];
    forcedModel: string | null;
    auditEntry: PolicyAuditEntry | null;
  } {
    const denySet = new Set(rule.models);
    const removed = currentModels.filter((m) => denySet.has(m));
    const newModels = currentModels.filter((m) => !denySet.has(m));

    if (removed.length > 0) {
      return {
        eligibleModels: newModels,
        forcedModel: null,
        auditEntry: {
          rule_type: 'DenyModelsGlobal',
          action: 'deny',
          models_affected: removed,
          timestamp: new Date().toISOString(),
        },
      };
    }

    return {
      eligibleModels: newModels,
      forcedModel: null,
      auditEntry: null,
    };
  }
}

/**
 * Create a policy engine instance
 */
export function createPolicyEngine(): PolicyEngine {
  return new DefaultPolicyEngine();
}
