/**
 * User Authentication Tests
 *
 * Tests for user store, password hashing, and authentication logic
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryUserStore, RedisUserStore } from '../../src/users/store';
import { hashPassword, verifyPassword } from '../../src/users/password';
import Redis from 'ioredis-mock';

describe('User Authentication', () => {
  describe('Password Hashing', () => {
    it('should hash passwords with bcrypt', async () => {
      const password = 'Test Password 123!';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash.startsWith('$2b$')).toBe(true); // bcrypt hash format
    });

    it('should verify correct passwords', async () => {
      const password = 'MySecurePass123!';
      const hash = await hashPassword(password);
      const isValid = await verifyPassword(password, hash);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect passwords', async () => {
      const password = 'MySecurePass123!';
      const hash = await hashPassword(password);
      const isValid = await verifyPassword('WrongPassword', hash);

      expect(isValid).toBe(false);
    });

    it('should use constant-time comparison', async () => {
      const password = 'TestPass123!';
      const hash = await hashPassword(password);

      // Timing should be similar for correct and incorrect passwords
      const start1 = Date.now();
      await verifyPassword(password, hash);
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      await verifyPassword('Wrong', hash);
      const time2 = Date.now() - start2;

      // Both should take similar time (within 300ms tolerance)
      expect(Math.abs(time1 - time2)).toBeLessThan(300);
    });
  });

  describe('InMemoryUserStore', () => {
    let store: InMemoryUserStore;

    beforeEach(() => {
      store = new InMemoryUserStore();
    });

    describe('User Creation', () => {
      it('should create user with hashed password', async () => {
        const email = 'test@example.com';
        const password = 'SecurePass123!';

        const user = await store.create({ email, password });

        expect(user.id).toBeDefined();
        expect(user.email).toBe(email.toLowerCase());
        expect(user.password_hash).toBeDefined();
        expect(user.password_hash).not.toBe(password);
        expect(user.password_hash.startsWith('$2b$')).toBe(true);
        expect(user.tier).toBe('free');
        expect(user.status).toBe('active');
      });

      it('should prevent duplicate emails', async () => {
        const email = 'duplicate@example.com';
        await store.create({ email, password: 'Pass123!' });

        await expect(
          store.create({ email, password: 'Pass456!' })
        ).rejects.toThrow('Email already registered');
      });

      it('should normalize emails to lowercase', async () => {
        const user = await store.create({
          email: 'Test@EXAMPLE.COM',
          password: 'Pass123!',
        });

        expect(user.email).toBe('test@example.com');
      });

      it('should trim email whitespace', async () => {
        const user = await store.create({
          email: '  user@example.com  ',
          password: 'Pass123!',
        });

        expect(user.email).toBe('user@example.com');
      });
    });

    describe('User Authentication', () => {
      it('should authenticate with correct password', async () => {
        const email = 'auth@example.com';
        const password = 'MyPassword123!';

        await store.create({ email, password });
        const user = await store.authenticate(email, password);

        expect(user).not.toBeNull();
        expect(user?.email).toBe(email);
        expect(user?.last_login_at).toBeDefined();
      });

      it('should reject incorrect password', async () => {
        const email = 'auth@example.com';
        await store.create({ email, password: 'CorrectPass123!' });

        const user = await store.authenticate(email, 'WrongPass123!');

        expect(user).toBeNull();
      });

      it('should reject non-existent email', async () => {
        const user = await store.authenticate('nonexistent@example.com', 'Pass123!');

        expect(user).toBeNull();
      });

      it('should update last_login_at on successful auth', async () => {
        const email = 'login@example.com';
        const password = 'Pass123!';

        const created = await store.create({ email, password });
        expect(created.last_login_at).toBeNull();

        // Wait a tiny bit to ensure timestamp changes
        await new Promise(resolve => setTimeout(resolve, 10));

        const authenticated = await store.authenticate(email, password);

        expect(authenticated).not.toBeNull();
        expect(authenticated!.last_login_at).not.toBeNull();
        expect(authenticated!.last_login_at).not.toBe(created.created_at);
      });

      it('should be case-insensitive for email', async () => {
        const password = 'Pass123!';
        await store.create({ email: 'user@example.com', password });

        const user = await store.authenticate('USER@EXAMPLE.COM', password);

        expect(user).not.toBeNull();
        expect(user?.email).toBe('user@example.com');
      });
    });

    describe('User Updates', () => {
      it('should update password with new hash', async () => {
        const user = await store.create({
          email: 'update@example.com',
          password: 'OldPass123!',
        });

        const updated = await store.update(user.id, {
          password: 'NewPass456!',
        });

        expect(updated).not.toBeNull();
        expect(updated!.password_hash).not.toBe(user.password_hash);

        // Old password should not work
        const authOld = await store.authenticate(user.email, 'OldPass123!');
        expect(authOld).toBeNull();

        // New password should work
        const authNew = await store.authenticate(user.email, 'NewPass456!');
        expect(authNew).not.toBeNull();
      });

      it('should update email and maintain unique constraint', async () => {
        const user = await store.create({
          email: 'old@example.com',
          password: 'Pass123!',
        });

        const updated = await store.update(user.id, {
          email: 'new@example.com',
        });

        expect(updated!.email).toBe('new@example.com');

        // Old email should no longer work
        const byOldEmail = await store.getByEmail('old@example.com');
        expect(byOldEmail).toBeNull();

        // New email should work
        const byNewEmail = await store.getByEmail('new@example.com');
        expect(byNewEmail).not.toBeNull();
        expect(byNewEmail!.id).toBe(user.id);
      });

      it('should prevent email conflicts on update', async () => {
        await store.create({ email: 'user1@example.com', password: 'Pass123!' });
        const user2 = await store.create({ email: 'user2@example.com', password: 'Pass123!' });

        await expect(
          store.update(user2.id, { email: 'user1@example.com' })
        ).rejects.toThrow('Email already registered');
      });

      it('should update tier', async () => {
        const user = await store.create({
          email: 'tier@example.com',
          password: 'Pass123!',
        });

        expect(user.tier).toBe('free');

        const updated = await store.updateTier(user.id, 'paid_byollm');

        expect(updated!.tier).toBe('paid_byollm');
      });
    });

    describe('User Retrieval', () => {
      it('should get user by ID', async () => {
        const created = await store.create({
          email: 'getid@example.com',
          password: 'Pass123!',
        });

        const retrieved = await store.getById(created.id);

        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(created.id);
        expect(retrieved!.email).toBe(created.email);
      });

      it('should get user by email', async () => {
        const created = await store.create({
          email: 'getemail@example.com',
          password: 'Pass123!',
        });

        const retrieved = await store.getByEmail('getemail@example.com');

        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(created.id);
      });

      it('should return null for non-existent ID', async () => {
        const user = await store.getById('non-existent-id');
        expect(user).toBeNull();
      });

      it('should return null for non-existent email', async () => {
        const user = await store.getByEmail('nonexistent@example.com');
        expect(user).toBeNull();
      });
    });
  });

  describe('RedisUserStore', () => {
    let store: RedisUserStore;
    let redis: Redis;

    beforeEach(() => {
      redis = new Redis();
      store = new RedisUserStore(redis);
    });

    it('should create and authenticate user', async () => {
      const email = 'redis@example.com';
      const password = 'RedisPass123!';

      const created = await store.create({ email, password });
      expect(created.email).toBe(email);

      const authenticated = await store.authenticate(email, password);
      expect(authenticated).not.toBeNull();
      expect(authenticated!.email).toBe(email);
    });

    it('should prevent duplicate emails', async () => {
      const email = 'duplicate@example.com';
      await store.create({ email, password: 'Pass123!' });

      await expect(
        store.create({ email, password: 'Pass456!' })
      ).rejects.toThrow('Email already registered');
    });

    it('should update user correctly', async () => {
      const user = await store.create({
        email: 'update@example.com',
        password: 'OldPass123!',
      });

      const updated = await store.update(user.id, {
        email: 'updated@example.com',
        password: 'NewPass456!',
      });

      expect(updated!.email).toBe('updated@example.com');

      // Authenticate with new credentials
      const authenticated = await store.authenticate('updated@example.com', 'NewPass456!');
      expect(authenticated).not.toBeNull();

      // Old credentials should fail
      const authOld = await store.authenticate('update@example.com', 'OldPass123!');
      expect(authOld).toBeNull();
    });
  });
});
