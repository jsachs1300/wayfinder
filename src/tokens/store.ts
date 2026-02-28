import { TokenConfig, TokenCreateRequest, TokenUpdateRequest } from '../types';
import { TokenConfigExtended } from './types';
import { v4 as uuidv4 } from 'uuid';
import { hashToken } from '../auth/middleware';
import Redis from 'ioredis';
import { assertRedisExecResults } from '../redis/exec';

const TOKEN_PREFIX = 'wayfinder:token:';
const TOKEN_HASH_INDEX = 'wayfinder:token_hash_index:';
const TOKEN_INDEX_KEY = 'wayfinder:token:index';
const USER_TOKENS_PREFIX = 'wayfinder:user:';

/**
 * Token storage interface for flexibility
 */
export interface TokenStore {
  create(request: TokenCreateRequest): Promise<{ id: string; token: string; config: TokenConfig }>;
  getById(id: string): Promise<TokenConfig | null>;
  getByHash(tokenHash: string): Promise<TokenConfig | null>;
  update(id: string, request: TokenUpdateRequest): Promise<TokenConfig | null>;
  rotate(id: string): Promise<{ token: string; config: TokenConfig } | null>;
  delete(id: string): Promise<boolean>;
  list(): Promise<TokenConfig[]>;

  /**
   * Create token for a specific user
   */
  createForUser(
    userId: string,
    name: string | null,
    request: TokenCreateRequest
  ): Promise<{ id: string; token: string; config: TokenConfigExtended }>;

  /**
   * List all tokens for a user
   */
  listByUser(userId: string): Promise<TokenConfigExtended[]>;

  /**
   * Delete a token belonging to a user
   * Returns false if token doesn't exist or doesn't belong to user
   */
  deleteUserToken(userId: string, tokenId: string): Promise<DeleteUserTokenResult>;
}

export type DeleteUserTokenResult =
  | { deleted: true }
  | { deleted: false; reason: 'not_found' | 'not_owner' | 'last_token' };

/**
 * Generate a secure random token
 */
function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const prefix = 'wf_';
  let result = prefix;
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  for (let i = 0; i < 32; i++) {
    result += chars[randomBytes[i]! % chars.length];
  }
  return result;
}

/**
 * In-memory token store for development and fallback
 */
export class InMemoryTokenStore implements TokenStore {
  private tokens: Map<string, TokenConfigExtended> = new Map();
  private hashIndex: Map<string, string> = new Map();
  private userTokenIndex: Map<string, Set<string>> = new Map();
  private userLocks: Map<string, Promise<void>> = new Map();

