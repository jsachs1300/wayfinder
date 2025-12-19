import {
  KnowledgeEntry,
  ConfidenceLevel,
  KnowledgeStoreStats,
  KnowledgeScopeContext,
  KnowledgeScope,
} from '../types';
import { ModelRegistry } from '../models';
import Redis from 'ioredis';
import { createLogger } from '../logging';

const KNOWLEDGE_PREFIX = 'wayfinder:knowledge:';
const KNOWLEDGE_STATS_PREFIX = 'wayfinder:knowledge:stats:';
const KNOWLEDGE_INDEX_PREFIX = 'wayfinder:knowledge:index:';
const KNOWN_SCOPES_KEY = 'wayfinder:knowledge:scopes';
const MIN_VOTES_FOR_STRONG = parseInt(process.env.MIN_VOTES_FOR_STRONG_CONFIDENCE ?? '5', 10);
const DECAY_LAMBDA = parseFloat(process.env.KNOWLEDGE_DECAY_LAMBDA ?? '0.000000001');

const logger = createLogger(process.env.LOG_LEVEL);

interface StoredKnowledgeEntry {
  intent_cluster: string;
  model_votes: Record<string, number>;
  rawScore: number;
  lastUpdatedMs: number;
}

interface StoredStats {
  totalCount: number;
  totalRawScore: number;
  totalAgreementScore: number;
  strongCount: number;
  moderateCount: number;
  lowCount: number;
  lastUpdatedMs: number | null;
}

const DEFAULT_STATS: StoredStats = {
  totalCount: 0,
  totalRawScore: 0,
  totalAgreementScore: 0,
  strongCount: 0,
  moderateCount: 0,
  lowCount: 0,
  lastUpdatedMs: null,
};

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
function calculateConfidenceLevel(agreementScore: number, totalVotes: number): ConfidenceLevel {
  if (totalVotes < 2) {
    return 'low';
  }
  if (agreementScore >= 0.8 && totalVotes >= MIN_VOTES_FOR_STRONG) {
    return 'strong';
  }
  if (agreementScore >= 0.6) {
    return 'moderate';
  }
  return 'low';
}

function computeDecayFactor(lastUpdatedMs: number, nowMs: number): number {
  const elapsed = nowMs - lastUpdatedMs;
  if (elapsed <= 0) return 1;
  return Math.exp(-DECAY_LAMBDA * elapsed);
}

function applyDecayToVotes(modelVotes: Record<string, number>, factor: number): Record<string, number> {
  const decayed: Record<string, number> = {};
  for (const [model, votes] of Object.entries(modelVotes)) {
    decayed[model] = Math.max(votes * factor, Number.EPSILON);
  }
  return decayed;
}

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
      throw new Error('Org-scoped knowledge is not yet implemented');
    case 'hybrid':
      throw new Error('Hybrid knowledge scope is not yet implemented');
    default:
      throw new Error(`Unknown knowledge scope: ${scopeContext.scope}`);
  }
}

function buildScopeKey(scopeContext: KnowledgeScopeContext): string {
  validateScopeContext(scopeContext);

  switch (scopeContext.scope) {
    case 'global':
      return 'global';
    case 'token':
      if (!scopeContext.token_id) {
        throw new Error('token_id is required for token scope');
      }
      return `token:${scopeContext.token_id}`;
    case 'org':
      throw new Error('Org-scoped knowledge is not yet implemented');
    case 'hybrid':
      throw new Error('Hybrid knowledge scope is not yet implemented');
    default:
      throw new Error(`Unknown knowledge scope: ${scopeContext.scope}`);
  }
}

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

function materializeEntry(entry: StoredKnowledgeEntry, nowMs: number): KnowledgeEntry {
  const factor = Math.max(computeDecayFactor(entry.lastUpdatedMs, nowMs), Number.EPSILON);
  const modelVotes = applyDecayToVotes(entry.model_votes, factor);
  const totalVotes = Object.values(modelVotes).reduce((sum, v) => sum + v, 0);
  const agreementScore = calculateAgreementScore(modelVotes);
  const confidenceLevel = calculateConfidenceLevel(agreementScore, totalVotes);

  return {
    intent_cluster: entry.intent_cluster,
    model_votes: modelVotes,
    agreement_score: agreementScore,
    confidence_level: confidenceLevel,
    total_votes: totalVotes,
    last_updated: new Date(entry.lastUpdatedMs).toISOString(),
    decay_factor: factor,
    rawScore: entry.rawScore,
    lastUpdatedMs: entry.lastUpdatedMs,
  };
}

