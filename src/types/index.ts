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

// Router Model Preference
// Specifies which router LLM provider should provide the routing decision
// - openai: Use OpenAI's routing recommendation
// - gemini: Use Gemini's routing recommendation
// - consensus: Use aggregated consensus from all providers (default)
export const VALID_ROUTER_MODEL_PREFERENCES = [
  'openai',
  'gemini',
  'consensus',
] as const;

export type RouterModelPreference = (typeof VALID_ROUTER_MODEL_PREFERENCES)[number];

// Token Configuration
export type LoggingLevel = 'normal' | 'verbose';
export type Environment = 'prod' | 'dev';

export interface TokenConfig {
  id: string;
  token_hash: string;
  is_default?: boolean; // Internal marker for default user token behavior
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  eligible_models?: string[]; // Optional: Override system default (all models in registry)
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope; // Default: 'global'
  router_model_preference?: RouterModelPreference; // Default: 'consensus'
  created_at: string;
  updated_at: string;
  rotated_at?: string;
}

export interface TokenCreateRequest {
  is_default?: boolean; // Internal use only (set by backend for default user token)
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  eligible_models?: string[]; // Optional: Override system default (all models in registry)
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope;
  router_model_preference?: RouterModelPreference;
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
  eligible_models?: string[]; // Optional: Override system default (all models in registry)
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope;
  router_model_preference?: RouterModelPreference;
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
  router_model?: RouterModelPreference; // Override token's router_model_preference
}

/**
 * Canonical Router LLM Contract
 *
 * This is the REQUIRED output format for the router LLM.
 * All routing decisions MUST conform to this schema.
 *
 * Intent is advisory only - logged and stored for internal analysis but MUST NOT
 * influence routing logic, scoring, or model eligibility.
 *
 * No additional properties are allowed anywhere in this structure.
 */
export interface RouteDecision {
  /** Intent label (free text, advisory only, for internal analysis) */
  intent: string;
  /** Primary model recommendation */
  primary: ModelRecommendation;
  /** Alternate model recommendation */
  alternate: ModelRecommendation;
}

/**
 * Model recommendation with score and reasoning
 */
export interface ModelRecommendation {
  /** Model identifier */
  model: string;
  /** Confidence score (0-10 scale) */
  score: number;
  /** Explanation for this recommendation */
  reason: string;
}

/**
 * Enhanced routing result with policy metadata
 * Includes both the routing decision and policy enforcement details
 */
export interface RouteResult {
  /** The routing decision from the router LLM */
  decision: RouteDecision;
  /** Policy metadata for observability */
  policyMetadata: {
    /** Model forced by policy (if any) */
    forcedModel: string | null;
    /** Number of models eligible after policy evaluation */
    eligibleModelsCount: number;
  };
  /** Whether this decision came from cache (optional) */
  cache_hit?: boolean;
  /** Which router provider was actually used */
  router_model_used?: RouterModelPreference;
}

/**
 * User-facing routing response (projection of RouteDecision)
 * Intent is omitted from user-facing responses
 */
export interface RouteResponse {
  primary: ModelRecommendation;
  alternate: ModelRecommendation;
  request_id: string;
  router_model_used: RouterModelPreference; // Which router provider was used
  from_cache: boolean; // Whether response came from cache
}

/**
 * Ranked model recommendation
 * Used for full ranked routing where all eligible models are ranked
 */
export interface RankedModel {
  /** Rank position (1-based: 1 = best, 2 = second best, etc.) */
  rank: number;
  /** Model identifier */
  model: string;
  /** Confidence score (0-10 scale) */
  score: number;
  /** Explanation for this ranking (should not mention other model names) */
  reason: string;
}

/**
 * Router LLM decision with full ranked list of all eligible models
 * This is the internal representation used for caching and future multi-LLM aggregation
 */
export interface RankedRouteDecision {
  /** Intent label (free text, advisory only, for internal analysis) */
  intent: string;
  /** All eligible models ranked from best to worst */
  ranked_models: RankedModel[];
}

/**
 * Ranking result from a single router LLM provider
 * Used for caching per-provider results
 */
export interface ProviderRanking {
  /** Provider identifier */
  provider: 'openai' | 'gemini';
  /** Ranked route decision from this provider */
  decision: RankedRouteDecision;
  /** Timestamp when generated (ISO 8601 UTC) */
  generated_at: string;
}

/**
 * Cached response containing all provider rankings
 * Stored in SemanticCache, keyed by prompt
 *
 * @deprecated Use SimpleCachedResponse instead - stores entire multi-provider response (wasteful)
 */
export interface CachedRouterResponse {
  /** The prompt this response is for */
  prompt: string;
  /** Per-provider rankings (contains all enabled providers) */
  provider_rankings: {
    openai?: ProviderRanking;
    gemini?: ProviderRanking;
  };
  /** Aggregated consensus ranking from all providers */
  consensus: RankedRouteDecision;
  /** Timestamp when cached (ISO 8601 UTC) */
  cached_at: string;
  /** TTL in seconds */
  ttl: number;
}

/**
 * Simple cached response containing a single router ranking
 * Each router model (openai, gemini, consensus) is cached separately
 * This avoids storing redundant provider data in each cache entry
 */
export interface SimpleCachedResponse {
  /** The prompt this response is for */
  prompt: string;
  /** Single ranking from the specified router model */
  ranking: RankedRouteDecision;
  /** Which router model this ranking is from */
  router_model: RouterModelPreference;
  /** Timestamp when cached (ISO 8601 UTC) */
  cached_at: string;
  /** TTL in seconds */
  ttl: number;
}