  private async withUserLock<T>(userId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.userLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.userLocks.set(userId, previous.then(() => current));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.userLocks.get(userId) === current) {
        this.userLocks.delete(userId);
      }
    }
  }

  async create(request: TokenCreateRequest): Promise<{ id: string; token: string; config: TokenConfig }> {
    const id = uuidv4();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const config: TokenConfig = {
      id,
      token_hash: tokenHash,
      is_default: request.is_default === true ? true : undefined,
      trusted_anchor_model: request.trusted_anchor_model,
      allowed_models: request.allowed_models,
      denied_models: request.denied_models,
      eligible_models: request.eligible_models,
      policy_rules: request.policy_rules,
      confidence_threshold: request.confidence_threshold ?? 0.6,
      logging_level: request.logging_level ?? 'normal',
      environment: request.environment ?? 'dev',
      knowledge_scope: request.knowledge_scope ?? 'global', // Default to global scope
      created_at: now,
      updated_at: now,
    };

    this.tokens.set(id, config);
    this.hashIndex.set(tokenHash, id);

    return { id, token, config };
  }

  async getById(id: string): Promise<TokenConfig | null> {
    return this.tokens.get(id) ?? null;
  }

  async getByHash(tokenHash: string): Promise<TokenConfig | null> {
    const id = this.hashIndex.get(tokenHash);
    if (!id) return null;
    return this.tokens.get(id) ?? null;
  }

  async update(id: string, request: TokenUpdateRequest): Promise<TokenConfig | null> {
    const existing = this.tokens.get(id);
    if (!existing) return null;

    const updated: TokenConfig = {
      ...existing,
      ...request,
      id: existing.id,
      token_hash: existing.token_hash,
      created_at: existing.created_at,
      updated_at: new Date().toISOString(),
    };

    this.tokens.set(id, updated);
    return updated;
  }

  async rotate(id: string): Promise<{ token: string; config: TokenConfig } | null> {
    const existing = this.tokens.get(id);
    if (!existing) return null;

    // Remove old hash from index
    this.hashIndex.delete(existing.token_hash);

    // Generate new token
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const updated: TokenConfig = {
      ...existing,
      token_hash: tokenHash,
      updated_at: now,
      rotated_at: now,
    };

    this.tokens.set(id, updated);
    this.hashIndex.set(tokenHash, id);

    return { token, config: updated };
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.tokens.get(id);
    if (!existing) return false;

    this.hashIndex.delete(existing.token_hash);
    this.tokens.delete(id);
    return true;
  }

  async list(): Promise<TokenConfig[]> {
    return Array.from(this.tokens.values());
  }

  async createForUser(
    userId: string,
    name: string | null,
    request: TokenCreateRequest
  ): Promise<{ id: string; token: string; config: TokenConfigExtended }> {
    const id = uuidv4();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const config: TokenConfigExtended = {
      id,
      token_hash: tokenHash,
      user_id: userId,
      name,
      anonymous_session_id: null,
      is_default: request.is_default === true ? true : undefined,
      trusted_anchor_model: request.trusted_anchor_model,
      allowed_models: request.allowed_models,
      denied_models: request.denied_models,
      eligible_models: request.eligible_models,
      policy_rules: request.policy_rules,
      confidence_threshold: request.confidence_threshold ?? 0.6,
      logging_level: request.logging_level ?? 'normal',
      environment: request.environment ?? 'dev',
      knowledge_scope: request.knowledge_scope ?? 'global',
      router_model_preference: request.router_model_preference,
      created_at: now,
      updated_at: now,
    };

    this.tokens.set(id, config);
    this.hashIndex.set(tokenHash, id);

    // Add to user index
    if (!this.userTokenIndex.has(userId)) {
      this.userTokenIndex.set(userId, new Set());
    }
    this.userTokenIndex.get(userId)!.add(id);

    return { id, token, config };
  }

  async listByUser(userId: string): Promise<TokenConfigExtended[]> {
    const tokenIds = this.userTokenIndex.get(userId);
    if (!tokenIds || tokenIds.size === 0) return [];

    const tokens: TokenConfigExtended[] = [];
    for (const tokenId of tokenIds) {
      const token = this.tokens.get(tokenId);
      if (token && token.user_id === userId) {
        tokens.push(token);
      }
    }

    return tokens;
  }

  async deleteUserToken(userId: string, tokenId: string): Promise<DeleteUserTokenResult> {
    return this.withUserLock(userId, () => {
      const existing = this.tokens.get(tokenId);
      if (!existing) return { deleted: false, reason: 'not_found' };

      // Verify token belongs to user
      if (existing.user_id !== userId) return { deleted: false, reason: 'not_owner' };

      const userTokens = this.userTokenIndex.get(userId);
      if (!userTokens || userTokens.size <= 1) {
        return { deleted: false, reason: 'last_token' };
      }

      this.hashIndex.delete(existing.token_hash);
      this.tokens.delete(tokenId);

      userTokens.delete(tokenId);
      if (userTokens.size === 0) {
        this.userTokenIndex.delete(userId);
      }

      return { deleted: true };
    });
  }
}

/**
 * Redis-backed token store for production
 */