function adjustConfidenceCounts(
  stats: StoredStats,
  previous: ConfidenceLevel | null,
  next: ConfidenceLevel
): void {
  if (!previous) {
    stats[`${next}Count` as const]++;
    return;
  }
  if (previous === next) return;
  stats[`${previous}Count` as const]--;
  stats[`${next}Count` as const]++;
}

function aggregateStats(collection: StoredStats[], nowMs: number): KnowledgeStoreStats {
  const totals = collection.reduce(
    (acc, current) => {
      acc.total_entries += current.totalCount;
      acc.total_raw_score += current.totalRawScore;
      acc.total_agreement_score += current.totalAgreementScore;
      acc.entries_by_confidence.strong += current.strongCount;
      acc.entries_by_confidence.moderate += current.moderateCount;
      acc.entries_by_confidence.low += current.lowCount;
      if (current.lastUpdatedMs !== null) {
        acc.last_updated_ms =
          acc.last_updated_ms === null
            ? current.lastUpdatedMs
            : Math.max(acc.last_updated_ms, current.lastUpdatedMs);
      }
      return acc;
    },
    {
      total_entries: 0,
      total_raw_score: 0,
      total_agreement_score: 0,
      entries_by_confidence: { strong: 0, moderate: 0, low: 0 },
      last_updated_ms: null as number | null,
    }
  );

  const approximate_effective_score = totals.total_raw_score *
    (totals.last_updated_ms ? computeDecayFactor(totals.last_updated_ms, nowMs) : 0);
  const average_agreement_score =
    totals.total_entries > 0 ? totals.total_agreement_score / totals.total_entries : 0;

  return {
    total_entries: totals.total_entries,
    total_raw_score: totals.total_raw_score,
    approximate_effective_score,
    entries_by_confidence: totals.entries_by_confidence,
    average_agreement_score,
    last_updated_ms: totals.last_updated_ms,
  };
}

function guardRedisKeys(redis: Redis): void {
  const originalKeys = redis.keys.bind(redis);
  redis.keys = ((pattern: string) => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Redis KEYS is disabled in production code paths');
    }
    logger.warn('Redis KEYS called; avoid in production paths', { pattern });
    return originalKeys(pattern);
  }) as unknown as typeof redis.keys;
}

