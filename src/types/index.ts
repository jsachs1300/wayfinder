/**
 * Core type definitions for Wayfinder
 */

// Intent Classification
export type IntentLabel =
  | 'code_review'
  | 'coding'
  | 'legal'
  | 'summarization'
  | 'reasoning'
  | 'creative'
  | 'support'
  | 'other';

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
}

export interface KnowledgeStoreStats {
  total_entries: number;
  entries_by_confidence: Record<ConfidenceLevel, number>;
  average_agreement_score: number;
  entries_by_scope?: Record<KnowledgeScope, number>; // Optional breakdown by scope
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
export interface ModelInfo {
  id: string;
  provider: string;
  capabilities: string[];
  cost_tier: 'low' | 'medium' | 'high';
  speed_tier: 'fast' | 'medium' | 'slow';
  context_window: number;
  available: boolean;
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
