/**
 * Anonymous Session Module
 *
 * Exports types and store for anonymous session management.
 */

export type { AnonymousSession } from './types';
export type { AnonymousSessionStore } from './store';
export {
  InMemoryAnonymousSessionStore,
  RedisAnonymousSessionStore,
  createAnonymousSessionStore,
} from './store';
