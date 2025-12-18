import { KnowledgeEntry, ConfidenceLevel, KnowledgeStoreStats } from '../types';
import Redis from 'ioredis';

const KNOWLEDGE_PREFIX = 'wayfinder:knowledge:';
const MIN_VOTES_FOR_STRONG = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);
const DECAY_RATE = parseFloat(process.env.KNOWLEDGE_DECAY_RATE ?? '0.05');

/**
 * Knowledge store interface
 */
export interface KnowledgeStore {
  get(intentCluster: string): Promise<KnowledgeEntry | null>;
  recordVote(intentCluster: string, model: string): Promise<KnowledgeEntry>;
  applyDecay(): Promise<number>;
  getStats(): Promise<KnowledgeStoreStats>;
  getConsensusModel(intentCluster: string): Promise<string | null>;
  clear(): Promise<void>;
}

/**
 * Calculate agreement score: max_votes / total_votes
 */
function calculateAgreementScore(modelVotes: Record<string, number>): number {
  const votes = Object.values(modelVotes);
  if (votes.length === 0) return 0;

  const maxVotes = Math.max(...votes);
  const totalVotes = votes.reduce((sum, v) => sum + v, 0);

  if (totalVotes === 0) return 0;
  return maxVotes / totalVotes;
}

/**
 * Calculate confidence level based on agreement score and vote count
 */
function calculateConfidenceLevel(
  agreementScore: number,
  totalVotes: number
): ConfidenceLevel {
  // Strong: agreement >= 0.8 AND enough votes
  if (agreementScore >= 0.8 && totalVotes >= MIN_VOTES_FOR_STRONG) {
    return 'strong';
  }
  // Moderate: agreement >= 0.6
  if (agreementScore >= 0.6) {
    return 'moderate';
  }
  // Low: otherwise
  return 'low';
}

/**
 * Apply decay to vote counts without deleting entries
 */
function applyDecayToEntry(entry: KnowledgeEntry, decayRate: number): KnowledgeEntry {
  const newModelVotes: Record<string, number> = {};
  let totalVotes = 0;

  for (const [model, votes] of Object.entries(entry.model_votes)) {
    // Apply exponential decay
    const decayedVotes = votes * (1 - decayRate);
    // Keep votes even if very small (never delete)
    newModelVotes[model] = Math.max(decayedVotes, 0.001);
    totalVotes += newModelVotes[model];
  }

  const agreementScore = calculateAgreementScore(newModelVotes);
  const confidenceLevel = calculateConfidenceLevel(agreementScore, totalVotes);
  const newDecayFactor = entry.decay_factor * (1 - decayRate);

  return {
    ...entry,
    model_votes: newModelVotes,
    agreement_score: agreementScore,
    confidence_level: confidenceLevel,
    total_votes: totalVotes,
    decay_factor: Math.max(newDecayFactor, 0.01), // Never decay to zero
  };
}

/**
 * In-memory knowledge store for development and fallback
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private entries: Map<string, KnowledgeEntry> = new Map();

  async get(intentCluster: string): Promise<KnowledgeEntry | null> {
    return this.entries.get(intentCluster) ?? null;
  }

  async recordVote(intentCluster: string, model: string): Promise<KnowledgeEntry> {
    const existing = this.entries.get(intentCluster);
    const now = new Date().toISOString();

    if (!existing) {
      // Create new entry
      const entry: KnowledgeEntry = {
        intent_cluster: intentCluster,
        model_votes: { [model]: 1 },
        agreement_score: 1,
        confidence_level: 'low', // New entries start with low confidence
        total_votes: 1,
        last_updated: now,
        decay_factor: 1,
      };
      this.entries.set(intentCluster, entry);
      return entry;
    }

    // Update existing entry
    const newVotes = { ...existing.model_votes };
    newVotes[model] = (newVotes[model] ?? 0) + 1;
    const totalVotes = Object.values(newVotes).reduce((sum, v) => sum + v, 0);
    const agreementScore = calculateAgreementScore(newVotes);
    const confidenceLevel = calculateConfidenceLevel(agreementScore, totalVotes);

    const updated: KnowledgeEntry = {
      ...existing,
      model_votes: newVotes,
      agreement_score: agreementScore,
      confidence_level: confidenceLevel,
      total_votes: totalVotes,
      last_updated: now,
    };

    this.entries.set(intentCluster, updated);
    return updated;
  }

  async applyDecay(): Promise<number> {
    let decayedCount = 0;

    for (const [key, entry] of this.entries) {
      const decayed = applyDecayToEntry(entry, DECAY_RATE);
      this.entries.set(key, decayed);
      decayedCount++;
    }

    return decayedCount;
  }

  async getStats(): Promise<KnowledgeStoreStats> {
    const entries = Array.from(this.entries.values());
    const entriesByConfidence: Record<ConfidenceLevel, number> = {
      strong: 0,
      moderate: 0,
      low: 0,
    };

    let totalAgreement = 0;

    for (const entry of entries) {
      entriesByConfidence[entry.confidence_level]++;
      totalAgreement += entry.agreement_score;
    }

    return {
      total_entries: entries.length,
      entries_by_confidence: entriesByConfidence,
      average_agreement_score: entries.length > 0 ? totalAgreement / entries.length : 0,
    };
  }

  async getConsensusModel(intentCluster: string): Promise<string | null> {
    const entry = await this.get(intentCluster);
    if (!entry || entry.confidence_level === 'low') {
      return null;
    }

    // Find the model with the most votes
    let maxVotes = 0;
    let consensusModel: string | null = null;

    for (const [model, votes] of Object.entries(entry.model_votes)) {
      if (votes > maxVotes) {
        maxVotes = votes;
        consensusModel = model;
      }
    }

    return consensusModel;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/**
 * Redis-backed knowledge store for production
 */
