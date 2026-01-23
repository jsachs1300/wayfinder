/**
 * User Session Store (Redis-backed)
 *
 * Sessions are required for frontend login flows and admin elevation.
 * All session data is stored in Redis.
 */

import { v4 as uuidv4, validate as validateUuid } from 'uuid';
import type Redis from 'ioredis';
import type { UserSession } from './types';
import { createHash } from 'crypto';

const SESSION_PREFIX = 'wayfinder:session:';
const SESSION_TOKEN_INDEX = 'wayfinder:session:token:';
const USER_SESSION_INDEX = 'wayfinder:session:user:';
const SESSION_TOKEN_HASH_INDEX = 'wayfinder:session:tokenhash:';

function getSessionTTLDays(): number {
  const envValue = process.env.SESSION_TTL_DAYS;
  if (!envValue) {
    return 7;
  }
  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(
      `Invalid SESSION_TTL_DAYS: "${envValue}". Using default: 7 days`
    );
    return 7;
  }
  return parsed;
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionStore {
  create(userId: string, options?: { isAdmin?: boolean }): Promise<{ session: UserSession; token: string }>;
  getByToken(token: string): Promise<UserSession | null>;
  delete(token: string): Promise<boolean>;
  elevate(token: string): Promise<{ session: UserSession; token: string } | null>;
  deleteAllByUserId(userId: string): Promise<void>;
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(userId: string, options?: { isAdmin?: boolean }): Promise<{ session: UserSession; token: string }> {
    const sessionId = uuidv4();
    const tokenId = uuidv4();
    const now = new Date();
    const ttlDays = getSessionTTLDays();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const session: UserSession = {
      id: sessionId,
      token_id: tokenId,
      user_id: userId,
      is_admin: options?.isAdmin ?? false,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    const tokenHash = hashSessionToken(tokenId);
    const ttlSeconds = ttlDays * 24 * 60 * 60;

    await this.redis.setex(
      SESSION_PREFIX + sessionId,
      ttlSeconds,
      JSON.stringify(session)
    );
    await this.redis.setex(
      SESSION_TOKEN_HASH_INDEX + sessionId,
      ttlSeconds,
      tokenHash
    );
    await this.redis.setex(
      SESSION_TOKEN_INDEX + tokenHash,
      ttlSeconds,
      sessionId
    );
    await this.redis.sadd(USER_SESSION_INDEX + userId, sessionId);

    return { session, token: tokenId };
  }

  async getByToken(token: string): Promise<UserSession | null> {
    if (!validateUuid(token)) {
      return null;
    }
    const tokenHash = hashSessionToken(token);
    const sessionId = await this.redis.get(SESSION_TOKEN_INDEX + tokenHash);
    if (!sessionId) {
      return null;
    }

    const data = await this.redis.get(SESSION_PREFIX + sessionId);
    if (!data) {
      return null;
    }

    const session = JSON.parse(data) as UserSession;
    if (new Date(session.expires_at) < new Date()) {
      await this.delete(token);
      return null;
    }

    const now = new Date();
    const lastSeenAt = new Date(session.last_seen_at);
    if (now.getTime() - lastSeenAt.getTime() > 5 * 60 * 1000) {
      session.last_seen_at = now.toISOString();
    }
    const ttl = await this.redis.ttl(SESSION_PREFIX + sessionId);
    if (ttl > 0) {
      await this.redis.setex(SESSION_PREFIX + sessionId, ttl, JSON.stringify(session));
    } else {
      await this.redis.set(SESSION_PREFIX + sessionId, JSON.stringify(session));
    }

    return session;
  }

  async delete(token: string): Promise<boolean> {
    if (!validateUuid(token)) {
      return false;
    }
    const tokenHash = hashSessionToken(token);
    const sessionId = await this.redis.get(SESSION_TOKEN_INDEX + tokenHash);
    if (!sessionId) {
      return false;
    }
    const data = await this.redis.get(SESSION_PREFIX + sessionId);
    await this.redis.del(SESSION_PREFIX + sessionId);
    await this.redis.del(SESSION_TOKEN_INDEX + tokenHash);
    await this.redis.del(SESSION_TOKEN_HASH_INDEX + sessionId);
    if (data) {
      const session = JSON.parse(data) as UserSession;
      await this.redis.srem(USER_SESSION_INDEX + session.user_id, sessionId);
    }
    return true;
  }

  async elevate(token: string): Promise<{ session: UserSession; token: string } | null> {
    if (!validateUuid(token)) {
      return null;
    }
    const tokenHash = hashSessionToken(token);
    const sessionId = await this.redis.get(SESSION_TOKEN_INDEX + tokenHash);
    if (!sessionId) {
      return null;
    }
    const data = await this.redis.get(SESSION_PREFIX + sessionId);
    if (!data) {
      return null;
    }

    const session = JSON.parse(data) as UserSession;
    if (new Date(session.expires_at) < new Date()) {
      await this.delete(token);
      return null;
    }

    const elevated = await this.create(session.user_id, { isAdmin: true });
    await this.delete(token);
    return elevated;
  }

  async deleteAllByUserId(userId: string): Promise<void> {
    const sessionIds = await this.redis.smembers(USER_SESSION_INDEX + userId);
    if (sessionIds.length === 0) {
      return;
    }
    for (const sessionId of sessionIds) {
      const tokenHash = await this.redis.get(SESSION_TOKEN_HASH_INDEX + sessionId);
      if (tokenHash) {
        await this.redis.del(SESSION_TOKEN_INDEX + tokenHash);
      } else {
        const data = await this.redis.get(SESSION_PREFIX + sessionId);
        if (data) {
          const session = JSON.parse(data) as UserSession;
          await this.redis.del(SESSION_TOKEN_INDEX + hashSessionToken(session.token_id));
        }
      }
      await this.redis.del(SESSION_PREFIX + sessionId);
      await this.redis.del(SESSION_TOKEN_HASH_INDEX + sessionId);
      await this.redis.srem(USER_SESSION_INDEX + userId, sessionId);
    }
    await this.redis.del(USER_SESSION_INDEX + userId);
  }
}

export function createSessionStore(redis?: Redis): SessionStore | undefined {
  if (!redis) {
    return undefined;
  }
  return new RedisSessionStore(redis);
}
