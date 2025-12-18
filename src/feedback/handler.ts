import {
  FeedbackRequest,
  FeedbackResponse,
  IntentLabel,
  TokenConfig,
  KnowledgeScopeContext,
} from '../types';
import { KnowledgeStore } from '../knowledge';
import { v4 as uuidv4 } from 'uuid';

/**
 * Feedback handler interface
 */
export interface FeedbackHandler {
  processFeedback(
    request: FeedbackRequest,
    tokenConfig: TokenConfig
  ): Promise<FeedbackResponse>;
}

/**
 * Default feedback handler implementation
 *
 * Feedback plumbing exists early for future use:
 * - Records positive feedback as votes in knowledge store
 * - Tracks negative feedback for analysis
 * - Supports preferred_model suggestions
 */
export class DefaultFeedbackHandler implements FeedbackHandler {
  private knowledgeStore: KnowledgeStore;

  constructor(knowledgeStore: KnowledgeStore) {
    this.knowledgeStore = knowledgeStore;
  }

  async processFeedback(
    request: FeedbackRequest,
    tokenConfig: TokenConfig
  ): Promise<FeedbackResponse> {
    const feedbackId = uuidv4();
    let knowledgeUpdated = false;

    // Build scope context from token config
    const knowledgeScope = tokenConfig.knowledge_scope ?? 'global';
    const scopeContext: KnowledgeScopeContext = {
      scope: knowledgeScope,
      token_id: knowledgeScope === 'token' ? tokenConfig.id : undefined,
      // org_id would be added here in the future for org scope
    };

    // Use intent label as the cluster key
    const intentCluster = request.intent_label;

    // Process based on rating (scope-aware)
    if (request.rating === 'positive') {
      // Positive feedback reinforces the selected model
      await this.knowledgeStore.recordVote(
        intentCluster,
        request.selected_model,
        scopeContext
      );
      knowledgeUpdated = true;
    } else if (request.rating === 'negative' && request.preferred_model) {
      // Negative feedback with preferred model: vote for preferred instead
      await this.knowledgeStore.recordVote(
        intentCluster,
        request.preferred_model,
        scopeContext
      );
      knowledgeUpdated = true;
    }
    // Neutral feedback is acknowledged but doesn't update knowledge

    return {
      feedback_id: feedbackId,
      acknowledged: true,
      knowledge_updated: knowledgeUpdated,
    };
  }
}

/**
 * Create a feedback handler
 */
export function createFeedbackHandler(
  knowledgeStore: KnowledgeStore
): FeedbackHandler {
  return new DefaultFeedbackHandler(knowledgeStore);
}
