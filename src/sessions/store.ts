/**
 * User Session Store (Redis-backed)
 *
 * Sessions are required for frontend login flows and admin elevation.
 * All session data is stored in Redis.
 */

import { v4 as uuidv4 } from 'uuid';
import type Redis from 'ioredis';
import type { UserSession } from './types';
import { createHash } from 'crypto';

const SESSION_PREFIX = 'wayfinder:session:';
const SESSION_TOKEN_INDEX = 'wayfinder:session:token:';

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
  create(userId: string): Promise<{ session: UserSession; token: string }>;
  getByToken(token: string): Promise<UserSession | null>;
  delete(token: string): Promise<boolean>;
  elevate(token: string): Promise<UserSession | null>;
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(userId: string): Promise<{ session: UserSession; token: string }> {
    const sessionId = uuidv4();
    const tokenId = uuidv4();
    const now = new Date();
    const ttlDays = getSessionTTLDays();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const session: UserSession = {
      id: sessionId,
      token_id: tokenId,
      user_id: userId,
      is_admin: false,
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
      SESSION_TOKEN_INDEX + tokenHash,
      ttlSeconds,
      sessionId
    );

    return { session, token: tokenId };
  }

  async getByToken(token: string): Promise<UserSession | null> {
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

    session.last_seen_at = new Date().toISOString();
    const ttl = await this.redis.ttl(SESSION_PREFIX + sessionId);
    if (ttl > 0) {
      await this.redis.setex(SESSION_PREFIX + sessionId, ttl, JSON.stringify(session));
    } else {
      await this.redis.set(SESSION_PREFIX + sessionId, JSON.stringify(session));
    }

    return session;
  }

  async delete(token: string): Promise<boolean> {
    const tokenHash = hashSessionToken(token);
    const sessionId = await this.redis.get(SESSION_TOKEN_INDEX + tokenHash);
    if (!sessionId) {
      return false;
    }
    await this.redis.del(SESSION_PREFIX + sessionId);
    await this.redis.del(SESSION_TOKEN_INDEX + tokenHash);
    return true;
  }

  async elevate(token: string): Promise<UserSession | null> {
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
    session.is_admin = true;
    session.last_seen_at = new Date().toISOString();

    const ttl = await this.redis.ttl(SESSION_PREFIX + sessionId);
    if (ttl > 0) {
      await this.redis.setex(SESSION_PREFIX + sessionId, ttl, JSON.stringify(session));
    } else {
      await this.redis.set(SESSION_PREFIX + sessionId, JSON.stringify(session));
    }

    return session;
  }
}

export function createSessionStore(redis?: Redis): SessionStore | undefined {
  if (!redis) {
    return undefined;
  }
  return new RedisSessionStore(redis);
}
