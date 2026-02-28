/**
 * User storage interface and implementations
 */

import { User, UserCreateRequest, UserPendingCreateRequest, UserUpdateRequest, UserTier, UserStatus } from './types';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { verifyPassword, hashPassword, DUMMY_PASSWORD_HASH } from './password';
import { assertRedisExecResults } from '../redis/exec';

const USER_PREFIX = 'wayfinder:user:';
const USER_EMAIL_INDEX = 'wayfinder:user:email:';
const USER_INDEX_KEY = 'wayfinder:user:index';

/**
 * Hash email for index lookup
 * Normalizes to lowercase and hashes with SHA256
 */
function hashEmail(email: string): string {
  const normalized = email.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * User storage interface
 */
export interface UserStore {
  /**
   * Create a new user
   */
  create(request: UserCreateRequest): Promise<User>;

  /**
   * Create a new pending user (email-only registration)
   */
  createPending(request: UserPendingCreateRequest): Promise<User>;

  /**
   * Get user by ID
   */
  getById(id: string): Promise<User | null>;

  /**
   * Get user by email
   */
  getByEmail(email: string): Promise<User | null>;

  /**
   * Authenticate user with email and password
   * Returns user on success, null on failure
   */
  authenticate(email: string, password: string): Promise<User | null>;

  /**
   * Update user (partial update)
   */
  update(id: string, request: UserUpdateRequest): Promise<User | null>;

  /**
   * Update user tier
   */
  updateTier(id: string, tier: UserTier): Promise<User | null>;

  /**
   * Update user status
   */
  updateStatus(id: string, status: UserStatus): Promise<User | null>;

  /**
   * List all users
   */
  list(): Promise<User[]>;
}

/**
 * In-memory user store for development and testing
 */
export class InMemoryUserStore implements UserStore {
  private users: Map<string, User> = new Map();
  private emailIndex: Map<string, string> = new Map();

  async create(request: UserCreateRequest): Promise<User> {
    const id = uuidv4();
    const emailHash = hashEmail(request.email);
    const now = new Date().toISOString();

    // Check for duplicate email
    if (this.emailIndex.has(emailHash)) {
      throw new Error('Email already registered');
    }

    // Hash password internally for security
    const password_hash = await hashPassword(request.password);

    const user: User = {
      id,
      email: request.email.toLowerCase().trim(),
      password_hash,
      tier: 'free',
      status: 'active',
      org_id: null,
      billing_customer_id: null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    };

    this.users.set(id, user);
    this.emailIndex.set(emailHash, id);

    return user;
  }

  async createPending(request: UserPendingCreateRequest): Promise<User> {
    const id = uuidv4();
    const emailHash = hashEmail(request.email);
    const now = new Date().toISOString();

    if (this.emailIndex.has(emailHash)) {
      throw new Error('Email already registered');
    }

    const password_hash = DUMMY_PASSWORD_HASH;

    const user: User = {
      id,
      email: request.email.toLowerCase().trim(),
      password_hash,
      tier: 'free',
      status: 'pending',
      org_id: null,
      billing_customer_id: null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    };

    this.users.set(id, user);
    this.emailIndex.set(emailHash, id);

    return user;
  }

  async getById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const emailHash = hashEmail(email);
    const id = this.emailIndex.get(emailHash);
    if (!id) return null;
    return this.users.get(id) ?? null;
  }

  async authenticate(email: string, password: string): Promise<User | null> {
    const user = await this.getByEmail(email);
    if (!user) return null;

    // Use constant-time bcrypt comparison
    const isValid = await verifyPassword(password, user.password_hash);
    if (isValid) {
      // Update last_login_at
      user.last_login_at = new Date().toISOString();
      user.updated_at = user.last_login_at;
      return user;
    }

    return null;
  }

  async update(id: string, request: UserUpdateRequest): Promise<User | null> {
    const existing = this.users.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();

    // If email is being updated, check for conflicts and update index
    if (request.email && request.email !== existing.email) {
      const newEmailHash = hashEmail(request.email);
      if (this.emailIndex.has(newEmailHash)) {
        throw new Error('Email already registered');
      }
      const oldEmailHash = hashEmail(existing.email);
      this.emailIndex.delete(oldEmailHash);
      this.emailIndex.set(newEmailHash, id);
    }

    // Hash password if being updated
    const password_hash = request.password
      ? await hashPassword(request.password)
      : existing.password_hash;

    const updated: User = {
      ...existing,
      email: request.email?.toLowerCase().trim() ?? existing.email,
      password_hash,
      tier: request.tier ?? existing.tier,
      status: request.status ?? existing.status,
      updated_at: now,
    };

    this.users.set(id, updated);
    return updated;
  }

  async updateTier(id: string, tier: UserTier): Promise<User | null> {
    return this.update(id, { tier });
  }

  async updateStatus(id: string, status: UserStatus): Promise<User | null> {
    return this.update(id, { status });
  }

  async list(): Promise<User[]> {
    return Array.from(this.users.values());
  }
}

