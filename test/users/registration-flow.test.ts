import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createUserRoutes } from '../../src/users/routes';
import { InMemoryUserStore } from '../../src/users/store';
import { InMemoryTokenStore } from '../../src/tokens/store';
import { InMemoryUserVerificationStore } from '../../src/users/verification-store';
import { createLogger } from '../../src/logging';
import { createModelRegistry } from '../../src/models';

describe('User Registration Verification Flow', () => {
  let app: express.Express;

  beforeEach(() => {
    const logger = createLogger('error');
    const userStore = new InMemoryUserStore();
    const tokenStore = new InMemoryTokenStore();
    const verificationStore = new InMemoryUserVerificationStore();
    const modelRegistry = createModelRegistry();

    const router = createUserRoutes(
      userStore,
      tokenStore,
      modelRegistry,
      logger,
      verificationStore
    );

    app = express();
    app.use(express.json());
    app.use('/api/users', router);
  });

  it('should register, verify, complete, and login', async () => {
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
