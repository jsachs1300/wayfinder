import { createHash } from 'crypto';
import {
  logRoutingUsage,
  logTokenEvent,
  logUserLoggedIn,
  logUserRegistered,
} from '../../src/observability/events';

describe('Observability Events', () => {
  const logger = {
    info: vi.fn(),
  };

  beforeEach(() => {
    logger.info.mockClear();
  });

  it('logs user registration events with hashed email', () => {
    logUserRegistered(logger as any, { user_id: 'user-1', email: 'test@example.com' });
    expect(logger.info).toHaveBeenCalledTimes(1);

    const [, metadata] = logger.info.mock.calls[0];
    const expectedHash = createHash('sha256')
      .update('test@example.com')
      .digest('hex');

    expect(metadata.event_type).toBe('user_registered');
    expect(metadata.user_id).toBe('user-1');
    expect(metadata.email_hash).toBe(expectedHash);
  });

  it('logs user login events', () => {
    logUserLoggedIn(logger as any, { user_id: 'user-2', email: 'user@example.com' });
    const [, metadata] = logger.info.mock.calls[0];
    expect(metadata.event_type).toBe('user_logged_in');
    expect(metadata.user_id).toBe('user-2');
  });

  it('logs token lifecycle events', () => {
    logTokenEvent(logger as any, {
      event_type: 'token_created',
      token_id: 'token-1',
      user_id: 'user-3',
      is_primary: true,
      eligible_models: ['gpt-4o-mini'],
    });
    const [, metadata] = logger.info.mock.calls[0];
    expect(metadata.event_type).toBe('token_created');
    expect(metadata.token_id).toBe('token-1');
  });

  it('logs routing usage events', () => {
    logRoutingUsage(logger as any, {
      request_id: 'req-1',
      token_id: 'token-9',
      token_tier: 'paid_system',
      cache_hit: true,
      llm_call: false,
    });
    const [, metadata] = logger.info.mock.calls[0];
    expect(metadata.event_type).toBe('routing_usage');
    expect(metadata.token_id).toBe('token-9');
  });
});
