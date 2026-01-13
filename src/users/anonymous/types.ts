/**
 * Anonymous Session Types
 *
 * Supports progressive registration: users can start with an anonymous session
 * and later convert to a registered account while preserving their token.
 */

/**
 * Anonymous session for progressive registration
 * Design document section 4.1.4
 */
export interface AnonymousSession {
  /** Session identifier (UUID v4) */
  id: string;

  /** Associated token ID */
  token_id: string;

  /** ISO 8601 timestamp */
  created_at: string;

  /** ISO 8601 expiration (7 days from creation) */
  expires_at: string;

  /** Requests made in this session */
  request_count: number;
}