/**
 * Legacy RoutingDecision type - DEPRECATED
 * Kept for backward compatibility with logging infrastructure
 * Will be removed in a future version
 */
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
  | 'system_default';

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
export type RegistrySource = 'system_base' | 'system_curated' | 'user_overlay' | 'inferred';
export type RegistryMode = 'augment' | 'override';
export type MetadataConfidenceLevel = 'unknown' | 'low' | 'medium' | 'high';

export interface ModelCostMetadata {
  input_per_1k?: number;
  output_per_1k?: number;
  currency?: string;
  source?: 'provider' | 'curated' | 'inferred' | 'user';
}

export interface ModelPerformanceMetadata {
  quality_tier?: 'low' | 'medium' | 'high';
  latency_tier?: 'fast' | 'medium' | 'slow';
  strengths?: string[];
  weaknesses?: string[];
}

export interface ModelCapabilitiesMetadata {
  tool_use?: boolean;
  vision?: boolean;
  audio?: boolean;
  json_mode?: boolean;
}

export interface ModelMetadataConfidence {
  cost?: MetadataConfidenceLevel;
  performance?: MetadataConfidenceLevel;
  capabilities?: MetadataConfidenceLevel;
}

export interface ModelInfo {
  id: string;
  provider: string;
  cost_tier: 'low' | 'medium' | 'high';
  speed_tier: 'fast' | 'medium' | 'slow';
  context_window: number;
  max_output_tokens?: number;
  available: boolean;
  status: ModelStatus; // Lifecycle state
  global_eligible: boolean; // Can participate in global knowledge
  description?: string; // Human-readable description
  display_name?: string;
  availability?: 'generally_available' | 'preview' | 'restricted' | 'unknown';
  capabilities?: string[]; // Legacy compatibility and lightweight prompt context
  cost?: ModelCostMetadata;
  performance?: ModelPerformanceMetadata;
  capability_flags?: ModelCapabilitiesMetadata;
  provider_metadata?: {
    raw?: Record<string, unknown>;
    model_family?: string;
    version?: string;
  };
  metadata_confidence?: ModelMetadataConfidence;
  source?: RegistrySource;
  user_id?: string;
  updated_at?: string;
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

/**
 * Structured log event for routing decisions
 * Per REQUIREMENTS.md §12: Must log routing decision, explanation, confidence,
 * inferred intent, applied policy, knowledge scope, and request ID
 */
export interface RoutingDecisionLogEvent extends Record<string, unknown> {
  event_type: 'routing_decision';
  timestamp: string;
  request_id: string;
  token_id: string;

  // Privacy-safe prompt metadata (never log full prompt)
  prompt_length: number;
  prompt_hash: string; // SHA256 hash for correlation

  // Routing decision (per REQUIREMENTS.md §12)
  primary_model: string;
  primary_score: number;
  primary_reason: string;
  alternate_model: string;
  alternate_score: number;
  alternate_reason: string;

  // Intent (inferred by router LLM, metadata only per REQUIREMENTS.md §2.3)
  intent: string;

  // Policy enforcement details
  policy_applied: boolean;
  forced_model: string | null;
  eligible_models_count: number;

  // Knowledge scope
  knowledge_scope: KnowledgeScope;

  // Additional context
  environment?: Environment;
}

/**
 * Structured log event for policy evaluation
 * Logs policy constraints applied before routing
 */
export interface PolicyEvaluationLogEvent extends Record<string, unknown> {
  event_type: 'policy_evaluation';
  timestamp: string;
  request_id: string;
  token_id: string;

  // Policy results
  eligible_models: string[];
  forced_model: string | null;
  rules_applied: number;

  // Warnings
  has_intent_based_rules: boolean;
  warned_about_intent_limitation: boolean;
}

/**
 * Structured log event for routing errors
 * Logs failures during routing with privacy-safe details
 */
export interface RoutingErrorLogEvent extends Record<string, unknown> {
  event_type: 'routing_error';
  timestamp: string;
  request_id: string;
  token_id: string;

  // Error details
  error_type: string;
  error_message: string;

  // Privacy-safe prompt metadata
  prompt_length: number;
  prompt_hash: string;

  // Context
  stage: 'validation' | 'policy_evaluation' | 'router_llm' | 'response_validation' | 'unknown';
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
      user?: import('../users/types').User;
      userTier?: import('../users/types').UserTier;
      session?: import('../sessions/types').UserSession;
      mcpTokenContextLookupFailed?: boolean;
      mcpTokenContextTokenInvalid?: boolean;
      mcpTokenContextUserInactive?: boolean;
    }
  }
}

/**
 * Get eligible models for a token
 * Returns token's eligible_models if specified, otherwise all models from registry
 */
export function getEligibleModels(
  tokenConfig: TokenConfig,
  allModels: string[]
): string[] {
  return tokenConfig.eligible_models ?? allModels;
}

/**
 * Get fallback model for a token
 * Returns first model in eligible_models list
 */
export function getFallbackModel(
  tokenConfig: TokenConfig,
  allModels: string[]
): string {
  const eligible = getEligibleModels(tokenConfig, allModels);

  if (eligible.length === 0) {
    throw new Error('No eligible models available for fallback');
  }

  return eligible[0]!;
}

export {};
