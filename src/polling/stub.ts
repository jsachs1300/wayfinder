import {
  OpinionPollRequest,
  OpinionPollResult,
  IntentLabel,
  KnowledgeScopeContext,
} from '../types';
import { KnowledgeStore } from '../knowledge';
import { v4 as uuidv4 } from 'uuid';

/**
 * Opinion polling interface
 */
export interface OpinionPoller {
  startPoll(
    request: OpinionPollRequest,
    scopeContext?: KnowledgeScopeContext
  ): Promise<string>;
  getPollResult(pollId: string): Promise<OpinionPollResult | null>;
  isComplete(pollId: string): Promise<boolean>;
}

/**
 * Stub opinion poller for development
 *
 * This is a non-blocking, async stub that:
 * - Generates deterministic or seeded fake votes
 * - Updates knowledge store when poll completes
 * - Does NOT make real LLM calls
 * - Supports scoped knowledge via scopeContext parameter
 */
export class StubOpinionPoller implements OpinionPoller {
  private polls: Map<
    string,
    { result: OpinionPollResult; scopeContext?: KnowledgeScopeContext }
  > = new Map();
  private knowledgeStore: KnowledgeStore;
  private seed: number;

  constructor(knowledgeStore: KnowledgeStore, seed?: number) {
    this.knowledgeStore = knowledgeStore;
    this.seed = seed ?? Date.now();
  }

  async startPoll(
    request: OpinionPollRequest,
    scopeContext?: KnowledgeScopeContext
  ): Promise<string> {
    const pollId = uuidv4();

    // Initialize poll with empty votes
    const result: OpinionPollResult = {
      poll_id: pollId,
      votes: {},
      consensus_model: null,
      completed: false,
    };

    for (const model of request.models) {
      result.votes[model] = 0;
    }

    // Store poll result with scope context
    this.polls.set(pollId, {
      result,
      scopeContext: scopeContext ?? { scope: 'global' }, // Default to global
    });

    // Simulate async polling (complete after a short delay)
    this.simulatePollCompletion(pollId, request);

    return pollId;
  }

  async getPollResult(pollId: string): Promise<OpinionPollResult | null> {
    const entry = this.polls.get(pollId);
    return entry?.result ?? null;
  }

  async isComplete(pollId: string): Promise<boolean> {
    const entry = this.polls.get(pollId);
    return entry?.result.completed ?? false;
  }

  /**
   * Simulate poll completion with deterministic fake votes
   * Writes to knowledge store using the provided scope context
   */
  private simulatePollCompletion(
    pollId: string,
    request: OpinionPollRequest
  ): void {
    // Use setImmediate for non-blocking async behavior
    setImmediate(async () => {
      const entry = this.polls.get(pollId);
      if (!entry) return;

      const { result, scopeContext } = entry;

      // Generate deterministic votes based on seed and intent
      const votes: Record<string, number> = {};
      let maxVotes = 0;
      let consensusModel: string | null = null;

      for (let i = 0; i < request.models.length; i++) {
        const model = request.models[i]!;
        // Deterministic pseudo-random votes based on seed, intent, and model
        const hash = this.hashString(`${this.seed}:${request.intent}:${model}`);
        const vote = (hash % 5) + 1; // 1-5 votes per model

        votes[model] = vote;

        if (vote > maxVotes) {
          maxVotes = vote;
          consensusModel = model;
        }
      }

      // Update poll result
      result.votes = votes;
      result.consensus_model = consensusModel;
      result.completed = true;

      this.polls.set(pollId, { result, scopeContext });

      // Update knowledge store with consensus vote (scope-aware)
      if (consensusModel && scopeContext) {
        await this.knowledgeStore.recordVote(
          request.intent,
          consensusModel,
          scopeContext
        );
      }
    });
  }

  /**
   * Simple string hash for deterministic votes
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Clear all polls (for testing)
   */
  async clear(): Promise<void> {
    this.polls.clear();
  }
}

/**
 * Create an opinion poller
 */
export function createOpinionPoller(
  knowledgeStore: KnowledgeStore,
  seed?: number
): OpinionPoller {
  return new StubOpinionPoller(knowledgeStore, seed);
}