export class RedisKnowledgeStore implements KnowledgeStore {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get(intentCluster: string): Promise<KnowledgeEntry | null> {
    const data = await this.redis.get(KNOWLEDGE_PREFIX + intentCluster);
    if (!data) return null;
    return JSON.parse(data) as KnowledgeEntry;
  }

  async recordVote(intentCluster: string, model: string): Promise<KnowledgeEntry> {
    const existing = await this.get(intentCluster);
    const now = new Date().toISOString();

    if (!existing) {
      const entry: KnowledgeEntry = {
        intent_cluster: intentCluster,
        model_votes: { [model]: 1 },
        agreement_score: 1,
        confidence_level: 'low',
        total_votes: 1,
        last_updated: now,
        decay_factor: 1,
      };
      await this.redis.set(KNOWLEDGE_PREFIX + intentCluster, JSON.stringify(entry));
      return entry;
    }

    const newVotes = { ...existing.model_votes };
    newVotes[model] = (newVotes[model] ?? 0) + 1;
    const totalVotes = Object.values(newVotes).reduce((sum, v) => sum + v, 0);
    const agreementScore = calculateAgreementScore(newVotes);
    const confidenceLevel = calculateConfidenceLevel(agreementScore, totalVotes);

    const updated: KnowledgeEntry = {
      ...existing,
      model_votes: newVotes,
      agreement_score: agreementScore,
      confidence_level: confidenceLevel,
      total_votes: totalVotes,
      last_updated: now,
    };

    await this.redis.set(KNOWLEDGE_PREFIX + intentCluster, JSON.stringify(updated));
    return updated;
  }

  async applyDecay(): Promise<number> {
    const keys = await this.redis.keys(KNOWLEDGE_PREFIX + '*');
    let decayedCount = 0;

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const entry = JSON.parse(data) as KnowledgeEntry;
        const decayed = applyDecayToEntry(entry, DECAY_RATE);
        await this.redis.set(key, JSON.stringify(decayed));
        decayedCount++;
      }
    }

    return decayedCount;
  }

  async getStats(): Promise<KnowledgeStoreStats> {
    const keys = await this.redis.keys(KNOWLEDGE_PREFIX + '*');
    const entriesByConfidence: Record<ConfidenceLevel, number> = {
      strong: 0,
      moderate: 0,
      low: 0,
    };

    let totalAgreement = 0;
    let entryCount = 0;

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const entry = JSON.parse(data) as KnowledgeEntry;
        entriesByConfidence[entry.confidence_level]++;
        totalAgreement += entry.agreement_score;
        entryCount++;
      }
    }

    return {
      total_entries: entryCount,
      entries_by_confidence: entriesByConfidence,
      average_agreement_score: entryCount > 0 ? totalAgreement / entryCount : 0,
    };
  }

  async getConsensusModel(intentCluster: string): Promise<string | null> {
    const entry = await this.get(intentCluster);
    if (!entry || entry.confidence_level === 'low') {
      return null;
    }

    let maxVotes = 0;
    let consensusModel: string | null = null;

    for (const [model, votes] of Object.entries(entry.model_votes)) {
      if (votes > maxVotes) {
        maxVotes = votes;
        consensusModel = model;
      }
    }

    return consensusModel;
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(KNOWLEDGE_PREFIX + '*');
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

/**
 * Create appropriate knowledge store based on environment
 */
export function createKnowledgeStore(redis?: Redis): KnowledgeStore {
  if (redis) {
    return new RedisKnowledgeStore(redis);
  }
  return new InMemoryKnowledgeStore();
}