export class RedisTokenStore implements TokenStore {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async create(request: TokenCreateRequest): Promise<{ id: string; token: string; config: TokenConfig }> {
    const id = uuidv4();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const config: TokenConfig = {
      id,
      token_hash: tokenHash,
      is_default: request.is_default === true ? true : undefined,
      trusted_anchor_model: request.trusted_anchor_model,
      allowed_models: request.allowed_models,
      denied_models: request.denied_models,
      eligible_models: request.eligible_models,
      policy_rules: request.policy_rules,
      confidence_threshold: request.confidence_threshold ?? 0.6,
      logging_level: request.logging_level ?? 'normal',
      environment: request.environment ?? 'dev',
      knowledge_scope: request.knowledge_scope ?? 'global', // Default to global scope
      created_at: now,
      updated_at: now,
    };

    const tx = this.redis.multi();
    tx.set(TOKEN_PREFIX + id, JSON.stringify(config));
    tx.set(TOKEN_HASH_INDEX + tokenHash, id);
    tx.sadd(TOKEN_INDEX_KEY, id);
    assertRedisExecResults(await tx.exec(), 'tokens.create');

    return { id, token, config };
  }

  async getById(id: string): Promise<TokenConfig | null> {
    const data = await this.redis.get(TOKEN_PREFIX + id);
    if (!data) return null;
    return JSON.parse(data) as TokenConfig;
  }

  async getByHash(tokenHash: string): Promise<TokenConfig | null> {
    const id = await this.redis.get(TOKEN_HASH_INDEX + tokenHash);
    if (!id) return null;
    return this.getById(id);
  }

  async update(id: string, request: TokenUpdateRequest): Promise<TokenConfig | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const updated: TokenConfig = {
      ...existing,
      ...request,
      id: existing.id,
      token_hash: existing.token_hash,
      created_at: existing.created_at,
      updated_at: new Date().toISOString(),
    };

