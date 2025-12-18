import { FeedbackRequest, FeedbackResponse, IntentLabel } from '../types';
import { KnowledgeStore } from '../knowledge';
import { v4 as uuidv4 } from 'uuid';

/**
 * Feedback handler interface
 */
export interface FeedbackHandler {
  processFeedback(request: FeedbackRequest): Promise<FeedbackResponse>;
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

  async processFeedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    const feedbackId = uuidv4();
    let knowledgeUpdated = false;

    // Use intent label as the cluster key
    const intentCluster = request.intent_label;

    // Process based on rating
    if (request.rating === 'positive') {
      // Positive feedback reinforces the selected model
      await this.knowledgeStore.recordVote(intentCluster, request.selected_model);
      knowledgeUpdated = true;
    } else if (request.rating === 'negative' && request.preferred_model) {
      // Negative feedback with preferred model: vote for preferred instead
      await this.knowledgeStore.recordVote(intentCluster, request.preferred_model);
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
