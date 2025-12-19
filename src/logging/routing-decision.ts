import {
  RoutingDecisionLog,
  RouteResponse,
  TokenConfig,
  RoutingReason,
} from '../types';

/**
 * Create a routing decision log from routing response and token config
 */
export function createRoutingDecisionLog(
  response: RouteResponse,
  tokenConfig: TokenConfig
): RoutingDecisionLog {
  const internal = response._internal;
  if (!internal) {
    throw new Error('Cannot create routing decision log: _internal context missing');
  }

  const knowledge = internal.knowledge_entry;
  const policyRulesApplied = internal.policy_result.audit_trail.map(
    (entry) => `${entry.rule_type}:${entry.intent ?? 'global'}`
  );

  // Determine consensus model from knowledge entry
  let consensusModel: string | null = null;
  if (knowledge && knowledge.model_votes) {
    const votes = Object.entries(knowledge.model_votes);
    if (votes.length > 0) {
      // Find model with most votes
      const sorted = votes.sort((a, b) => b[1] - a[1]);
      consensusModel = sorted[0][0];
    }
  }

  return {
    // Identity & Context
    timestamp: new Date().toISOString(),
    level: determineLogLevel(
      response.routing_decision.reason,
      response.routing_decision.policy_forced
    ),
    message: 'Routing decision completed',
    request_id: response.request_id,
    token_id: tokenConfig.id,
    environment: tokenConfig.environment ?? null,

    // Intent
    intent_label: internal.intent_classification.label,
    intent_confidence: internal.intent_classification.confidence,
    intent_source: 'classifier',

    // Knowledge Scope
    knowledge_scope: internal.scope_context.scope,
    knowledge_key: knowledge?.intent_cluster ?? null,
    knowledge_last_updated: knowledge?.last_updated ?? null,

    // Policy
    policy_applied: internal.policy_result.audit_trail.length > 0,
    policy_forced_model: internal.policy_result.forced_model,
    policy_rules_applied: policyRulesApplied,

    // Model Eligibility
    eligible_models: response.routing_decision.eligible_models,
    denied_models: tokenConfig.denied_models ?? [],
    default_model: tokenConfig.default_model ?? null,

    // Knowledge & Confidence
    agreement_score: knowledge?.agreement_score ?? null,
    confidence_level: knowledge?.confidence_level ?? null,
    confidence_threshold: tokenConfig.confidence_threshold ?? 0.7,
    consensus_model: consensusModel,

    // Decision
    selected_model: response.selected_model,
    decision_reason: response.routing_decision.reason,

    // Fallbacks
    trusted_anchor_model: tokenConfig.trusted_anchor_model ?? null,
    fallback_chain: internal.fallback_chain,
  };
}

/**
 * Determine log level based on routing reason
 */
function determineLogLevel(
  reason: RoutingReason,
  policyForced: boolean
): 'info' | 'warn' {
  if (reason === 'system_default') return 'warn';
  if (reason === 'trusted_anchor_fallback' || reason === 'default_model_fallback')
    return 'warn';
  return 'info';
}

/**
 * Validate routing decision log for behavioral guarantees
 */
export function validateRoutingDecisionLog(log: RoutingDecisionLog): void {
  // Only validate in development
  if (process.env.NODE_ENV === 'production') return;

  // Rule 1: policy_forced → policy_forced_model === selected_model
  if (log.decision_reason === 'policy_forced') {
    if (log.policy_forced_model !== log.selected_model) {
      throw new Error(
        `Invariant violation: policy_forced but policy_forced_model (${log.policy_forced_model}) !== selected_model (${log.selected_model})`
      );
    }
  }

  // Rule 2: fallback_chain must have exactly one "selected" outcome
  const selectedEntries = log.fallback_chain.filter((e) => e.outcome === 'selected');
  if (selectedEntries.length !== 1) {
    throw new Error(
      `Invariant violation: fallback_chain must have exactly one "selected" entry, found ${selectedEntries.length}`
    );
  }

  // Rule 3: selected_model must match the "selected" fallback entry
  const selectedEntry = selectedEntries[0];
  if (selectedEntry.model !== log.selected_model) {
    throw new Error(
      `Invariant violation: selected_model (${log.selected_model}) !== fallback_chain selected entry model (${selectedEntry.model})`
    );
  }

  // Rule 4: knowledge_consensus → knowledge fields must be populated
  if (log.decision_reason === 'knowledge_consensus') {
    if (log.agreement_score === null || log.confidence_level === null) {
      throw new Error(
        `Invariant violation: decision_reason=knowledge_consensus but knowledge fields are null`
      );
    }
  }
}

/**
 * Emit routing decision log
 */
export function emitRoutingDecisionLog(log: RoutingDecisionLog): void {
  validateRoutingDecisionLog(log);

  const output = JSON.stringify(log);

  if (log.level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}