    await this.redis.set(TOKEN_PREFIX + id, JSON.stringify(updated));
    return updated;
  }

  async rotate(id: string): Promise<{ token: string; config: TokenConfig } | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    // Generate new token
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const updated: TokenConfig = {
      ...existing,
      token_hash: tokenHash,
      updated_at: now,
      rotated_at: now,
    };

    const tx = this.redis.multi();
    tx.del(TOKEN_HASH_INDEX + existing.token_hash);
    tx.set(TOKEN_PREFIX + id, JSON.stringify(updated));
    tx.set(TOKEN_HASH_INDEX + tokenHash, id);
    assertRedisExecResults(await tx.exec(), 'tokens.rotate');

    return { token, config: updated };
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    const tx = this.redis.multi();
    tx.del(TOKEN_HASH_INDEX + existing.token_hash);
    tx.del(TOKEN_PREFIX + id);
    tx.srem(TOKEN_INDEX_KEY, id);
    assertRedisExecResults(await tx.exec(), 'tokens.delete');
    return true;
  }

  async list(): Promise<TokenConfig[]> {
    const ids = await this.redis.smembers(TOKEN_INDEX_KEY);
    if (ids.length === 0) return [];

    const pipeline = this.redis.multi();
    ids.forEach(id => pipeline.get(TOKEN_PREFIX + id));
    const results = assertRedisExecResults(await pipeline.exec(), 'tokens.list');

    const configs: TokenConfig[] = [];
    results.forEach(result => {
      const [, data] = result ?? [];
      if (typeof data === 'string') {
        configs.push(JSON.parse(data) as TokenConfig);
      }
    });

    return configs;
  }

  async createForUser(
    userId: string,
    name: string | null,
    request: TokenCreateRequest
  ): Promise<{ id: string; token: string; config: TokenConfigExtended }> {
    const id = uuidv4();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const userTokensKey = USER_TOKENS_PREFIX + userId + ':tokens';

    const config: TokenConfigExtended = {
      id,
      token_hash: tokenHash,
      user_id: userId,
      name,
      anonymous_session_id: null,
      is_default: request.is_default === true ? true : undefined,
      trusted_anchor_model: request.trusted_anchor_model,
      allowed_models: request.allowed_models,
      denied_models: request.denied_models,
      eligible_models: request.eligible_models,
      policy_rules: request.policy_rules,
      confidence_threshold: request.confidence_threshold ?? 0.6,
      logging_level: request.logging_level ?? 'normal',
      environment: request.environment ?? 'dev',
      knowledge_scope: request.knowledge_scope ?? 'global',
      router_model_preference: request.router_model_preference,
      created_at: now,
      updated_at: now,
    };

    const tx = this.redis.multi();
    tx.set(TOKEN_PREFIX + id, JSON.stringify(config));
    tx.set(TOKEN_HASH_INDEX + tokenHash, id);
    tx.sadd(TOKEN_INDEX_KEY, id);
    tx.sadd(userTokensKey, id);
    assertRedisExecResults(await tx.exec(), 'tokens.createForUser');

    return { id, token, config };
  }

  async listByUser(userId: string): Promise<TokenConfigExtended[]> {
    const userTokensKey = USER_TOKENS_PREFIX + userId + ':tokens';
    const tokenIds = await this.redis.smembers(userTokensKey);
    if (tokenIds.length === 0) return [];

    const pipeline = this.redis.multi();
    tokenIds.forEach(id => pipeline.get(TOKEN_PREFIX + id));
    const results = assertRedisExecResults(await pipeline.exec(), 'tokens.listByUser');

    const configs: TokenConfigExtended[] = [];
    results.forEach(result => {
      const [, data] = result ?? [];
      if (typeof data === 'string') {
        const config = JSON.parse(data) as TokenConfigExtended;
        // Verify token belongs to user
        if (config.user_id === userId) {
          configs.push(config);
        }
      }
    });

    return configs;
  }

  async deleteUserToken(userId: string, tokenId: string): Promise<DeleteUserTokenResult> {
    const userTokensKey = USER_TOKENS_PREFIX + userId + ':tokens';
    const tokenKey = TOKEN_PREFIX + tokenId;

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.redis.watch(userTokensKey, tokenKey);

      const isMember = await this.redis.sismember(userTokensKey, tokenId);
      if (!isMember) {
        await this.redis.unwatch();
        return { deleted: false, reason: 'not_owner' };
      }

      const count = await this.redis.scard(userTokensKey);
      if (count <= 1) {
        await this.redis.unwatch();
        return { deleted: false, reason: 'last_token' };
      }

      const data = await this.redis.get(tokenKey);
      if (!data) {
        const staleIndexResult = await this.redis.multi()
          .srem(userTokensKey, tokenId)
          .srem(TOKEN_INDEX_KEY, tokenId)
          .exec();
        assertRedisExecResults(staleIndexResult, 'tokens.deleteUserToken.cleanup');
        return { deleted: false, reason: 'not_found' };
      }

      const config = JSON.parse(data) as TokenConfigExtended;
      if (config.user_id !== userId) {
        await this.redis.unwatch();
        return { deleted: false, reason: 'not_owner' };
      }

      const result = await this.redis.multi()
        .del(TOKEN_HASH_INDEX + config.token_hash)
        .del(tokenKey)
        .srem(TOKEN_INDEX_KEY, tokenId)
        .srem(userTokensKey, tokenId)
        .exec();

      if (result) {
        assertRedisExecResults(result, 'tokens.deleteUserToken');
        return { deleted: true };
      }
    }

    throw new Error('Failed to delete user token due to concurrent modification');
  }
}

/**
 * Create appropriate token store based on environment
 */
export function createTokenStore(redis?: Redis): TokenStore {
  if (redis) {
    return new RedisTokenStore(redis);
  }
  return new InMemoryTokenStore();
}
