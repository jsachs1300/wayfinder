import {
  TokenConfig,
  RouteRequest,
  RouteResponse,
  RoutingDecision,
  RoutingReason,
  IntentLabel,
  ConfidenceLevel,
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

    // Step 1: Classify intent
    const intentClassification = this.intentClassifier.classify(request.prompt);
    const intent = intentClassification.label;

    // Step 2: Get available models and apply policy
    const availableModels = this.modelRegistry
      .getAvailableModels()
      .map((m) => m.id);

    const policyResult = this.policyEngine.evaluate(
      intent,
      availableModels,
      tokenConfig
    );

    // Step 3: If policy forced a model, return it
    if (policyResult.forced_model) {
      return this.createResponse(
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
        reqId
      );
    }

    // Step 4: Load knowledge for intent cluster
    const intentCluster = intent; // Using intent label as cluster key for now
    const knowledge = await this.knowledgeStore.get(intentCluster);

    // Step 5: Check for high confidence knowledge consensus
    if (knowledge && knowledge.confidence_level !== 'low') {
      const consensusModel = await this.knowledgeStore.getConsensusModel(
        intentCluster
      );

      if (consensusModel && policyResult.eligible_models.includes(consensusModel)) {
        return this.createResponse(
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
          reqId
        );
      }
    }

    // Step 6: Low confidence or no knowledge - use trusted anchor
    if (tokenConfig.trusted_anchor_model) {
      const anchor = tokenConfig.trusted_anchor_model;
      if (
        policyResult.eligible_models.includes(anchor) &&
        this.modelRegistry.isValidModel(anchor)
      ) {
        return this.createResponse(
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
          reqId
        );
      }
    }

    // Step 7: Use token's default model if specified
    if (tokenConfig.default_model) {
      const defaultModel = tokenConfig.default_model;
      if (
        policyResult.eligible_models.includes(defaultModel) &&
        this.modelRegistry.isValidModel(defaultModel)
      ) {
        return this.createResponse(
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
          reqId
        );
      }
    }

    // Step 8: Final fallback - system default
    const systemDefault = this.modelRegistry.getDefaultModel();
    const finalModel = policyResult.eligible_models.includes(systemDefault)
      ? systemDefault
      : policyResult.eligible_models[0] ?? systemDefault;

    return this.createResponse(
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
      reqId
    );
  }

  private createResponse(
    selectedModel: string,
    decision: RoutingDecision,
    requestId: string
  ): RouteResponse {
    return {
      selected_model: selectedModel,
      routing_decision: decision,
      request_id: requestId,
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