/**
 * Redis-backed user store for production
 */
export class RedisUserStore implements UserStore {
  private redis: Redis;
  private static readonly MAX_WRITE_RETRIES = 5;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private static isAlreadyConnectedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return error.message.includes('already connecting/connected');
  }

  private async withIsolatedTransactionClient<T>(
    operation: (client: Redis) => Promise<T>
  ): Promise<T> {
    const client = this.redis.duplicate();
    if (client.status === 'wait') {
      try {
        await client.connect();
      } catch (error) {
        if (!RedisUserStore.isAlreadyConnectedError(error)) {
          throw error;
        }
      }
    }
    try {
      return await operation(client);
    } finally {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }

  async create(request: UserCreateRequest): Promise<User> {
    const emailHash = hashEmail(request.email);
    const password_hash = await hashPassword(request.password);
    const emailIndexKey = USER_EMAIL_INDEX + emailHash;

    return this.withIsolatedTransactionClient(async (txRedis) => {
      for (let attempt = 1; attempt <= RedisUserStore.MAX_WRITE_RETRIES; attempt += 1) {
        const created = await (async () => {
          await txRedis.watch(emailIndexKey);
          try {
            const existingId = await txRedis.get(emailIndexKey);
            if (existingId) {
              throw new Error('Email already registered');
            }

            const id = uuidv4();
            const now = new Date().toISOString();
            const user: User = {
              id,
              email: request.email.toLowerCase().trim(),
              password_hash,
              tier: 'free',
              status: 'active',
              org_id: null,
              billing_customer_id: null,
              created_at: now,
              updated_at: now,
              last_login_at: null,
            };

            const tx = txRedis.multi();
            tx.set(USER_PREFIX + id, JSON.stringify(user));
            tx.set(emailIndexKey, id);
            tx.sadd(USER_INDEX_KEY, id);
            const result = await tx.exec();

            if (result === null) {
              return null;
            }

            assertRedisExecResults(result, 'users.create');
            return user;
          } finally {
            await txRedis.unwatch();
          }
        })();

        if (created) {
          return created;
        }
      }

      throw new Error('Failed to create user due to concurrent modification');
    });
  }

  async createPending(request: UserPendingCreateRequest): Promise<User> {
    const emailHash = hashEmail(request.email);
    const password_hash = DUMMY_PASSWORD_HASH;
    const emailIndexKey = USER_EMAIL_INDEX + emailHash;

    return this.withIsolatedTransactionClient(async (txRedis) => {
      for (let attempt = 1; attempt <= RedisUserStore.MAX_WRITE_RETRIES; attempt += 1) {
        const created = await (async () => {
          await txRedis.watch(emailIndexKey);
          try {
            const existingId = await txRedis.get(emailIndexKey);
            if (existingId) {
              throw new Error('Email already registered');
            }

            const id = uuidv4();
            const now = new Date().toISOString();
            const user: User = {
              id,
              email: request.email.toLowerCase().trim(),
              password_hash,
              tier: 'free',
              status: 'pending',
              org_id: null,
              billing_customer_id: null,
              created_at: now,
              updated_at: now,
              last_login_at: null,
            };

            const tx = txRedis.multi();
            tx.set(USER_PREFIX + id, JSON.stringify(user));
            tx.set(emailIndexKey, id);
            tx.sadd(USER_INDEX_KEY, id);
            const result = await tx.exec();

            if (result === null) {
              return null;
            }

            assertRedisExecResults(result, 'users.createPending');
            return user;
          } finally {
            await txRedis.unwatch();
          }
        })();

        if (created) {
          return created;
        }
      }

      throw new Error('Failed to create pending user due to concurrent modification');
    });
  }

  async getById(id: string): Promise<User | null> {
    const data = await this.redis.get(USER_PREFIX + id);
    if (!data) return null;
    return JSON.parse(data) as User;
  }

  async getByEmail(email: string): Promise<User | null> {
    const emailHash = hashEmail(email);
    const id = await this.redis.get(USER_EMAIL_INDEX + emailHash);
    if (!id) return null;
    return this.getById(id);
  }

  async authenticate(email: string, password: string): Promise<User | null> {
    const user = await this.getByEmail(email);
    if (!user) return null;

    // Use constant-time bcrypt comparison
    const isValid = await verifyPassword(password, user.password_hash);
    if (isValid) {
      // Update last_login_at
      const now = new Date().toISOString();
      user.last_login_at = now;
      user.updated_at = now;
      await this.redis.set(USER_PREFIX + user.id, JSON.stringify(user));
      return user;
    }

    return null;
  }

  async update(id: string, request: UserUpdateRequest): Promise<User | null> {
    const normalizedEmail = request.email?.toLowerCase().trim();
    const passwordHash = request.password ? await hashPassword(request.password) : undefined;
    const userKey = USER_PREFIX + id;

    return this.withIsolatedTransactionClient(async (txRedis) => {
      for (let attempt = 1; attempt <= RedisUserStore.MAX_WRITE_RETRIES; attempt += 1) {
        const outcome = await (async () => {
          await txRedis.watch(userKey);
          try {
            const existingRaw = await txRedis.get(userKey);
            if (!existingRaw) {
              return { kind: 'not_found' } as const;
            }
            const existing = JSON.parse(existingRaw) as User;

            const oldEmailHash = hashEmail(existing.email);
            const newEmailHash = normalizedEmail ? hashEmail(normalizedEmail) : oldEmailHash;
            const newEmailKey = USER_EMAIL_INDEX + newEmailHash;
            const oldEmailKey = USER_EMAIL_INDEX + oldEmailHash;

            await txRedis.watch(newEmailKey, oldEmailKey);
            if (newEmailHash !== oldEmailHash) {
              const existingId = await txRedis.get(newEmailKey);
              if (existingId && existingId !== id) {
                throw new Error('Email already registered');
              }
            }

            const now = new Date().toISOString();
            const updated: User = {
              ...existing,
              email: normalizedEmail ?? existing.email,
              password_hash: passwordHash ?? existing.password_hash,
              tier: request.tier ?? existing.tier,
              status: request.status ?? existing.status,
              updated_at: now,
            };

            const tx = txRedis.multi();
            tx.set(userKey, JSON.stringify(updated));
            if (newEmailHash !== oldEmailHash) {
              tx.del(oldEmailKey);
              tx.set(newEmailKey, id);
            }
            const result = await tx.exec();

            if (result === null) {
              return { kind: 'retry' } as const;
            }
            assertRedisExecResults(result, 'users.update');
            return { kind: 'updated', user: updated } as const;
          } finally {
            await txRedis.unwatch();
          }
        })();

        if (outcome.kind === 'updated') {
          return outcome.user;
        }
        if (outcome.kind === 'not_found') {
          return null;
        }
      }

      throw new Error('Failed to update user due to concurrent modification');
    });
  }

  async updateTier(id: string, tier: UserTier): Promise<User | null> {
    return this.update(id, { tier });
  }

  async updateStatus(id: string, status: UserStatus): Promise<User | null> {
    return this.update(id, { status });
  }

  async list(): Promise<User[]> {
    const ids = await this.redis.smembers(USER_INDEX_KEY);
    if (ids.length === 0) return [];

    const pipeline = this.redis.multi();
    ids.forEach(id => pipeline.get(USER_PREFIX + id));
    const results = assertRedisExecResults(await pipeline.exec(), 'users.list');

    const users: User[] = [];
    results?.forEach(result => {
      const [, data] = result ?? [];
      if (typeof data === 'string') {
        users.push(JSON.parse(data) as User);
      }
    });

    return users;
  }
}

/**
 * Create appropriate user store based on environment
 */
export function createUserStore(redis?: Redis): UserStore {
  if (redis) {
    return new RedisUserStore(redis);
  }
  return new InMemoryUserStore();
}
