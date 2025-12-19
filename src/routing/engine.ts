import {
  TokenConfig,
  RouteRequest,
  RouteResponse,
  RoutingDecision,
  RoutingReason,
  IntentLabel,
  ConfidenceLevel,
  KnowledgeScopeContext,
  FallbackChainEntry,
  RoutingContextInternal,
  IntentClassification,
  PolicyEvaluationResult,
  KnowledgeEntry,
} from '../types';
import { IntentClassifier } from '../intent';
import { PolicyEngine } from '../policy';
import { KnowledgeStore } from '../knowledge';
import { ModelRegistry } from '../models';
import { v4 as uuidv4 } from 'uuid';

/**
 * Routing engine interface
 */
export interface RoutingEngine {
  route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string
  ): Promise<RouteResponse>;
}

/**
 * Routing engine dependencies
 */
export interface RoutingEngineDependencies {
  intentClassifier: IntentClassifier;
  policyEngine: PolicyEngine;
  knowledgeStore: KnowledgeStore;
  modelRegistry: ModelRegistry;
}

/**
 * Default routing engine implementation
 *
 * Routing flow:
 * 1. Classify intent
 * 2. Apply policy (may force a model)
 * 3. If policy forced -> return forced model
 * 4. Load knowledge for intent cluster
 * 5. If high confidence knowledge -> use consensus model
 * 6. If low confidence -> use trusted anchor
 * 7. Fallback -> use default model
 */
export class DefaultRoutingEngine implements RoutingEngine {
  private intentClassifier: IntentClassifier;
  private policyEngine: PolicyEngine;
  private knowledgeStore: KnowledgeStore;
  private modelRegistry: ModelRegistry;

  constructor(deps: RoutingEngineDependencies) {
    this.intentClassifier = deps.intentClassifier;
    this.policyEngine = deps.policyEngine;
    this.knowledgeStore = deps.knowledgeStore;
    this.modelRegistry = deps.modelRegistry;
  }

