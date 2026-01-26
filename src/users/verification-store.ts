import type Redis from 'ioredis';
import { createHash, randomBytes } from 'crypto';

export interface VerificationRecord {
  user_id: string;
  email: string;
  created_at: string;
  expires_at: string;
}

export interface UserVerificationStore {
  createEmailVerification(userId: string, email: string, ttlSeconds?: number): Promise<string>;
  getEmailVerification(token: string): Promise<VerificationRecord | null>;
  consumeEmailVerification(token: string): Promise<VerificationRecord | null>;
  createPasswordReset(userId: string, email: string, ttlSeconds?: number): Promise<string>;
  getPasswordReset(token: string): Promise<VerificationRecord | null>;
  consumePasswordReset(token: string): Promise<VerificationRecord | null>;
}

const VERIFY_TOKEN_PREFIX = 'wayfinder:verify:token:';
const VERIFY_USER_PREFIX = 'wayfinder:verify:user:';
const RESET_TOKEN_PREFIX = 'wayfinder:reset:token:';
const RESET_USER_PREFIX = 'wayfinder:reset:user:';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function computeExpiry(ttlSeconds: number): { createdAt: string; expiresAt: string } {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  return { createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

export class InMemoryUserVerificationStore implements UserVerificationStore {
  private verifyTokens = new Map<string, VerificationRecord>();
  private resetTokens = new Map<string, VerificationRecord>();
  private userVerifyIndex = new Map<string, string>();
  private userResetIndex = new Map<string, string>();

  async createEmailVerification(userId: string, email: string, ttlSeconds = 86400): Promise<string> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const { createdAt, expiresAt } = computeExpiry(ttlSeconds);

    const existing = this.userVerifyIndex.get(userId);
    if (existing) {
      this.verifyTokens.delete(existing);
    }

    const record: VerificationRecord = {
      user_id: userId,
      email,
      created_at: createdAt,
      expires_at: expiresAt,
    };

    this.verifyTokens.set(tokenHash, record);
    this.userVerifyIndex.set(userId, tokenHash);
    return token;
  }

  async getEmailVerification(token: string): Promise<VerificationRecord | null> {
    const record = this.verifyTokens.get(hashToken(token));
    if (!record) return null;
    if (Date.parse(record.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }

  async consumeEmailVerification(token: string): Promise<VerificationRecord | null> {
    const tokenHash = hashToken(token);
    const record = await this.getEmailVerification(token);
    if (!record) return null;
    this.verifyTokens.delete(tokenHash);
    this.userVerifyIndex.delete(record.user_id);
    return record;
  }

  async createPasswordReset(userId: string, email: string, ttlSeconds = 1800): Promise<string> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const { createdAt, expiresAt } = computeExpiry(ttlSeconds);

    const existing = this.userResetIndex.get(userId);
    if (existing) {
      this.resetTokens.delete(existing);
    }

    const record: VerificationRecord = {
      user_id: userId,
      email,
      created_at: createdAt,
      expires_at: expiresAt,
    };

    this.resetTokens.set(tokenHash, record);
    this.userResetIndex.set(userId, tokenHash);
    return token;
  }

  async getPasswordReset(token: string): Promise<VerificationRecord | null> {
    const record = this.resetTokens.get(hashToken(token));
    if (!record) return null;
    if (Date.parse(record.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }

  async consumePasswordReset(token: string): Promise<VerificationRecord | null> {
    const tokenHash = hashToken(token);
    const record = await this.getPasswordReset(token);
    if (!record) return null;
    this.resetTokens.delete(tokenHash);
    this.userResetIndex.delete(record.user_id);
    return record;
  }
}

export class RedisUserVerificationStore implements UserVerificationStore {
  constructor(private readonly redis: Redis) {}

  async createEmailVerification(userId: string, email: string, ttlSeconds = 86400): Promise<string> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const { createdAt, expiresAt } = computeExpiry(ttlSeconds);
    const record: VerificationRecord = {
      user_id: userId,
      email,
      created_at: createdAt,
      expires_at: expiresAt,
    };

    const existing = await this.redis.get(VERIFY_USER_PREFIX + userId);
    if (existing) {
      await this.redis.del(VERIFY_TOKEN_PREFIX + existing);
    }

    const pipeline = this.redis.multi();
    pipeline.setex(VERIFY_TOKEN_PREFIX + tokenHash, ttlSeconds, JSON.stringify(record));
    pipeline.setex(VERIFY_USER_PREFIX + userId, ttlSeconds, tokenHash);
    await pipeline.exec();

    return token;
  }

  async getEmailVerification(token: string): Promise<VerificationRecord | null> {
    const tokenHash = hashToken(token);
    const data = await this.redis.get(VERIFY_TOKEN_PREFIX + tokenHash);
    if (!data) return null;
    const record = JSON.parse(data) as VerificationRecord;
    if (Date.parse(record.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }

  async consumeEmailVerification(token: string): Promise<VerificationRecord | null> {
    const tokenHash = hashToken(token);
    const script = `
      local record = redis.call('GET', KEYS[1])
      if not record then
        return nil
      end
      local decoded = cjson.decode(record)
      if decoded and decoded.user_id then
        redis.call('DEL', ARGV[1] .. decoded.user_id)
      end
      redis.call('DEL', KEYS[1])
      return record
    `;
    const tokenKey = VERIFY_TOKEN_PREFIX + tokenHash;
    const recordJson = await this.redis.eval(script, 1, tokenKey, VERIFY_USER_PREFIX);
    if (!recordJson || typeof recordJson !== 'string') {
      return null;
    }
    const record = JSON.parse(recordJson) as VerificationRecord;
    if (Date.parse(record.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }

  async createPasswordReset(userId: string, email: string, ttlSeconds = 1800): Promise<string> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const { createdAt, expiresAt } = computeExpiry(ttlSeconds);
    const record: VerificationRecord = {
      user_id: userId,
      email,
      created_at: createdAt,
      expires_at: expiresAt,
    };

    const existing = await this.redis.get(RESET_USER_PREFIX + userId);
    if (existing) {
      await this.redis.del(RESET_TOKEN_PREFIX + existing);
    }

    const pipeline = this.redis.multi();
    pipeline.setex(RESET_TOKEN_PREFIX + tokenHash, ttlSeconds, JSON.stringify(record));
    pipeline.setex(RESET_USER_PREFIX + userId, ttlSeconds, tokenHash);
    await pipeline.exec();

    return token;
  }

  async getPasswordReset(token: string): Promise<VerificationRecord | null> {
    const tokenHash = hashToken(token);
    const data = await this.redis.get(RESET_TOKEN_PREFIX + tokenHash);
    if (!data) return null;
    const record = JSON.parse(data) as VerificationRecord;
    if (Date.parse(record.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }

  async consumePasswordReset(token: string): Promise<VerificationRecord | null> {
    const tokenHash = hashToken(token);
    const script = `
      local record = redis.call('GET', KEYS[1])
      if not record then
        return nil
      end
      local decoded = cjson.decode(record)
      if decoded and decoded.user_id then
        redis.call('DEL', ARGV[1] .. decoded.user_id)
      end
      redis.call('DEL', KEYS[1])
      return record
    `;
    const tokenKey = RESET_TOKEN_PREFIX + tokenHash;
    const recordJson = await this.redis.eval(script, 1, tokenKey, RESET_USER_PREFIX);
    if (!recordJson || typeof recordJson !== 'string') {
      return null;
    }
    const record = JSON.parse(recordJson) as VerificationRecord;
    if (Date.parse(record.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }
}

export function createUserVerificationStore(redis?: Redis): UserVerificationStore {
  if (redis) {
    return new RedisUserVerificationStore(redis);
  }
  return new InMemoryUserVerificationStore();
}
