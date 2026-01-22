import { createHash } from 'crypto';
import type { Logger } from '../logging/logger';

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function logUserRegistered(logger: Logger, data: { user_id: string; email: string }): void {
  logger.info('User registered event', {
    event_type: 'user_registered',
    timestamp: new Date().toISOString(),
    user_id: data.user_id,
    email_hash: hashEmail(data.email),
  });
}

export function logUserLoggedIn(logger: Logger, data: { user_id: string; email: string }): void {
  logger.info('User logged in event', {
    event_type: 'user_logged_in',
    timestamp: new Date().toISOString(),
    user_id: data.user_id,
    email_hash: hashEmail(data.email),
  });
}

export function logTokenEvent(
  logger: Logger,
  data: {
    event_type: 'token_created' | 'token_deleted' | 'token_rotated';
    token_id: string;
    user_id: string;
    is_primary?: boolean;
    eligible_models?: string[];
  }
): void {
  logger.info('Token lifecycle event', {
    event_type: data.event_type,
    timestamp: new Date().toISOString(),
    token_id: data.token_id,
    user_id: data.user_id,
    is_primary: data.is_primary,
    eligible_models: data.eligible_models,
  });
}

export function logRoutingUsage(
  logger: Logger,
  data: {
    request_id: string | undefined;
    token_id: string;
    user_id?: string;
    token_tier?: string;
    provider?: string;
    router_model_requested?: string;
    router_model_used?: string;
    cache_hit?: boolean;
    llm_call?: boolean;
    llm_latency_ms?: number;
    eligible_models_count?: number;
  }
): void {
  logger.info('Routing usage event', {
    event_type: 'routing_usage',
    timestamp: new Date().toISOString(),
    request_id: data.request_id ?? 'unknown',
    token_id: data.token_id,
    user_id: data.user_id,
    token_tier: data.token_tier,
    provider: data.provider,
    router_model_requested: data.router_model_requested,
    router_model_used: data.router_model_used,
    cache_hit: data.cache_hit ?? false,
    llm_call: data.llm_call ?? false,
    llm_latency_ms: data.llm_latency_ms,
    eligible_models_count: data.eligible_models_count,
  });
}