  async route(
    request: RouteRequest,
    tokenConfig: TokenConfig,
    requestId?: string
  ): Promise<RouteResponse> {
    const reqId = requestId ?? uuidv4();
    const timestamp = new Date().toISOString();
    const fallbackChain: FallbackChainEntry[] = [];

    // Step 1: Classify intent
    const intentClassification = this.intentClassifier.classify(request.prompt);
    const intent = intentClassification.label;

    // Step 2: Build scope context for knowledge operations
    // Default to global scope if not specified
    const knowledgeScope = tokenConfig.knowledge_scope ?? 'global';
    const scopeContext: KnowledgeScopeContext = {
      scope: knowledgeScope,
      token_id: knowledgeScope === 'token' ? tokenConfig.id : undefined,
      // org_id would be added here in the future for org scope
    };

    // Step 3: Get available models and apply policy
    const availableModels = this.modelRegistry
      .getAvailableModels()
      .map((m) => m.id);

    const policyResult = this.policyEngine.evaluate(
      intent,
      availableModels,
      tokenConfig
    );

    // Step 4: If policy forced a model, return it (bypasses knowledge)
    if (policyResult.forced_model) {
      fallbackChain.push({
        strategy: 'policy_forced',
        model: policyResult.forced_model,
        outcome: 'selected',
      });

      return this.createResponseWithInternal(
        policyResult.forced_model,
        {
          reason: 'policy_forced',
          confidence: 'strong',
          agreement_score: null,
          eligible_models: policyResult.eligible_models,
          timestamp,
          knowledge_used: false,
          policy_forced: true,
        },
        reqId,
        {
          intentClassification,
          knowledge: null,
          policyResult,
          fallbackChain,
          scopeContext,
        }
      );
    }

    // Step 5: Load knowledge for intent cluster (scope-aware)
    const intentCluster = intent; // Using intent label as cluster key for now
    const knowledge = await this.knowledgeStore.get(intentCluster, scopeContext);

    // Step 6: Check for high confidence knowledge consensus
    if (knowledge && knowledge.confidence_level !== 'low') {
      const consensusModel = await this.knowledgeStore.getConsensusModel(
        intentCluster,
        scopeContext
      );

      if (consensusModel && policyResult.eligible_models.includes(consensusModel)) {
        fallbackChain.push({
          strategy: 'consensus',
          model: consensusModel,
          outcome: 'selected',
        });

        return this.createResponseWithInternal(
          consensusModel,
          {
            reason: 'knowledge_consensus',
            confidence: knowledge.confidence_level,
            agreement_score: knowledge.agreement_score,
            eligible_models: policyResult.eligible_models,
            timestamp,
            knowledge_used: true,
            policy_forced: false,
          },
          reqId,
          {
            intentClassification,
            knowledge,
            policyResult,
            fallbackChain,
            scopeContext,
          }
        );
      }

      // Consensus model exists but not eligible
      if (consensusModel) {
        fallbackChain.push({
          strategy: 'consensus',
          model: consensusModel,
          outcome: 'ineligible',
          reason: 'not in eligible_models list',
        });
      }
    } else if (knowledge) {
      // Knowledge exists but low confidence
      const consensusModel = await this.knowledgeStore.getConsensusModel(
        intentCluster,
        scopeContext
      );
      if (consensusModel) {
        fallbackChain.push({
          strategy: 'consensus',
          model: consensusModel,
          outcome: 'insufficient_confidence',
        });
      }
    }

    // Step 7: Low confidence or no knowledge - use trusted anchor
    if (tokenConfig.trusted_anchor_model) {
      const anchor = tokenConfig.trusted_anchor_model;
      const isEligible = policyResult.eligible_models.includes(anchor);
      const isValid = this.modelRegistry.isValidModel(anchor);

      if (isEligible && isValid) {
        fallbackChain.push({
          strategy: 'trusted_anchor',
          model: anchor,
          outcome: 'selected',
        });

        return this.createResponseWithInternal(
          anchor,
          {
            reason: 'trusted_anchor_fallback',
            confidence: 'low',
            agreement_score: knowledge?.agreement_score ?? null,
            eligible_models: policyResult.eligible_models,
            timestamp,
            knowledge_used: false,
            policy_forced: false,
          },
          reqId,
          {
            intentClassification,
            knowledge,
            policyResult,
            fallbackChain,
            scopeContext,
          }
        );
      } else {
        fallbackChain.push({
          strategy: 'trusted_anchor',
          model: anchor,
          outcome: isValid ? 'ineligible' : 'ineligible',
          reason: isValid ? 'denied by policy' : 'model not in registry',
        });
      }
    }

    // Step 8: Use token's default model if specified
    if (tokenConfig.default_model) {
      const defaultModel = tokenConfig.default_model;
      const isEligible = policyResult.eligible_models.includes(defaultModel);
      const isValid = this.modelRegistry.isValidModel(defaultModel);

      if (isEligible && isValid) {
        fallbackChain.push({
          strategy: 'default',
          model: defaultModel,
          outcome: 'selected',
        });

        return this.createResponseWithInternal(
          defaultModel,
          {
            reason: 'default_model_fallback',
            confidence: 'low',
            agreement_score: knowledge?.agreement_score ?? null,
            eligible_models: policyResult.eligible_models,
            timestamp,
            knowledge_used: false,
            policy_forced: false,
          },
          reqId,
          {
            intentClassification,
            knowledge,
            policyResult,
            fallbackChain,
            scopeContext,
          }
        );
      } else {
        fallbackChain.push({
          strategy: 'default',
          model: defaultModel,
          outcome: isValid ? 'ineligible' : 'ineligible',
          reason: isValid ? 'denied by policy' : 'model not in registry',
        });
      }
    }

    // Step 9: Final fallback - system default
    const systemDefault = this.modelRegistry.getDefaultModel();
    const finalModel = policyResult.eligible_models.includes(systemDefault)
      ? systemDefault
      : policyResult.eligible_models[0] ?? systemDefault;

    fallbackChain.push({
      strategy: 'system_default',
      model: finalModel,
      outcome: 'selected',
    });

    return this.createResponseWithInternal(
      finalModel,
      {
        reason: 'system_default',
        confidence: 'low',
        agreement_score: knowledge?.agreement_score ?? null,
        eligible_models: policyResult.eligible_models,
        timestamp,
        knowledge_used: false,
        policy_forced: false,
      },
      reqId,
      {
        intentClassification,
        knowledge,
        policyResult,
        fallbackChain,
        scopeContext,
      }
    );
  }

  private createResponseWithInternal(
    selectedModel: string,
    decision: RoutingDecision,
    requestId: string,
    internal: {
      intentClassification: IntentClassification;
      knowledge: KnowledgeEntry | null;
      policyResult: PolicyEvaluationResult;
      fallbackChain: FallbackChainEntry[];
      scopeContext: KnowledgeScopeContext;
    }
  ): RouteResponse {
    return {
      selected_model: selectedModel,
      routing_decision: decision,
      request_id: requestId,
      _internal: {
        intent_classification: internal.intentClassification,
        knowledge_entry: internal.knowledge,
        policy_result: internal.policyResult,
        fallback_chain: internal.fallbackChain,
        scope_context: internal.scopeContext,
      },
    };
  }
}

/**
 * Create a routing engine with all dependencies
 */
export function createRoutingEngine(
  deps: RoutingEngineDependencies
): RoutingEngine {
  return new DefaultRoutingEngine(deps);
}
