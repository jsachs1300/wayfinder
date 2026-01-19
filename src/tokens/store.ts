import { TokenConfig, TokenCreateRequest, TokenUpdateRequest } from '../types';
import { TokenConfigExtended } from './types';
import { v4 as uuidv4 } from 'uuid';
import { hashToken } from '../auth/middleware';
import Redis from 'ioredis';

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
  deleteUserToken(userId: string, tokenId: string): Promise<boolean>;
}

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

  async create(request: TokenCreateRequest): Promise<{ id: string; token: string; config: TokenConfig }> {
    const id = uuidv4();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const config: TokenConfig = {
      id,
      token_hash: tokenHash,
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

    // Check if this is the user's first token (make it primary)
    const userTokens = this.userTokenIndex.get(userId);
    const isPrimary = !userTokens || userTokens.size === 0;

    const config: TokenConfigExtended = {
      id,
      token_hash: tokenHash,
      user_id: userId,
      name,
      is_primary: isPrimary,
      anonymous_session_id: null,
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

  async deleteUserToken(userId: string, tokenId: string): Promise<boolean> {
    const existing = this.tokens.get(tokenId);
    if (!existing) return false;

    // Verify token belongs to user
    if (existing.user_id !== userId) return false;

    this.hashIndex.delete(existing.token_hash);
    this.tokens.delete(tokenId);

    // Remove from user index
    const userTokens = this.userTokenIndex.get(userId);
    if (userTokens) {
      userTokens.delete(tokenId);
      if (userTokens.size === 0) {
        this.userTokenIndex.delete(userId);
      }
    }

    return true;
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

    await this.redis.set(TOKEN_PREFIX + id, JSON.stringify(config));
    await this.redis.set(TOKEN_HASH_INDEX + tokenHash, id);
    await this.redis.sadd(TOKEN_INDEX_KEY, id);

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

    // Remove old hash from index
    await this.redis.del(TOKEN_HASH_INDEX + existing.token_hash);

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

    await this.redis.set(TOKEN_PREFIX + id, JSON.stringify(updated));
    await this.redis.set(TOKEN_HASH_INDEX + tokenHash, id);

    return { token, config: updated };
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.redis.del(TOKEN_HASH_INDEX + existing.token_hash);
    await this.redis.del(TOKEN_PREFIX + id);
    await this.redis.srem(TOKEN_INDEX_KEY, id);
    return true;
  }

  async list(): Promise<TokenConfig[]> {
    const ids = await this.redis.smembers(TOKEN_INDEX_KEY);
    if (ids.length === 0) return [];

    const pipeline = this.redis.multi();
    ids.forEach(id => pipeline.get(TOKEN_PREFIX + id));
    const results = await pipeline.exec();

    const configs: TokenConfig[] = [];
    results?.forEach(result => {
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

    // Check if this is the user's first token (make it primary)
    const userTokensKey = USER_TOKENS_PREFIX + userId + ':tokens';
    const existingTokens = await this.redis.smembers(userTokensKey);
    const isPrimary = existingTokens.length === 0;

    const config: TokenConfigExtended = {
      id,
      token_hash: tokenHash,
      user_id: userId,
      name,
      is_primary: isPrimary,
      anonymous_session_id: null,
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

    await this.redis.set(TOKEN_PREFIX + id, JSON.stringify(config));
    await this.redis.set(TOKEN_HASH_INDEX + tokenHash, id);
    await this.redis.sadd(TOKEN_INDEX_KEY, id);
    await this.redis.sadd(userTokensKey, id);

    return { id, token, config };
  }

  async listByUser(userId: string): Promise<TokenConfigExtended[]> {
    const userTokensKey = USER_TOKENS_PREFIX + userId + ':tokens';
    const tokenIds = await this.redis.smembers(userTokensKey);
    if (tokenIds.length === 0) return [];

    const pipeline = this.redis.multi();
    tokenIds.forEach(id => pipeline.get(TOKEN_PREFIX + id));
    const results = await pipeline.exec();

    const configs: TokenConfigExtended[] = [];
    results?.forEach(result => {
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

  async deleteUserToken(userId: string, tokenId: string): Promise<boolean> {
    const existing = await this.getById(tokenId);
    if (!existing) return false;

    // Verify token belongs to user (cast to TokenConfigExtended to check user_id)
    const extendedConfig = existing as TokenConfigExtended;
    if (extendedConfig.user_id !== userId) return false;

    await this.redis.del(TOKEN_HASH_INDEX + existing.token_hash);
    await this.redis.del(TOKEN_PREFIX + tokenId);
    await this.redis.srem(TOKEN_INDEX_KEY, tokenId);
    await this.redis.srem(USER_TOKENS_PREFIX + userId + ':tokens', tokenId);

    return true;
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
