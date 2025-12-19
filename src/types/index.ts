/**
 * Core type definitions for Wayfinder
 */

// Intent Classification
export type CanonicalIntentLabel =
  | 'code_change'
  | 'debugging'
  | 'architecture_design'
  | 'explanation'
  | 'summarization'
  | 'data_analysis'
  | 'content_generation'
  | 'planning';

export type IntentLabel = CanonicalIntentLabel | `other:${string}`;

export interface IntentClassification {
  label: IntentLabel;
  confidence: number;
  raw_scores?: Record<IntentLabel, number>;
}

// Policy Rules
export type PolicyRuleType =
  | 'ForceModelByIntent'
  | 'RestrictModelsByIntent'
  | 'AllowModelsGlobal'
  | 'DenyModelsGlobal';

export interface PolicyRule {
  type: PolicyRuleType;
  intent?: IntentLabel;
  models: string[];
  priority?: number;
}

export interface PolicyEvaluationResult {
  eligible_models: string[];
  forced_model: string | null;
  audit_trail: PolicyAuditEntry[];
}

export interface PolicyAuditEntry {
  rule_type: PolicyRuleType;
  action: 'allow' | 'deny' | 'restrict' | 'force';
  models_affected: string[];
  intent?: IntentLabel;
  timestamp: string;
}

// Knowledge Scope
// Global: shared learning across all tokens (default)
// Token: isolated knowledge per token (enterprise use case)
// Org: shared knowledge within organization (future - not yet implemented)
// Hybrid: combination of global + scoped knowledge (future - not yet implemented)
export type KnowledgeScope = 'global' | 'token' | 'org' | 'hybrid';

// Token Configuration
export type LoggingLevel = 'normal' | 'verbose';
export type Environment = 'prod' | 'dev';

export interface TokenConfig {
  id: string;
  token_hash: string;
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  default_model?: string;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope; // Default: 'global'
  created_at: string;
  updated_at: string;
  rotated_at?: string;
}

export interface TokenCreateRequest {
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  default_model?: string;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope;
}

export interface TokenCreateResponse {
  id: string;
  token: string;
  config: Omit<TokenConfig, 'token_hash'>;
}

export interface TokenUpdateRequest {
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  default_model?: string;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope;
}

// Knowledge Store
export type ConfidenceLevel = 'strong' | 'moderate' | 'low';

export interface KnowledgeEntry {
  intent_cluster: string;
  model_votes: Record<string, number>;
  agreement_score: number;
  confidence_level: ConfidenceLevel;
  total_votes: number;
  last_updated: string;
  decay_factor: number;
  rawScore: number;
  lastUpdatedMs: number;
}

export interface KnowledgeStoreStats {
  total_entries: number;
  total_raw_score: number;
  approximate_effective_score: number;
  entries_by_confidence: Record<ConfidenceLevel, number>;
  average_agreement_score: number;
  entries_by_scope?: Record<KnowledgeScope, number>; // Optional breakdown by scope
  last_updated_ms: number | null;
}

// Scope context for knowledge operations
export interface KnowledgeScopeContext {
  scope: KnowledgeScope;
  token_id?: string; // Required for 'token' scope
  org_id?: string; // Required for 'org' scope (future)
}

// Routing
export interface RouteRequest {
  prompt: string;
  context?: Record<string, unknown>;
  prefer_model?: string;
  metadata?: Record<string, unknown>;
}

export interface RoutingDecision {
  reason: RoutingReason;
  confidence: ConfidenceLevel;
  agreement_score: number | null;
  eligible_models: string[];
  timestamp: string;
  knowledge_used: boolean;
  policy_forced: boolean;
}

export type RoutingReason =
  | 'policy_forced'
  | 'knowledge_consensus'
  | 'trusted_anchor_fallback'
  | 'default_model_fallback'
  | 'system_default';

export interface RouteResponse {
  selected_model: string;
  routing_decision: RoutingDecision;
  request_id: string;
  _internal?: RoutingContextInternal; // Internal context for logging (stripped before HTTP response)
}

// Routing inference (LLM-driven router)
export interface RouterModelSelection {
  model: string;
  reason: string;
}

export interface RoutingInferenceResult {
  primary: RouterModelSelection;
  alternate: RouterModelSelection;
  confidence: number; // 0-10 inclusive
  intent: string;
}

export interface RoutingInferenceRecord extends RoutingInferenceResult {
  intent_version: number;
  timestamp: string;
}

// Fallback Chain Entry for routing decision logging
export interface FallbackChainEntry {
  strategy: 'policy_forced' | 'consensus' | 'trusted_anchor' | 'default' | 'system_default';
  model: string | null;
  outcome: 'selected' | 'skipped' | 'ineligible' | 'insufficient_confidence';
  reason?: string;
}

// Internal routing context (not exposed in API response)
export interface RoutingContextInternal {
  intent_classification: IntentClassification;
  knowledge_entry: KnowledgeEntry | null;
  policy_result: PolicyEvaluationResult;
  fallback_chain: FallbackChainEntry[];
  scope_context: KnowledgeScopeContext;
}

// Routing Decision Log Schema
export interface RoutingDecisionLog {
  // Identity & Context
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  request_id: string;
  token_id: string;
  environment: Environment | null;

  // Intent
  intent_label: IntentLabel;
  intent_confidence: number;
  intent_source: 'classifier' | 'override' | 'unknown';

  // Knowledge Scope
  knowledge_scope: KnowledgeScope;
  knowledge_key: string | null;
  knowledge_last_updated: string | null;

  // Policy
  policy_applied: boolean;
  policy_forced_model: string | null;
  policy_rules_applied: string[];

  // Model Eligibility
  eligible_models: string[];
  denied_models: string[];
  default_model: string | null;

  // Knowledge & Confidence
  agreement_score: number | null;
  confidence_level: ConfidenceLevel | null;
  confidence_threshold: number;
  consensus_model: string | null;

  // Decision
  selected_model: string;
  decision_reason: RoutingReason;

  // Fallbacks
  trusted_anchor_model: string | null;
  fallback_chain: FallbackChainEntry[];
}

// Feedback
export interface FeedbackRequest {
  request_id: string;
  selected_model: string;
  intent_label: IntentLabel;
  rating?: 'positive' | 'negative' | 'neutral';
  preferred_model?: string;
  metadata?: Record<string, unknown>;
}

export interface FeedbackResponse {
  feedback_id: string;
  acknowledged: boolean;
  knowledge_updated: boolean;
}

// Opinion Polling (Stub)
export interface OpinionPollRequest {
  prompt: string;
  intent: IntentLabel;
  models: string[];
}

export interface OpinionPollResult {
  poll_id: string;
  votes: Record<string, number>;
  consensus_model: string | null;
  completed: boolean;
}

// Model Registry
export type ModelStatus = 'active' | 'deprecated' | 'disabled';

export interface ModelInfo {
  id: string;
  provider: string;
  capabilities: string[];
  cost_tier: 'low' | 'medium' | 'high';
  speed_tier: 'fast' | 'medium' | 'slow';
  context_window: number;
  available: boolean;
  status: ModelStatus; // Lifecycle state
  global_eligible: boolean; // Can participate in global knowledge
  description?: string; // Human-readable description
}

// Logging
export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  token_id?: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
}

// API Errors
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

// Express Extensions
declare global {
  namespace Express {
    interface Request {
      tokenConfig?: TokenConfig;
      requestId?: string;
    }
  }
}

export {};
