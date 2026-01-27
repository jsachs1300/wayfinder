/**
 * User tier levels
 * - free: Limited requests, system pays LLM costs
 * - paid_system: Higher limits, system pays LLM costs
 * - paid_byollm: Highest limits, user pays LLM costs via own keys
 * - admin: Unlimited access (legacy admin tokens)
 */
export type UserTier = 'free' | 'paid_system' | 'paid_byollm' | 'admin';

/**
 * User account status
 */
export type UserStatus = 'active' | 'pending' | 'suspended' | 'deleted';

/**
 * User account model
 */
export interface User {
  /** Unique user identifier (UUID v4) */
  id: string;

  /** User email (unique, lowercase, validated) */
  email: string;

  /** Bcrypt password hash (work factor 12) */
  password_hash: string;

  /** Current user tier */
  tier: UserTier;

  /** Account status */
  status: UserStatus;

  /** Organization ID (reserved for future use) */
  org_id: string | null;

  /** Billing customer ID (reserved for future Stripe integration) */
  billing_customer_id: string | null;

  /** ISO 8601 timestamp */
  created_at: string;

  /** ISO 8601 timestamp */
  updated_at: string;

  /** ISO 8601 timestamp of last login */
  last_login_at: string | null;
}

/**
 * User creation request
 */
export interface UserCreateRequest {
  email: string;
  password: string;
}

export interface UserPendingCreateRequest {
  email: string;
}

/**
 * User authentication response
 */
export interface UserAuthResponse {
  user: {
    id: string;
    email: string;
    tier: UserTier;
    status: UserStatus;
    created_at: string;
  };
  tokens?: Array<{
    id: string;
    name: string | null;
    created_at: string;
    eligible_models?: string[];
  }>;
}

/**
 * User update request (partial)
 */
export interface UserUpdateRequest {
  email?: string;
  password?: string;
  tier?: UserTier;
  status?: UserStatus;
}

/**
 * Anonymous session for progressive registration
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
