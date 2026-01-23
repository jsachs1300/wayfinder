/**
 * User session types
 */

export interface UserSession {
  /** Session identifier (UUID v4) */
  id: string;
  /** Session token identifier (UUID v4) */
  token_id: string;
  /** Associated user ID */
  user_id: string;
  /** Whether session is elevated to admin */
  is_admin: boolean;
  /** Session creation time */
  created_at: string;
  /** Last activity time */
  last_seen_at: string;
  /** Session expiry time */
  expires_at: string;
}
