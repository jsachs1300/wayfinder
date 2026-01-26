import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

let createApp: typeof import('../../src/app').createApp;

const encryptionKey = 'a7bc6b8ade99c80ff7e4bb1cecb2d391615630556c0b2a0317c53cf4e45ff91d';

async function setupApp() {
  const result = await createApp();
  return result.app;
}

describe('User Registration Verification Flow', () => {
  beforeAll(async () => {
    process.env.FEATURE_USER_SELF_SERVICE = 'true';
    process.env.LLM_KEY_ENCRYPTION_KEY = encryptionKey;
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    ({ createApp } = await import('../../src/app'));
  });

  afterAll(() => {
    delete process.env.FEATURE_USER_SELF_SERVICE;
    delete process.env.LLM_KEY_ENCRYPTION_KEY;
    delete process.env.NODE_ENV;
  });

  it('should register, verify, complete, and login', async () => {
    const app = await setupApp();
    const email = `user-${Date.now()}@example.com`;

    const register = await request(app)
      .post('/api/users/register')
      .send({ email });

    expect(register.status).toBe(200);
    expect(register.body.message).toContain('verification email');
    expect(register.body.verification_token).toBeDefined();

    const verify = await request(app)
      .post('/api/users/verify-email')
      .send({ token: register.body.verification_token });

    expect(verify.status).toBe(200);
    expect(verify.body.valid).toBe(true);

    const complete = await request(app)
      .post('/api/users/complete-registration')
      .send({
        token: register.body.verification_token,
        password: 'SecurePass123!',
      });

    expect(complete.status).toBe(201);
    expect(complete.body.user.email).toBe(email);
    expect(complete.body.token.token).toBeDefined();

    const login = await request(app)
      .post('/api/users/login')
      .send({ email, password: 'SecurePass123!' });

    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);
  });

  it('should allow password reset after verification', async () => {
    const app = await setupApp();
    const email = `reset-${Date.now()}@example.com`;

    const register = await request(app)
      .post('/api/users/register')
      .send({ email });

    const complete = await request(app)
      .post('/api/users/complete-registration')
      .send({
        token: register.body.verification_token,
        password: 'SecurePass123!',
      });

    expect(complete.status).toBe(201);

    const forgot = await request(app)
      .post('/api/users/password/forgot')
      .send({ email });

    expect(forgot.status).toBe(200);
    expect(forgot.body.reset_token).toBeDefined();

    const validate = await request(app)
      .post('/api/users/password/validate')
      .send({ token: forgot.body.reset_token });

    expect(validate.status).toBe(200);
    expect(validate.body.valid).toBe(true);

    const reset = await request(app)
      .post('/api/users/password/reset')
      .send({
        token: forgot.body.reset_token,
        password: 'NewPass123!',
      });

    expect(reset.status).toBe(200);

    const oldLogin = await request(app)
      .post('/api/users/login')
      .send({ email, password: 'SecurePass123!' });

    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/users/login')
      .send({ email, password: 'NewPass123!' });

    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.email).toBe(email);
  });
});
