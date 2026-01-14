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

  /** Whether this is the user's primary/default token */
  is_primary?: boolean;

  /** Anonymous session ID (for progressive registration) */
  anonymous_session_id?: string | null;
}
