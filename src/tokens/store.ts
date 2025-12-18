import { TokenConfig, TokenCreateRequest, TokenUpdateRequest } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { hashToken } from '../auth/middleware';
import Redis from 'ioredis';

const TOKEN_PREFIX = 'wayfinder:token:';
const TOKEN_HASH_INDEX = 'wayfinder:token_hash_index:';

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
  private tokens: Map<string, TokenConfig> = new Map();
  private hashIndex: Map<string, string> = new Map();

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
      policy_rules: request.policy_rules,
      confidence_threshold: request.confidence_threshold ?? 0.6,
      logging_level: request.logging_level ?? 'normal',
      default_model: request.default_model,
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
      policy_rules: request.policy_rules,
      confidence_threshold: request.confidence_threshold ?? 0.6,
      logging_level: request.logging_level ?? 'normal',
      default_model: request.default_model,
      environment: request.environment ?? 'dev',
      knowledge_scope: request.knowledge_scope ?? 'global', // Default to global scope
      created_at: now,
      updated_at: now,
    };

    await this.redis.set(TOKEN_PREFIX + id, JSON.stringify(config));
    await this.redis.set(TOKEN_HASH_INDEX + tokenHash, id);

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
    return true;
  }

  async list(): Promise<TokenConfig[]> {
    const keys = await this.redis.keys(TOKEN_PREFIX + '*');
    if (keys.length === 0) return [];

    const configs: TokenConfig[] = [];
    for (const key of keys) {
      // Skip hash index keys
      if (key.includes('hash_index')) continue;
      const data = await this.redis.get(key);
      if (data) {
        configs.push(JSON.parse(data) as TokenConfig);
      }
    }
    return configs;
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
