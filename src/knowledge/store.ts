import {
  KnowledgeEntry,
  ConfidenceLevel,
  KnowledgeStoreStats,
  KnowledgeScopeContext,
  KnowledgeScope,
} from '../types';
import Redis from 'ioredis';
import { createLogger } from '../logging';

const KNOWLEDGE_PREFIX = 'wayfinder:knowledge:';
const MIN_VOTES_FOR_STRONG = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);
const DECAY_RATE = parseFloat(process.env.KNOWLEDGE_DECAY_RATE ?? '0.05');

const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Knowledge store interface - scope-aware
 */
export interface KnowledgeStore {
  get(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry | null>;
  recordVote(
    intentCluster: string,
    model: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<KnowledgeEntry>;
  applyDecay(scopeContext?: KnowledgeScopeContext): Promise<number>;
  getStats(scopeContext?: KnowledgeScopeContext): Promise<KnowledgeStoreStats>;
  getConsensusModel(
    intentCluster: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<string | null>;
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
 * Build scoped key for knowledge storage
 * Examples:
 *   global: wayfinder:knowledge:global:coding
 *   token: wayfinder:knowledge:token:token_abc123:coding
 *   org: wayfinder:knowledge:org:org_xyz789:coding (future)
 *   hybrid: not stored directly, composed at read time (future)
 */
function buildScopedKey(intentCluster: string, scopeContext: KnowledgeScopeContext): string {
  validateScopeContext(scopeContext);

  switch (scopeContext.scope) {
    case 'global':
      return `${KNOWLEDGE_PREFIX}global:${intentCluster}`;
    case 'token':
      if (!scopeContext.token_id) {
        throw new Error('token_id is required for token scope');
      }
      return `${KNOWLEDGE_PREFIX}token:${scopeContext.token_id}:${intentCluster}`;
    case 'org':
      // Future: org-level scoped knowledge
      throw new Error('Org-scoped knowledge is not yet implemented');
    case 'hybrid':
      // Future: hybrid scope will merge global + scoped at read time
      throw new Error('Hybrid knowledge scope is not yet implemented');
    default:
      throw new Error(`Unknown knowledge scope: ${scopeContext.scope}`);
  }
}

/**
 * Validate scope context has required fields
 */
function validateScopeContext(scopeContext: KnowledgeScopeContext): void {
  if (!scopeContext.scope) {
    throw new Error('Scope is required in KnowledgeScopeContext');
  }

  if (scopeContext.scope === 'token' && !scopeContext.token_id) {
    throw new Error('token_id is required for token scope');
  }

  if (scopeContext.scope === 'org' && !scopeContext.org_id) {
    throw new Error('org_id is required for org scope (not yet implemented)');
  }
}

/**
 * Build key pattern for scope-aware queries
 * Used for applyDecay and getStats when filtering by scope
 */
function buildScopePattern(scopeContext?: KnowledgeScopeContext): string {
  if (!scopeContext) {
    // No scope context = all scopes
    return `${KNOWLEDGE_PREFIX}*`;
  }

  validateScopeContext(scopeContext);

  switch (scopeContext.scope) {
    case 'global':
      return `${KNOWLEDGE_PREFIX}global:*`;
    case 'token':
      if (!scopeContext.token_id) {
        throw new Error('token_id is required for token scope');
      }
      return `${KNOWLEDGE_PREFIX}token:${scopeContext.token_id}:*`;
    case 'org':
      throw new Error('Org-scoped knowledge is not yet implemented');
    case 'hybrid':
      throw new Error('Hybrid knowledge scope is not yet implemented');
    default:
      throw new Error(`Unknown knowledge scope: ${scopeContext.scope}`);
  }
}

/**
 * In-memory knowledge store for development and fallback
 * Scope-aware: keys are now scoped (e.g., "global:coding" or "token:token_abc:coding")
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private entries: Map<string, KnowledgeEntry> = new Map();

  async get(
    intentCluster: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<KnowledgeEntry | null> {
    const key = buildScopedKey(intentCluster, scopeContext);
    this.logScopeAccess('get', scopeContext, intentCluster);
    return this.entries.get(key) ?? null;
  }

  async recordVote(
    intentCluster: string,
    model: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<KnowledgeEntry> {
    const key = buildScopedKey(intentCluster, scopeContext);
    this.logScopeAccess('recordVote', scopeContext, intentCluster);

    const existing = this.entries.get(key);
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
      this.entries.set(key, entry);
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

    this.entries.set(key, updated);
    return updated;
  }

  async applyDecay(scopeContext?: KnowledgeScopeContext): Promise<number> {
    let decayedCount = 0;
    const pattern = scopeContext ? buildScopePattern(scopeContext) : null;

    for (const [key, entry] of this.entries) {
      // If scope context provided, only decay matching keys
      if (pattern && !this.matchesPattern(key, pattern)) {
        continue;
      }

      const decayed = applyDecayToEntry(entry, DECAY_RATE);
      this.entries.set(key, decayed);
      decayedCount++;
    }

    return decayedCount;
  }

  async getStats(scopeContext?: KnowledgeScopeContext): Promise<KnowledgeStoreStats> {
    const pattern = scopeContext ? buildScopePattern(scopeContext) : null;
    const entriesByConfidence: Record<ConfidenceLevel, number> = {
      strong: 0,
      moderate: 0,
      low: 0,
    };
    const entriesByScope: Record<KnowledgeScope, number> = {
      global: 0,
      token: 0,
      org: 0,
      hybrid: 0,
    };

    let totalAgreement = 0;
    let entryCount = 0;

    for (const [key, entry] of this.entries) {
      // If scope context provided, only include matching keys
      if (pattern && !this.matchesPattern(key, pattern)) {
        continue;
      }

      entriesByConfidence[entry.confidence_level]++;
      totalAgreement += entry.agreement_score;
      entryCount++;

      // Track scope distribution
      const scope = this.extractScopeFromKey(key);
      if (scope) {
        entriesByScope[scope]++;
      }
    }

    return {
      total_entries: entryCount,
      entries_by_confidence: entriesByConfidence,
      average_agreement_score: entryCount > 0 ? totalAgreement / entryCount : 0,
      entries_by_scope: entriesByScope,
    };
  }

  async getConsensusModel(
    intentCluster: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<string | null> {
    const entry = await this.get(intentCluster, scopeContext);
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

  /**
   * Simple pattern matching for in-memory keys
   * Converts Redis-style pattern to regex
   */
  private matchesPattern(key: string, pattern: string): boolean {
    // Convert glob pattern to regex (simple version for * wildcard)
    const regexPattern = pattern.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(key);
  }

  /**
   * Extract scope type from key for stats tracking
   */
  private extractScopeFromKey(key: string): KnowledgeScope | null {
    // Key format: wayfinder:knowledge:{scope}:...
    const parts = key.split(':');
    if (parts.length >= 3) {
      const scopePart = parts[2];
      if (
        scopePart === 'global' ||
        scopePart === 'token' ||
        scopePart === 'org' ||
        scopePart === 'hybrid'
      ) {
        return scopePart;
      }
    }
    return null;
  }

  /**
   * Log non-global scope access for observability
   */
  private logScopeAccess(
    operation: string,
    scopeContext: KnowledgeScopeContext,
    intentCluster: string
  ): void {
    if (scopeContext.scope !== 'global') {
      logger.info(`Knowledge ${operation} using non-global scope`, {
        scope: scopeContext.scope,
        token_id: scopeContext.token_id,
        org_id: scopeContext.org_id,
        intent_cluster: intentCluster,
      });
    }
  }
}

/**
 * Redis-backed knowledge store for production
 * Scope-aware: uses scoped keys to isolate knowledge by scope
 */
export class RedisKnowledgeStore implements KnowledgeStore {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get(
    intentCluster: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<KnowledgeEntry | null> {
    const key = buildScopedKey(intentCluster, scopeContext);
    this.logScopeAccess('get', scopeContext, intentCluster);

    const data = await this.redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as KnowledgeEntry;
  }

  async recordVote(
    intentCluster: string,
    model: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<KnowledgeEntry> {
    const key = buildScopedKey(intentCluster, scopeContext);
    this.logScopeAccess('recordVote', scopeContext, intentCluster);

    const existing = await this.get(intentCluster, scopeContext);
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
      await this.redis.set(key, JSON.stringify(entry));
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

    await this.redis.set(key, JSON.stringify(updated));
    return updated;
  }

  async applyDecay(scopeContext?: KnowledgeScopeContext): Promise<number> {
    const pattern = buildScopePattern(scopeContext);
    const keys = await this.redis.keys(pattern);
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

  async getStats(scopeContext?: KnowledgeScopeContext): Promise<KnowledgeStoreStats> {
    const pattern = buildScopePattern(scopeContext);
    const keys = await this.redis.keys(pattern);
    const entriesByConfidence: Record<ConfidenceLevel, number> = {
      strong: 0,
      moderate: 0,
      low: 0,
    };
    const entriesByScope: Record<KnowledgeScope, number> = {
      global: 0,
      token: 0,
      org: 0,
      hybrid: 0,
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

        // Track scope distribution
        const scope = this.extractScopeFromKey(key);
        if (scope) {
          entriesByScope[scope]++;
        }
      }
    }

    return {
      total_entries: entryCount,
      entries_by_confidence: entriesByConfidence,
      average_agreement_score: entryCount > 0 ? totalAgreement / entryCount : 0,
      entries_by_scope: entriesByScope,
    };
  }

  async getConsensusModel(
    intentCluster: string,
    scopeContext: KnowledgeScopeContext
  ): Promise<string | null> {
    const entry = await this.get(intentCluster, scopeContext);
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

  /**
   * Extract scope type from key for stats tracking
   */
  private extractScopeFromKey(key: string): KnowledgeScope | null {
    // Key format: wayfinder:knowledge:{scope}:...
    const parts = key.split(':');
    if (parts.length >= 3) {
      const scopePart = parts[2];
      if (
        scopePart === 'global' ||
        scopePart === 'token' ||
        scopePart === 'org' ||
        scopePart === 'hybrid'
      ) {
        return scopePart;
      }
    }
    return null;
  }

  /**
   * Log non-global scope access for observability
   */
  private logScopeAccess(
    operation: string,
    scopeContext: KnowledgeScopeContext,
    intentCluster: string
  ): void {
    if (scopeContext.scope !== 'global') {
      logger.info(`Knowledge ${operation} using non-global scope`, {
        scope: scopeContext.scope,
        token_id: scopeContext.token_id,
        org_id: scopeContext.org_id,
        intent_cluster: intentCluster,
      });
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