export interface KnowledgeStore {
  get(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry | null>;
  recordVote(intentCluster: string, model: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry>;
  applyDecay(scopeContext?: KnowledgeScopeContext): Promise<number>;
  getStats(scopeContext?: KnowledgeScopeContext): Promise<KnowledgeStoreStats>;
  getConsensusModel(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<string | null>;
  clear(scopeContext?: KnowledgeScopeContext): Promise<void>;
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private entries: Map<string, StoredKnowledgeEntry> = new Map();
  private stats: Map<string, StoredStats> = new Map();
  private index: Map<string, Set<string>> = new Map();
  private modelRegistry: ModelRegistry;

  constructor(modelRegistry: ModelRegistry) {
    this.modelRegistry = modelRegistry;
  }

  async get(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry | null> {
    const key = buildScopedKey(intentCluster, scopeContext);
    this.logScopeAccess('get', scopeContext, intentCluster);

    const entry = this.entries.get(key);
    if (!entry) return null;
    return materializeEntry(entry, Date.now());
  }

  async recordVote(intentCluster: string, model: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry> {
    this.modelRegistry.assertModelExists(model, 'knowledge_vote');
    this.modelRegistry.assertModelActive(model, 'knowledge_vote');

    if (scopeContext.scope === 'global') {
      this.modelRegistry.assertModelGlobalEligible(model, 'knowledge_vote');
    }

    const key = buildScopedKey(intentCluster, scopeContext);
    const scopeKey = buildScopeKey(scopeContext);
    this.logScopeAccess('recordVote', scopeContext, intentCluster);

    const nowMs = Date.now();
    const existing = this.entries.get(key);
    const decayFactor = existing ? computeDecayFactor(existing.lastUpdatedMs, nowMs) : 1;
    const decayedVotes = existing ? applyDecayToVotes(existing.model_votes, decayFactor) : {};

    const updatedVotes: Record<string, number> = { ...decayedVotes };
    updatedVotes[model] = (updatedVotes[model] ?? 0) + 1;
    const updatedRawScore = Object.values(updatedVotes).reduce((sum, v) => sum + v, 0);

    const stored: StoredKnowledgeEntry = {
      intent_cluster: intentCluster,
      model_votes: updatedVotes,
      rawScore: updatedRawScore,
      lastUpdatedMs: nowMs,
    };

    this.entries.set(key, stored);
    this.index.set(scopeKey, this.index.get(scopeKey) ?? new Set());
    this.index.get(scopeKey)!.add(key);

    const nextMaterialized = materializeEntry(stored, nowMs);
    const entryForStats = existing ? nextMaterialized : { ...nextMaterialized, confidence_level: 'low' as ConfidenceLevel };

    this.updateStats(scopeKey, existing ? materializeEntry(existing, nowMs) : null, entryForStats);
    return entryForStats;
  }

  async applyDecay(): Promise<number> {
    throw new Error('applyDecay is deprecated. Decay is applied lazily at read-time.');
  }

  async getStats(scopeContext?: KnowledgeScopeContext): Promise<KnowledgeStoreStats> {
    const nowMs = Date.now();
    if (scopeContext) {
      const stats = this.stats.get(buildScopeKey(scopeContext)) ?? { ...DEFAULT_STATS };
      const aggregated = aggregateStats([stats], nowMs);
      const entriesByScope: Record<KnowledgeScope, number> = { global: 0, token: 0, org: 0, hybrid: 0 };
      entriesByScope[scopeContext.scope] = aggregated.total_entries;
      return { ...aggregated, entries_by_scope: entriesByScope };
    }

    const allStats = Array.from(this.stats.values());
    const aggregated = aggregateStats(allStats, nowMs);

    const entriesByScope: Record<KnowledgeScope, number> = { global: 0, token: 0, org: 0, hybrid: 0 };
    for (const [scopeKey, stats] of this.stats.entries()) {
      const scopeType = scopeKey.startsWith('token:') ? 'token' : 'global';
      entriesByScope[scopeType] += stats.totalCount;
    }

    return {
      ...aggregated,
      entries_by_scope: entriesByScope,
    };
  }

  async getConsensusModel(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<string | null> {
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

  async clear(scopeContext?: KnowledgeScopeContext): Promise<void> {
    if (scopeContext) {
      const scopeKey = buildScopeKey(scopeContext);
      const keys = Array.from(this.index.get(scopeKey) ?? []);
      for (const key of keys) {
        this.entries.delete(key);
      }
      this.index.delete(scopeKey);
      this.stats.delete(scopeKey);
      return;
    }

    this.entries.clear();
    this.index.clear();
    this.stats.clear();
  }

  private updateStats(scopeKey: string, previous: KnowledgeEntry | null, next: KnowledgeEntry): void {
    const stats = this.stats.get(scopeKey) ?? { ...DEFAULT_STATS };
    const prevRaw = previous?.rawScore ?? 0;
    const prevAgreement = previous?.agreement_score ?? 0;

    if (!previous) {
      stats.totalCount += 1;
    }

    stats.totalRawScore += next.rawScore - prevRaw;
    stats.totalAgreementScore += next.agreement_score - prevAgreement;
    adjustConfidenceCounts(stats, previous ? previous.confidence_level : null, next.confidence_level);
    stats.lastUpdatedMs = next.lastUpdatedMs;
    this.stats.set(scopeKey, stats);
  }

  private logScopeAccess(operation: string, scopeContext: KnowledgeScopeContext, intentCluster: string): void {
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

export class RedisKnowledgeStore implements KnowledgeStore {
  private redis: Redis;
  private modelRegistry: ModelRegistry;

  constructor(redis: Redis, modelRegistry: ModelRegistry) {
    guardRedisKeys(redis);
    this.redis = redis;
    this.modelRegistry = modelRegistry;
  }

  async get(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry | null> {
    const key = buildScopedKey(intentCluster, scopeContext);
    this.logScopeAccess('get', scopeContext, intentCluster);

    const stored = await this.redis.get(key);
    if (!stored) return null;
    return materializeEntry(JSON.parse(stored) as StoredKnowledgeEntry, Date.now());
  }

  async recordVote(intentCluster: string, model: string, scopeContext: KnowledgeScopeContext): Promise<KnowledgeEntry> {
    this.modelRegistry.assertModelExists(model, 'knowledge_vote');
    this.modelRegistry.assertModelActive(model, 'knowledge_vote');

    if (scopeContext.scope === 'global') {
      this.modelRegistry.assertModelGlobalEligible(model, 'knowledge_vote');
    }

    const key = buildScopedKey(intentCluster, scopeContext);
    const scopeKey = buildScopeKey(scopeContext);
    this.logScopeAccess('recordVote', scopeContext, intentCluster);

    const nowMs = Date.now();
    const existingRaw = await this.getStoredEntry(key);
    const previousMaterialized = existingRaw ? materializeEntry(existingRaw, nowMs) : null;
    const decayFactor = existingRaw ? computeDecayFactor(existingRaw.lastUpdatedMs, nowMs) : 1;
    const decayedVotes = existingRaw ? applyDecayToVotes(existingRaw.model_votes, decayFactor) : {};

    const updatedVotes: Record<string, number> = { ...decayedVotes };
    updatedVotes[model] = (updatedVotes[model] ?? 0) + 1;
    const updatedRawScore = Object.values(updatedVotes).reduce((sum, v) => sum + v, 0);

    const stored: StoredKnowledgeEntry = {
      intent_cluster: intentCluster,
      model_votes: updatedVotes,
      rawScore: updatedRawScore,
      lastUpdatedMs: nowMs,
    };

    const nextMaterialized = materializeEntry(stored, nowMs);
    const entryForStats = previousMaterialized
      ? nextMaterialized
      : { ...nextMaterialized, confidence_level: 'low' as ConfidenceLevel };
    await this.persistEntry(key, scopeKey, stored, previousMaterialized, entryForStats);
    return entryForStats;
  }

  async applyDecay(): Promise<number> {
    throw new Error('applyDecay is deprecated. Decay is applied lazily at read-time.');
  }

  async getStats(scopeContext?: KnowledgeScopeContext): Promise<KnowledgeStoreStats> {
    const nowMs = Date.now();
    if (scopeContext) {
      const stats = await this.readStats(buildScopeKey(scopeContext));
      const aggregated = aggregateStats([stats], nowMs);
      const entriesByScope: Record<KnowledgeScope, number> = { global: 0, token: 0, org: 0, hybrid: 0 };
      entriesByScope[scopeContext.scope] = aggregated.total_entries;
      return { ...aggregated, entries_by_scope: entriesByScope };
    }

    const scopeKeys = await this.redis.smembers(KNOWN_SCOPES_KEY);
    if (scopeKeys.length === 0) {
      return aggregateStats([], nowMs);
    }

    const pipeline = this.redis.multi();
    scopeKeys.forEach(scopeKey => {
      pipeline.hgetall(`${KNOWLEDGE_STATS_PREFIX}${scopeKey}`);
    });
    const statsList = await pipeline.exec();

    const parsedStats: StoredStats[] = [];
    statsList?.forEach(result => {
      const [, data] = result ?? [];
      parsedStats.push(this.parseStatsHash((data as Record<string, string>) ?? {}));
    });

    const aggregated = aggregateStats(parsedStats, nowMs);
    const entriesByScope: Record<KnowledgeScope, number> = { global: 0, token: 0, org: 0, hybrid: 0 };

    scopeKeys.forEach((scopeKey, index) => {
      const stats = parsedStats[index];
      if (stats) {
        const scopeType: KnowledgeScope = scopeKey.startsWith('token:') ? 'token' : 'global';
        entriesByScope[scopeType] += stats.totalCount;
      }
    });

    return { ...aggregated, entries_by_scope: entriesByScope };
  }

  async getConsensusModel(intentCluster: string, scopeContext: KnowledgeScopeContext): Promise<string | null> {
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

  async clear(scopeContext?: KnowledgeScopeContext): Promise<void> {
    if (scopeContext) {
      await this.clearScope(buildScopeKey(scopeContext));
      return;
    }

    const scopeKeys = await this.redis.smembers(KNOWN_SCOPES_KEY);
    for (const scopeKey of scopeKeys) {
      await this.clearScope(scopeKey);
    }
    await this.redis.del(KNOWN_SCOPES_KEY);
  }

  private async clearScope(scopeKey: string): Promise<void> {
    const indexKey = `${KNOWLEDGE_INDEX_PREFIX}${scopeKey}`;
    while (true) {
      const batch = await this.redis.zrange(indexKey, 0, 99);
      if (batch.length === 0) break;
      const pipeline = this.redis.multi();
      pipeline.unlink(...batch);
      pipeline.zrem(indexKey, ...batch);
      await pipeline.exec();
    }
    await this.redis.del(indexKey, `${KNOWLEDGE_STATS_PREFIX}${scopeKey}`);
    await this.redis.srem(KNOWN_SCOPES_KEY, scopeKey);
  }

  private async getStoredEntry(key: string): Promise<StoredKnowledgeEntry | null> {
    const data = await this.redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as StoredKnowledgeEntry;
  }

  private async persistEntry(
    key: string,
    scopeKey: string,
    entry: StoredKnowledgeEntry,
    previous: KnowledgeEntry | null,
    next: KnowledgeEntry
  ): Promise<void> {
    const statsKey = `${KNOWLEDGE_STATS_PREFIX}${scopeKey}`;
    const indexKey = `${KNOWLEDGE_INDEX_PREFIX}${scopeKey}`;
    const prevRaw = previous?.rawScore ?? 0;
    const prevAgreement = previous?.agreement_score ?? 0;

    const pipeline = this.redis.multi();
    pipeline.set(key, JSON.stringify(entry));
    pipeline.zadd(indexKey, entry.lastUpdatedMs, key);
    pipeline.sadd(KNOWN_SCOPES_KEY, scopeKey);

    pipeline.hincrby(statsKey, 'totalCount', previous ? 0 : 1);
    pipeline.hincrbyfloat(statsKey, 'totalRawScore', entry.rawScore - prevRaw);
    pipeline.hincrbyfloat(statsKey, 'totalAgreementScore', next.agreement_score - prevAgreement);
    pipeline.hset(statsKey, 'lastUpdatedMs', entry.lastUpdatedMs);
    pipeline.hincrby(statsKey, 'strongCount', this.confidenceDelta(previous?.confidence_level, next.confidence_level, 'strong'));
    pipeline.hincrby(statsKey, 'moderateCount', this.confidenceDelta(previous?.confidence_level, next.confidence_level, 'moderate'));
    pipeline.hincrby(statsKey, 'lowCount', this.confidenceDelta(previous?.confidence_level, next.confidence_level, 'low'));

    await pipeline.exec();
  }

  private confidenceDelta(
    previous: ConfidenceLevel | undefined,
    next: ConfidenceLevel,
    target: ConfidenceLevel
  ): number {
    if (!previous) {
      return next === target ? 1 : 0;
    }
    if (previous === next) return 0;
    if (previous === target) return -1;
    if (next === target) return 1;
    return 0;
  }

  private async readStats(scopeKey: string): Promise<StoredStats> {
    const data = await this.redis.hgetall(`${KNOWLEDGE_STATS_PREFIX}${scopeKey}`);
    return this.parseStatsHash(data);
  }

  private parseStatsHash(data: Record<string, string>): StoredStats {
    if (!data || Object.keys(data).length === 0) {
      return { ...DEFAULT_STATS };
    }

    return {
      totalCount: parseInt(data.totalCount ?? '0', 10),
      totalRawScore: parseFloat(data.totalRawScore ?? '0'),
      totalAgreementScore: parseFloat(data.totalAgreementScore ?? '0'),
      strongCount: parseInt(data.strongCount ?? '0', 10),
      moderateCount: parseInt(data.moderateCount ?? '0', 10),
      lowCount: parseInt(data.lowCount ?? '0', 10),
      lastUpdatedMs: data.lastUpdatedMs ? parseInt(data.lastUpdatedMs, 10) : null,
    };
  }

  private logScopeAccess(operation: string, scopeContext: KnowledgeScopeContext, intentCluster: string): void {
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

export function createKnowledgeStore(redis: Redis | undefined, modelRegistry: ModelRegistry): KnowledgeStore {
  if (redis) {
    return new RedisKnowledgeStore(redis, modelRegistry);
  }
  return new InMemoryKnowledgeStore(modelRegistry);
}
