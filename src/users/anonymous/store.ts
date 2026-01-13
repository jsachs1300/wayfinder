/**
 * Anonymous Session Store
 *
 * Manages anonymous sessions for progressive registration.
 * Sessions expire after configurable TTL (default 7 days).
 */

import { v4 as uuidv4 } from 'uuid';
import type Redis from 'ioredis';
import type { AnonymousSession } from './types';
import type { TokenStore } from '../../tokens/store';

const SESSION_PREFIX = 'wayfinder:anon_session:';
const SESSION_TOKEN_INDEX = 'wayfinder:anon_session:token:';

/**
 * Get session TTL from environment or default to 7 days
 */
function getSessionTTLDays(): number {
  const envValue = process.env.ANONYMOUS_SESSION_TTL_DAYS;
  if (!envValue) {
    return 7;
  }

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.warn(
      `Invalid ANONYMOUS_SESSION_TTL_DAYS: "${envValue}". Using default: 7 days`
    );
    return 7;
  }

  return parsed;
}

/**
 * Calculate expiration date from now
 */
function calculateExpiresAt(): string {
  const ttlDays = getSessionTTLDays();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ttlDays);
  return expiresAt.toISOString();
}

/**
 * Anonymous session storage interface
 */
export interface AnonymousSessionStore {
  /**
   * Create a new anonymous session with a token
   * @returns Session and plaintext token (token only returned once)
   */
  create(): Promise<{ session: AnonymousSession; token: string }>;

  /**
   * Get session by session ID
   */
  getBySessionId(sessionId: string): Promise<AnonymousSession | null>;

  /**
   * Get session by token ID
   */
  getByTokenId(tokenId: string): Promise<AnonymousSession | null>;

  /**
   * Increment request count for session
   * @returns Updated request count
   */
  incrementRequestCount(sessionId: string): Promise<number>;

  /**
   * Delete session (used during conversion to registered user)
   */
  delete(sessionId: string): Promise<boolean>;

  /**
   * Convert anonymous session to user account
   * Links the session's token to the new user
   * @param sessionId - Session to convert
   * @param userId - New user ID
   * @returns Success status
   */
  convertToUser(sessionId: string, userId: string): Promise<boolean>;
}

/**
 * In-memory anonymous session store for development
 */
export class InMemoryAnonymousSessionStore implements AnonymousSessionStore {
  private sessions: Map<string, AnonymousSession> = new Map();
  private tokenIndex: Map<string, string> = new Map();
  private tokenStore: TokenStore;

  constructor(tokenStore: TokenStore) {
    this.tokenStore = tokenStore;
  }

  async create(): Promise<{ session: AnonymousSession; token: string }> {
    const sessionId = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = calculateExpiresAt();

    // Create token for this session
    const { id: tokenId, token } = await this.tokenStore.create({
      environment: 'dev',
      logging_level: 'normal',
      confidence_threshold: 0.6,
      knowledge_scope: 'global',
    });

    const session: AnonymousSession = {
      id: sessionId,
      token_id: tokenId,
      created_at: now,
      expires_at: expiresAt,
      request_count: 0,
    };

    this.sessions.set(sessionId, session);
    this.tokenIndex.set(tokenId, sessionId);

    return { session, token };
  }

  async getBySessionId(sessionId: string): Promise<AnonymousSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check expiration
    if (new Date(session.expires_at) < new Date()) {
      await this.delete(sessionId);
      return null;
    }

    return session;
  }

  async getByTokenId(tokenId: string): Promise<AnonymousSession | null> {
    const sessionId = this.tokenIndex.get(tokenId);
    if (!sessionId) return null;

    return this.getBySessionId(sessionId);
  }

  async incrementRequestCount(sessionId: string): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    session.request_count += 1;
    this.sessions.set(sessionId, session);
    return session.request_count;
  }

  async delete(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.tokenIndex.delete(session.token_id);
    this.sessions.delete(sessionId);
    return true;
  }

  async convertToUser(sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Token is now owned by user - no changes needed to token itself
    // The token will be linked to user by user management system

    // Delete session after conversion
    await this.delete(sessionId);
    return true;
  }
}

/**
 * Redis-backed anonymous session store for production
 */
export class RedisAnonymousSessionStore implements AnonymousSessionStore {
  private redis: Redis;
  private tokenStore: TokenStore;

  constructor(redis: Redis, tokenStore: TokenStore) {
    this.redis = redis;
    this.tokenStore = tokenStore;
  }

  async create(): Promise<{ session: AnonymousSession; token: string }> {
    const sessionId = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = calculateExpiresAt();
    const ttlDays = getSessionTTLDays();
    const ttlSeconds = ttlDays * 24 * 60 * 60;

    // Create token for this session
    const { id: tokenId, token } = await this.tokenStore.create({
      environment: 'dev',
      logging_level: 'normal',
      confidence_threshold: 0.6,
      knowledge_scope: 'global',
    });

    const session: AnonymousSession = {
      id: sessionId,
      token_id: tokenId,
      created_at: now,
      expires_at: expiresAt,
      request_count: 0,
    };

    // Store session with TTL
    await this.redis.setex(
      SESSION_PREFIX + sessionId,
      ttlSeconds,
      JSON.stringify(session)
    );

    // Store token -> session index with TTL
    await this.redis.setex(SESSION_TOKEN_INDEX + tokenId, ttlSeconds, sessionId);

    return { session, token };
  }

  async getBySessionId(sessionId: string): Promise<AnonymousSession | null> {
    const data = await this.redis.get(SESSION_PREFIX + sessionId);
    if (!data) return null;

    const session = JSON.parse(data) as AnonymousSession;

    // Check expiration (Redis TTL should handle this, but double-check)
    if (new Date(session.expires_at) < new Date()) {
      await this.delete(sessionId);
      return null;
    }

    return session;
  }

  async getByTokenId(tokenId: string): Promise<AnonymousSession | null> {
    const sessionId = await this.redis.get(SESSION_TOKEN_INDEX + tokenId);
    if (!sessionId) return null;

    return this.getBySessionId(sessionId);
  }

  async incrementRequestCount(sessionId: string): Promise<number> {
    const session = await this.getBySessionId(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    session.request_count += 1;

    // Get remaining TTL to preserve it
    const ttl = await this.redis.ttl(SESSION_PREFIX + sessionId);
    if (ttl > 0) {
      await this.redis.setex(
        SESSION_PREFIX + sessionId,
        ttl,
        JSON.stringify(session)
      );
    } else {
      // TTL expired or key doesn't exist
      await this.redis.set(SESSION_PREFIX + sessionId, JSON.stringify(session));
    }

    return session.request_count;
  }

  async delete(sessionId: string): Promise<boolean> {
    const session = await this.getBySessionId(sessionId);
    if (!session) return false;

    await this.redis.del(SESSION_PREFIX + sessionId);
    await this.redis.del(SESSION_TOKEN_INDEX + session.token_id);
    return true;
  }

  async convertToUser(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.getBySessionId(sessionId);
    if (!session) return false;

    // Token is now owned by user - no changes needed to token itself
    // The token will be linked to user by user management system

    // Delete session after conversion
    await this.delete(sessionId);
    return true;
  }
}

/**
 * Create appropriate anonymous session store based on environment
 */
export function createAnonymousSessionStore(
  tokenStore: TokenStore,
  redis?: Redis
): AnonymousSessionStore {
  if (redis) {
    return new RedisAnonymousSessionStore(redis, tokenStore);
  }
  return new InMemoryAnonymousSessionStore(tokenStore);
}
