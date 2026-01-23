import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { RedisSessionStore } from '../../src/sessions/store';

describe('SessionStore', () => {
  let redis: Redis;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = new Redis();
    store = new RedisSessionStore(redis as unknown as any);
  });

  it('creates and fetches a session by token', async () => {
    const { session, token } = await store.create('user-1');
    const fetched = await store.getByToken(token);

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.user_id).toBe('user-1');
  });

  it('deletes a session by token', async () => {
    const { token } = await store.create('user-2');
    const deleted = await store.delete(token);
    const fetched = await store.getByToken(token);

    expect(deleted).toBe(true);
    expect(fetched).toBeNull();
  });

  it('elevates by issuing a new admin session', async () => {
    const { token } = await store.create('user-3');
    const elevated = await store.elevate(token);

    expect(elevated).not.toBeNull();
    expect(elevated?.session.is_admin).toBe(true);
    expect(elevated?.token).not.toBe(token);

    const oldSession = await store.getByToken(token);
    expect(oldSession).toBeNull();
  });

  it('invalidates all sessions for a user', async () => {
    const { token: token1 } = await store.create('user-4');
    const { token: token2 } = await store.create('user-4');

    await store.deleteAllByUserId('user-4');

    expect(await store.getByToken(token1)).toBeNull();
    expect(await store.getByToken(token2)).toBeNull();
  });

  it('rejects invalid session tokens', async () => {
    const fetched = await store.getByToken('not-a-uuid');
    expect(fetched).toBeNull();
  });
});
