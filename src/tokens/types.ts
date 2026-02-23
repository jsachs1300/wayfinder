/**
 * Token-specific type definitions
 * Extends core TokenConfig from types/index.ts with user association
 */

import { TokenConfig } from '../types';

/**
 * Extended TokenConfig with user association
 * Extends existing TokenConfig from src/types/index.ts
 *
 * user_id is optional for backward compatibility with legacy admin-created tokens
 */
export interface TokenConfigExtended extends TokenConfig {
  /** Associated user ID (null for legacy admin-created tokens) */
  user_id?: string | null;

  /** Token name/label for user identification */
  name?: string | null;

  /** Anonymous session ID (for progressive registration) */
  anonymous_session_id?: string | null;
}

type TokenConfigWithOptionalUserId = TokenConfig & {
  user_id?: string | null;
};

export function hasTokenUserId(
  tokenConfig: TokenConfigWithOptionalUserId
): tokenConfig is TokenConfigExtended & { user_id: string } {
  const userId = tokenConfig.user_id;
  return typeof userId === 'string' && userId.length > 0;
}

export function getTokenUserId(tokenConfig: TokenConfigWithOptionalUserId): string | undefined {
  return hasTokenUserId(tokenConfig) ? tokenConfig.user_id : undefined;
}
