# Design Document: User Authentication and BYOLLM Feature

**Feature ID:** AUTH-BYOLLM-001
**Priority:** P0
**Designer:** Design Agent
**Date:** 2026-01-12
**Status:** Design Complete - Ready for Implementation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Requirements Mapping](#2-requirements-mapping)
3. [System Architecture](#3-system-architecture)
4. [Data Models](#4-data-models)
5. [API Endpoints](#5-api-endpoints)
6. [Database Schema (Redis)](#6-database-schema-redis)
7. [Security Specifications](#7-security-specifications)
8. [Rate Limiting Strategy](#8-rate-limiting-strategy)
9. [BYOLLM Integration](#9-byollm-integration)
10. [Error Handling](#10-error-handling)
11. [Testing Requirements](#11-testing-requirements)
12. [Implementation Tasks](#12-implementation-tasks)
13. [Migration Plan](#13-migration-plan)
14. [Configuration](#14-configuration)
15. [Open Questions](#15-open-questions)

---

## 1. Executive Summary

This design introduces a self-service user authentication system for Wayfinder that supports three user tiers: Free, Paid (System LLM), and Paid (BYOLLM). The system enables users to create accounts, manage API tokens, and optionally configure their own LLM API keys for routing requests.

**Scope:**
- User registration and authentication via API keys
- Progressive registration (anonymous to registered)
- Three-tier user model with different rate limits
- BYOLLM: Users can configure OpenAI and/or Gemini API keys
- Encrypted storage of user LLM API keys
- Tier-based rate limiting

**Out of Scope:**
- Payment/billing integration (schema designed for future support)
- OAuth/SSO authentication
- Organization/team management (schema includes org_id for future)
- Admin user management UI
- Email verification/notifications

**Dependencies:**
- Existing token system (graceful coexistence)
- Redis for storage
- AES-256 encryption library

**Estimated Complexity:** High

---

## 2. Requirements Mapping

### Primary Requirements

| Requirement | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| REQ-AUTH-001 | User Registration | Users can create accounts with email/password |
| REQ-AUTH-002 | API Key Authentication | All requests authenticated via API keys |
| REQ-AUTH-003 | Progressive Registration | Anonymous users can start, then register |
| REQ-TIER-001 | Three User Tiers | Free, Paid (System), Paid (BYOLLM) |
| REQ-TIER-002 | Tier-based Rate Limits | Different limits per tier |
| REQ-BYOLLM-001 | User LLM Keys | Users can configure own LLM API keys |
| REQ-BYOLLM-002 | Key Encryption | LLM keys encrypted at rest (AES-256) |
| REQ-BYOLLM-003 | Multi-provider Support | Support OpenAI + Gemini keys |
| REQ-COMPAT-001 | Backward Compatibility | Existing admin tokens continue working |

### Compliance Checklist

- [ ] Adheres to existing REQUIREMENTS.md (routing decisions from router LLM only)
- [ ] Does not modify core routing logic
- [ ] Maintains policy-as-constraint model
- [ ] Preserves deterministic behavior
- [ ] Integrates with existing token system

---

## 3. System Architecture

### 3.1 Component Overview

```
                                    +------------------+
                                    |   Client/User    |
                                    +--------+---------+
                                             |
                                             | API Key (X-Wayfinder-Token)
                                             v
+-----------------------------------------------------------------------------------+
|                                    Wayfinder API                                   |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  +------------------+     +------------------+     +------------------+            |
|  |  Auth Middleware |---->| Rate Limiter     |---->|  Route Handler   |            |
|  |  (Enhanced)      |     | (Tier-aware)     |     |                  |            |
|  +--------+---------+     +--------+---------+     +--------+---------+            |
|           |                        |                        |                      |
|           v                        v                        v                      |
|  +------------------+     +------------------+     +------------------+            |
|  |   User Store     |     |  Rate Limit      |     | Routing Engine   |            |
|  |                  |     |  Store           |     | (Enhanced)       |            |
|  +--------+---------+     +------------------+     +--------+---------+            |
|           |                                                 |                      |
|           v                                                 v                      |
|  +------------------+                             +------------------+             |
|  |  Token Store     |                             | Router LLM       |             |
|  |  (Enhanced)      |                             | (BYOLLM-aware)   |             |
|  +--------+---------+                             +--------+---------+             |
|           |                                                 |                      |
|           v                                                 |                      |
|  +------------------+                                       |                      |
|  | User LLM Key     |<--------------------------------------+                      |
|  | Store (Encrypted)|                                                              |
|  +------------------+                                                              |
|                                                                                   |
+-----------------------------------------------------------------------------------+
                                             |
                                             v
                                    +------------------+
                                    |      Redis       |
                                    +------------------+
```

### 3.2 Component Responsibilities

| Component | Responsibility | Does NOT Do |
|-----------|---------------|-------------|
| Auth Middleware | Validates API keys, loads user/token config, identifies tier | Rate limiting, routing |
| User Store | CRUD for user accounts, tier management | Token management, key encryption |
| Token Store | CRUD for tokens, links tokens to users | User management |
| User LLM Key Store | Encrypted storage of user LLM API keys | Routing decisions |
| Rate Limiter | Enforces tier-based rate limits | Authentication |
| Routing Engine | Orchestrates routing, selects LLM provider based on user config | User management |

### 3.3 Request Flow

```
1. Request arrives with X-Wayfinder-Token header
2. Auth Middleware:
   a. Hash token, lookup in TokenStore
   b. If token has user_id, load User from UserStore
   c. Determine effective tier (user tier or legacy admin token)
   d. Attach user, token, tier to request context
3. Rate Limiter:
   a. Check tier-specific limits
   b. Reject if exceeded (429)
4. Route Handler:
   a. If BYOLLM tier and user has LLM keys configured:
      - Load encrypted keys from UserLLMKeyStore
      - Decrypt keys
      - Pass to routing engine
   b. Else: use system LLM keys
5. Routing Engine:
   a. Invoke router LLM (with user or system keys)
   b. Return routing decision
```

---

## 4. Data Models

### 4.1 User Model

**Location:** `src/users/types.ts`

```typescript
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
export type UserStatus = 'active' | 'suspended' | 'deleted';

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
```

### 4.2 Enhanced Token Model

**Location:** `src/tokens/types.ts` (extend existing)

```typescript
/**
 * Extended TokenConfig with user association
 * Extends existing TokenConfig from src/types/index.ts
 */
export interface TokenConfigExtended extends TokenConfig {
  /** Associated user ID (null for legacy admin-created tokens) */
  user_id: string | null;

  /** Token name/label for user identification */
  name: string | null;

  /** Whether this is the user's primary/default token */

  /** Anonymous session ID (for progressive registration) */
  anonymous_session_id: string | null;
}

/**
 * Token creation request for self-service
 */
export interface UserTokenCreateRequest {
  name?: string;
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  default_model?: string;
  environment?: Environment;
  knowledge_scope?: KnowledgeScope;
  router_model_preference?: RouterModelPreference;
}
```

### 4.3 User LLM Key Model

**Location:** `src/users/llm-keys/types.ts`

```typescript
/**
 * Supported LLM providers for BYOLLM
 */
export type LLMProvider = 'openai' | 'gemini';

/**
 * User's configured LLM API key (stored encrypted)
 */
export interface UserLLMKey {
  /** Unique identifier (UUID v4) */
  id: string;

  /** Owner user ID */
  user_id: string;

  /** LLM provider */
  provider: LLMProvider;

  /** Encrypted API key (AES-256-GCM) */
  encrypted_key: string;

  /** Initialization vector for decryption */
  iv: string;

  /** Auth tag for GCM mode */
  auth_tag: string;

  /** Key version (for rotation support) */
  key_version: number;

  /** Whether this key is active */
  is_active: boolean;

  /** ISO 8601 timestamp */
  created_at: string;

  /** ISO 8601 timestamp */
  updated_at: string;

  /** ISO 8601 timestamp of last successful use */
  last_used_at: string | null;

  /** Last validation status */
  validation_status: 'valid' | 'invalid' | 'unknown';

  /** Last validation error message */
  validation_error: string | null;
}

/**
 * Request to add/update user LLM key
 */
export interface UserLLMKeyCreateRequest {
  provider: LLMProvider;
  api_key: string; // Plaintext, will be encrypted before storage
}

/**
 * Decrypted key for internal use only
 */
export interface DecryptedLLMKey {
  provider: LLMProvider;
  api_key: string;
}
```

### 4.4 Rate Limit Configuration Model

**Location:** `src/middleware/rate-limit-config.ts`

```typescript
/**
 * Rate limit configuration per tier
 */
export interface TierRateLimits {
  /** Requests allowed per hour */
  requests_per_hour: number;

  /** Requests allowed per day */
  requests_per_day: number;

  /** Burst limit (max requests in 1 minute) */
  burst_limit: number;
}

/**
 * Complete rate limit configuration
 */
export interface RateLimitConfiguration {
  free: TierRateLimits;
  paid_system: TierRateLimits;
  paid_byollm: TierRateLimits;
  admin: TierRateLimits; // Effectively unlimited
}

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfiguration = {
  free: {
    requests_per_hour: 10,
    requests_per_day: 50,
    burst_limit: 5,
  },
  paid_system: {
    requests_per_hour: 100,
    requests_per_day: 1000,
    burst_limit: 20,
  },
  paid_byollm: {
    requests_per_hour: 1000,
    requests_per_day: -1, // -1 = unlimited
    burst_limit: 100,
  },
  admin: {
    requests_per_hour: -1,
    requests_per_day: -1,
    burst_limit: -1,
  },
};
```

---

## 5. API Endpoints

### 5.1 User Registration & Authentication

#### POST /api/users/register

**Purpose:** Create a new user account

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123!"
}
```

**Success Response (201):**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "tier": "free",
    "status": "active",
    "created_at": "2026-01-12T10:00:00Z"
  },
  "token": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "token": "wf_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456",
    "name": "Default Token",
  }
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 400 | VAL_001 | Invalid email format |
| 400 | VAL_002 | Password does not meet requirements |
| 409 | USER_001 | Email already registered |

**Implementation Requirements:**
- MUST validate email format: `^[^\s@]+@[^\s@]+\.[^\s@]+$`
- MUST validate password: min 8 chars, 1 uppercase, 1 lowercase, 1 digit
- MUST hash password with bcrypt (work factor 12)
- MUST create default token for user
- MUST return token value only once (never stored in plaintext)

---

#### POST /api/users/login

**Purpose:** Authenticate user and return new API token

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123!"
}
```

**Success Response (200):**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "tier": "paid_system",
    "status": "active"
  },
  "tokens": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "name": "Default Token",
      "created_at": "2026-01-12T10:00:00Z"
    },
    {
      "id": "770e8400-e29b-41d4-a716-446655440002",
      "name": "Production",
      "created_at": "2026-01-12T11:00:00Z"
    }
  ]
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 401 | AUTH_001 | Invalid email or password |
| 403 | AUTH_002 | Account suspended |

**Implementation Requirements:**
- MUST use constant-time comparison for password
- MUST NOT reveal whether email exists (same error for both cases)
- MUST update last_login_at on success
- MUST NOT return token values (user must use existing or create new)

---

#### POST /api/anonymous/session

**Purpose:** Create anonymous session for progressive registration

**Request:** (empty body)

**Success Response (201):**
```json
{
  "session_id": "880e8400-e29b-41d4-a716-446655440003",
  "token": "wf_AnOnYmOuSsEsSiOnToKeN12345678",
  "expires_at": "2026-01-19T10:00:00Z",
  "rate_limits": {
    "requests_per_hour": 10,
    "requests_per_day": 50,
    "remaining_today": 50
  }
}
```

**Implementation Requirements:**
- MUST create token with `anonymous_session_id` set
- MUST set 7-day expiration
- MUST apply free tier rate limits
- Session token works for /route endpoint

---

#### POST /api/anonymous/convert

**Purpose:** Convert anonymous session to registered account

**Headers:**
```
X-Wayfinder-Token: wf_AnOnYmOuSsEsSiOnToKeN12345678
```

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securePassword123!"
}
```

**Success Response (200):**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "tier": "free",
    "status": "active"
  },
  "token": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "name": "Converted from anonymous",
  },
  "message": "Account created. Your existing token has been linked to your account."
}
```

**Implementation Requirements:**
- MUST validate anonymous session token
- MUST link existing token to new user
- MUST clear anonymous_session_id from token
- MUST preserve token value (no rotation)

---

### 5.2 Token Management (Authenticated)

All endpoints require `X-Wayfinder-Token` header with valid user token.

#### GET /api/tokens

**Purpose:** List user's tokens

**Success Response (200):**
```json
{
  "tokens": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "name": "Default Token",
      "environment": "dev",
      "created_at": "2026-01-12T10:00:00Z",
      "updated_at": "2026-01-12T10:00:00Z"
    }
  ],
  "count": 1
}
```

---

#### POST /api/tokens

**Purpose:** Create new token for authenticated user

**Request:**
```json
{
  "name": "Production API",
  "environment": "prod",
  "allowed_models": ["gpt-4o", "claude-3-5-sonnet"],
  "confidence_threshold": 0.8
}
```

**Success Response (201):**
```json
{
  "id": "770e8400-e29b-41d4-a716-446655440002",
  "token": "wf_NeWtOkEnVaLuE123456789012345678",
  "name": "Production API",
  "config": {
    "environment": "prod",
    "allowed_models": ["gpt-4o", "claude-3-5-sonnet"],
    "confidence_threshold": 0.8
  }
}
```

**Implementation Requirements:**
- MUST associate token with authenticated user
- MUST validate model identifiers against registry
- Token limit per user: 10 (configurable)

---

#### DELETE /api/tokens/:id

**Purpose:** Delete user's token

**Success Response (204):** No content

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 404 | TOKEN_001 | Token not found |
| 403 | TOKEN_002 | Cannot delete primary token |
| 403 | TOKEN_003 | Token does not belong to user |

---

#### POST /api/tokens/:id/rotate

**Purpose:** Rotate token (generate new value)

**Success Response (200):**
```json
{
  "token": "wf_RoTaTeD_ToKeN_VaLuE_987654321",
  "rotated_at": "2026-01-12T15:00:00Z"
}
```

---

### 5.3 LLM Key Management (BYOLLM)

All endpoints require `X-Wayfinder-Token` header. User must be `paid_byollm` tier.

#### GET /api/llm-keys

**Purpose:** List user's configured LLM provider keys

**Success Response (200):**
```json
{
  "keys": [
    {
      "id": "990e8400-e29b-41d4-a716-446655440004",
      "provider": "openai",
      "is_active": true,
      "validation_status": "valid",
      "created_at": "2026-01-12T10:00:00Z",
      "last_used_at": "2026-01-12T14:30:00Z"
    },
    {
      "id": "aa0e8400-e29b-41d4-a716-446655440005",
      "provider": "gemini",
      "is_active": true,
      "validation_status": "valid",
      "created_at": "2026-01-12T10:00:00Z",
      "last_used_at": null
    }
  ],
  "consensus_routing_enabled": true
}
```

**Note:** API key values are NEVER returned. Only metadata.

---

#### POST /api/llm-keys

**Purpose:** Add or update LLM provider API key

**Request:**
```json
{
  "provider": "openai",
  "api_key": "sk-..."
}
```

**Success Response (201):**
```json
{
  "id": "990e8400-e29b-41d4-a716-446655440004",
  "provider": "openai",
  "is_active": true,
  "validation_status": "unknown",
  "message": "Key stored. Validation will occur on first use."
}
```

**Error Responses:**

| Status | Code | Message |
|--------|------|---------|
| 403 | BYOLLM_001 | BYOLLM requires paid_byollm tier |
| 400 | BYOLLM_002 | Invalid provider. Supported: openai, gemini |
| 400 | BYOLLM_003 | API key format invalid |

**Implementation Requirements:**
- MUST encrypt key before storage (AES-256-GCM)
- MUST validate key format (basic prefix check)
- If key for provider exists, MUST update (not create duplicate)
- Validation against provider API is deferred to first use

---

#### DELETE /api/llm-keys/:provider

**Purpose:** Remove LLM provider key

**Success Response (204):** No content

**Note:** After deletion, routing falls back to system keys (if user tier allows).

---

#### POST /api/llm-keys/:provider/validate

**Purpose:** Validate LLM key against provider API

**Success Response (200):**
```json
{
  "provider": "openai",
  "validation_status": "valid",
  "validated_at": "2026-01-12T15:00:00Z"
}
```

**Error Response (200 with invalid status):**
```json
{
  "provider": "openai",
  "validation_status": "invalid",
  "validation_error": "Invalid API key",
  "validated_at": "2026-01-12T15:00:00Z"
}
```

**Implementation Requirements:**
- Make lightweight API call to provider (e.g., list models)
- Update validation_status in storage
- Rate limit: 1 validation per key per minute

---

### 5.4 User Profile Management

#### GET /api/users/me

**Purpose:** Get current user profile

**Success Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "tier": "paid_byollm",
  "status": "active",
  "created_at": "2026-01-12T10:00:00Z",
  "rate_limits": {
    "requests_per_hour": 1000,
    "requests_per_day": -1,
    "used_today": 42,
    "used_this_hour": 5
  },
  "llm_keys_configured": {
    "openai": true,
    "gemini": true
  }
}
```

---

#### PATCH /api/users/me

**Purpose:** Update user profile

**Request:**
```json
{
  "email": "newemail@example.com",
  "password": "newSecurePassword456!"
}
```

**Success Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "newemail@example.com",
  "updated_at": "2026-01-12T16:00:00Z"
}
```

---

## 6. Database Schema (Redis)

### 6.1 Key Patterns

```
# User storage
wayfinder:user:{user_id}                    -> JSON(User)
wayfinder:user:email:{email_hash}           -> user_id (index)
wayfinder:user:index                        -> SET of user_ids

# Token storage (enhanced)
wayfinder:token:{token_id}                  -> JSON(TokenConfigExtended)
wayfinder:token_hash_index:{token_hash}     -> token_id
wayfinder:token:index                       -> SET of token_ids
wayfinder:user:{user_id}:tokens             -> SET of token_ids (per-user index)

# Anonymous sessions
wayfinder:anon_session:{session_id}         -> JSON(AnonymousSession)
wayfinder:anon_session:token:{token_id}     -> session_id (reverse index)

# User LLM keys
wayfinder:user:{user_id}:llm_keys           -> JSON(UserLLMKey[])

# Rate limiting (per user/token)
wayfinder:ratelimit:hour:{user_id}          -> COUNT (TTL: 1 hour)
wayfinder:ratelimit:day:{user_id}           -> COUNT (TTL: 24 hours)
wayfinder:ratelimit:burst:{user_id}         -> COUNT (TTL: 1 minute)
```

### 6.2 Data Structures

#### User Record
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "password_hash": "$2b$12$...",
  "tier": "paid_byollm",
  "status": "active",
  "org_id": null,
  "billing_customer_id": null,
  "created_at": "2026-01-12T10:00:00Z",
  "updated_at": "2026-01-12T10:00:00Z",
  "last_login_at": "2026-01-12T14:00:00Z"
}
```

#### Extended Token Record
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "token_hash": "abc123...",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Production API",
  "anonymous_session_id": null,
  "trusted_anchor_model": "gpt-4o",
  "allowed_models": ["gpt-4o", "claude-3-5-sonnet"],
  "denied_models": null,
  "policy_rules": null,
  "confidence_threshold": 0.6,
  "logging_level": "normal",
  "default_model": null,
  "environment": "prod",
  "knowledge_scope": "global",
  "router_model_preference": "consensus",
  "created_at": "2026-01-12T10:00:00Z",
  "updated_at": "2026-01-12T10:00:00Z"
}
```

#### User LLM Keys Record
```json
[
  {
    "id": "990e8400-e29b-41d4-a716-446655440004",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "provider": "openai",
    "encrypted_key": "base64EncodedEncryptedKey...",
    "iv": "base64EncodedIV...",
    "auth_tag": "base64EncodedAuthTag...",
    "key_version": 1,
    "is_active": true,
    "created_at": "2026-01-12T10:00:00Z",
    "updated_at": "2026-01-12T10:00:00Z",
    "last_used_at": "2026-01-12T14:30:00Z",
    "validation_status": "valid",
    "validation_error": null
  }
]
```

---

## 7. Security Specifications

### 7.1 Password Requirements

```typescript
// Location: src/users/validation.ts

const PASSWORD_REQUIREMENTS = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecial: false, // Not required but allowed
};

function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push(`Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`);
  }
  if (password.length > PASSWORD_REQUIREMENTS.maxLength) {
    errors.push(`Password must be at most ${PASSWORD_REQUIREMENTS.maxLength} characters`);
  }
  if (PASSWORD_REQUIREMENTS.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (PASSWORD_REQUIREMENTS.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (PASSWORD_REQUIREMENTS.requireDigit && !/\d/.test(password)) {
    errors.push('Password must contain at least one digit');
  }

  return { valid: errors.length === 0, errors };
}
```

### 7.2 Password Hashing

```typescript
// Location: src/users/password.ts

import bcrypt from 'bcrypt';

const BCRYPT_WORK_FACTOR = 12;

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_WORK_FACTOR);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

### 7.3 LLM Key Encryption

```typescript
// Location: src/users/llm-keys/encryption.ts

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

interface EncryptedData {
  encrypted: string; // base64
  iv: string;        // base64
  authTag: string;   // base64
}

function getEncryptionKey(): Buffer {
  const key = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('LLM_KEY_ENCRYPTION_KEY environment variable is required');
  }
  // Key should be 64 hex characters (32 bytes)
  if (key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error('LLM_KEY_ENCRYPTION_KEY must be 64 hex characters');
  }
  return Buffer.from(key, 'hex');
}

function encryptLLMKey(plaintext: string): EncryptedData {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptLLMKey(data: EncryptedData): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(data.iv, 'base64');
  const authTag = Buffer.from(data.authTag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

### 7.4 Email Hashing for Index

```typescript
// Location: src/users/store.ts

import crypto from 'crypto';

function hashEmail(email: string): string {
  const normalized = email.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
```

### 7.5 Security Audit Logging

```typescript
// Location: src/users/audit.ts

interface AuditEvent {
  event_type: 'user_created' | 'user_login' | 'user_login_failed' |
              'password_changed' | 'llm_key_added' | 'llm_key_removed' |
              'token_created' | 'token_rotated' | 'token_deleted';
  timestamp: string;
  user_id: string | null;
  ip_address: string;
  user_agent: string;
  metadata: Record<string, unknown>;
}

function logAuditEvent(event: AuditEvent): void {
  // Log to structured logger
  // In production, this would go to a security audit system
  logger.info('Security audit event', event);
}
```

---

## 8. Rate Limiting Strategy

### 8.1 Tier-Based Rate Limiting

**Location:** `src/middleware/tier-rate-limit.ts`

```typescript
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response, NextFunction } from 'express';
import type { UserTier } from '../users/types';

/**
 * Rate limit configuration loaded from environment or defaults
 */
function loadRateLimitConfig(): RateLimitConfiguration {
  return {
    free: {
      requests_per_hour: parseInt(process.env.RATE_LIMIT_FREE_HOUR || '10', 10),
      requests_per_day: parseInt(process.env.RATE_LIMIT_FREE_DAY || '50', 10),
      burst_limit: parseInt(process.env.RATE_LIMIT_FREE_BURST || '5', 10),
    },
    paid_system: {
      requests_per_hour: parseInt(process.env.RATE_LIMIT_PAID_SYSTEM_HOUR || '100', 10),
      requests_per_day: parseInt(process.env.RATE_LIMIT_PAID_SYSTEM_DAY || '1000', 10),
      burst_limit: parseInt(process.env.RATE_LIMIT_PAID_SYSTEM_BURST || '20', 10),
    },
    paid_byollm: {
      requests_per_hour: parseInt(process.env.RATE_LIMIT_BYOLLM_HOUR || '1000', 10),
      requests_per_day: parseInt(process.env.RATE_LIMIT_BYOLLM_DAY || '-1', 10),
      burst_limit: parseInt(process.env.RATE_LIMIT_BYOLLM_BURST || '100', 10),
    },
    admin: {
      requests_per_hour: -1,
      requests_per_day: -1,
      burst_limit: -1,
    },
  };
}

/**
 * Middleware factory for tier-aware rate limiting
 */
function createTierRateLimiter(redis?: Redis) {
  const config = loadRateLimitConfig();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Determine user tier from request context
    const tier: UserTier = req.userTier || 'free';
    const userId = req.user?.id || req.tokenConfig?.id || req.ip;

    const limits = config[tier];

    // Skip rate limiting for admin tier
    if (limits.requests_per_hour === -1) {
      return next();
    }

    // Check hourly limit
    const hourlyKey = `wayfinder:ratelimit:hour:${userId}`;
    const hourlyCount = await redis?.incr(hourlyKey) || 0;
    if (hourlyCount === 1) {
      await redis?.expire(hourlyKey, 3600);
    }

    if (hourlyCount > limits.requests_per_hour) {
      return res.status(429).json({
        error: 'TooManyRequests',
        message: `Rate limit exceeded. ${limits.requests_per_hour} requests per hour allowed for ${tier} tier.`,
        retry_after_seconds: await redis?.ttl(hourlyKey),
        timestamp: new Date().toISOString(),
      });
    }

    // Check daily limit (if not unlimited)
    if (limits.requests_per_day !== -1) {
      const dailyKey = `wayfinder:ratelimit:day:${userId}`;
      const dailyCount = await redis?.incr(dailyKey) || 0;
      if (dailyCount === 1) {
        await redis?.expire(dailyKey, 86400);
      }

      if (dailyCount > limits.requests_per_day) {
        return res.status(429).json({
          error: 'TooManyRequests',
          message: `Daily rate limit exceeded. ${limits.requests_per_day} requests per day allowed for ${tier} tier.`,
          retry_after_seconds: await redis?.ttl(dailyKey),
          upgrade_url: '/api/users/upgrade',
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit-Hour', limits.requests_per_hour);
    res.setHeader('X-RateLimit-Remaining-Hour', Math.max(0, limits.requests_per_hour - hourlyCount));

    next();
  };
}
```

### 8.2 Progressive Registration Prompt

When a free/anonymous user approaches their limit:

```typescript
// Location: src/middleware/registration-prompt.ts

function maybePromptRegistration(req: Request, res: Response, next: NextFunction) {
  const isAnonymous = !!req.tokenConfig?.anonymous_session_id;
  const dailyRemaining = /* calculate from rate limit data */;

  if (isAnonymous && dailyRemaining <= 10) {
    // Add header to prompt registration
    res.setHeader('X-Wayfinder-Registration-Prompt', 'true');
    res.setHeader('X-Wayfinder-Requests-Remaining', dailyRemaining.toString());
  }

  next();
}
```

---

## 9. BYOLLM Integration

### 9.1 Router LLM Enhancement

**Location:** `src/routing/router-llm/byollm-router-llm.ts`

```typescript
import { MultiProviderRouterLLM } from './multi-provider-router-llm';
import type { RouterLLM } from '../engine';
import type { TokenConfig, DecryptedLLMKey } from '../../types';
import { OpenAIClient, GeminiClient } from './providers';
import type { RouterLLMConfig } from '../config';

/**
 * BYOLLM-aware Router LLM wrapper
 *
 * If user has configured LLM keys, uses those.
 * Otherwise, falls back to system keys.
 */
export class BYOLLMRouterLLM implements RouterLLM {
  private systemRouter: MultiProviderRouterLLM;

  constructor(systemConfig: RouterLLMConfig, logger?: Console) {
    this.systemRouter = new MultiProviderRouterLLM(systemConfig, logger);
  }

  async invoke(
    prompt: string,
    eligibleModels: string[],
    context: {
      tokenConfig: TokenConfig;
      preferModel?: string;
      requestMetadata?: Record<string, unknown>;
      userLLMKeys?: DecryptedLLMKey[]; // Injected by routing handler
    }
  ): Promise<unknown> {
    // If user has BYOLLM keys, create temporary router with user keys
    if (context.userLLMKeys && context.userLLMKeys.length > 0) {
      const userRouter = this.createUserRouter(context.userLLMKeys);
      return userRouter.invoke(prompt, eligibleModels, context);
    }

    // Fall back to system router
    return this.systemRouter.invoke(prompt, eligibleModels, context);
  }

  private createUserRouter(keys: DecryptedLLMKey[]): MultiProviderRouterLLM {
    const userConfig = this.buildUserConfig(keys);
    return new MultiProviderRouterLLM(userConfig, console);
  }

  private buildUserConfig(keys: DecryptedLLMKey[]): RouterLLMConfig {
    const openaiKey = keys.find(k => k.provider === 'openai');
    const geminiKey = keys.find(k => k.provider === 'gemini');

    return {
      openai: {
        enabled: !!openaiKey,
        apiKey: openaiKey?.api_key,
        model: process.env.ROUTER_LLM_OPENAI_MODEL || 'gpt-4o-mini',
      },
      gemini: {
        enabled: !!geminiKey,
        apiKey: geminiKey?.api_key,
        model: process.env.ROUTER_LLM_GEMINI_MODEL || 'gemini-1.5-flash',
      },
      timeout: parseInt(process.env.ROUTER_LLM_TIMEOUT || '30000', 10),
      maxRetries: parseInt(process.env.ROUTER_LLM_MAX_RETRIES || '2', 10),
      temperature: parseFloat(process.env.ROUTER_LLM_TEMPERATURE || '0.0'),
      maxTokens: parseInt(process.env.ROUTER_LLM_MAX_TOKENS || '2000', 10),
    };
  }
}
```

### 9.2 Routing Engine Enhancement

**Location:** `src/routing/engine.ts` (modifications)

```typescript
// Add to route() method, before router LLM invocation:

// Load user LLM keys if BYOLLM tier
let userLLMKeys: DecryptedLLMKey[] | undefined;
if (request.userTier === 'paid_byollm' && request.user?.id) {
  userLLMKeys = await this.deps.userLLMKeyStore.getDecryptedKeys(request.user.id);

  if (userLLMKeys.length === 0) {
    this.deps.logger.warn('BYOLLM user has no configured LLM keys, falling back to system', {
      user_id: request.user.id,
      request_id: requestId,
    });
  }
}

// Pass to router LLM
const rawDecision = await this.deps.routerLLM.invoke(request.prompt, eligibleModels, {
  tokenConfig,
  preferModel: request.prefer_model,
  requestMetadata: request.metadata,
  userLLMKeys, // New: pass user keys
});
```

### 9.3 Key Validation Service

**Location:** `src/users/llm-keys/validation.ts`

```typescript
import { OpenAIClient, GeminiClient } from '../../routing/router-llm/providers';

interface ValidationResult {
  valid: boolean;
  error?: string;
}

async function validateOpenAIKey(apiKey: string): Promise<ValidationResult> {
  try {
    const client = new OpenAIClient(apiKey);
    // Make minimal API call to validate key
    await client.invoke({
      prompt: 'Return JSON: {"status": "ok"}',
      model: 'gpt-4o-mini',
      temperature: 0,
      maxTokens: 10,
      timeout: 5000,
    });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function validateGeminiKey(apiKey: string): Promise<ValidationResult> {
  try {
    const client = new GeminiClient(apiKey);
    await client.invoke({
      prompt: 'Return JSON: {"status": "ok"}',
      model: 'gemini-1.5-flash',
      temperature: 0,
      maxTokens: 10,
      timeout: 5000,
    });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function validateLLMKey(
  provider: LLMProvider,
  apiKey: string
): Promise<ValidationResult> {
  switch (provider) {
    case 'openai':
      return validateOpenAIKey(apiKey);
    case 'gemini':
      return validateGeminiKey(apiKey);
    default:
      return { valid: false, error: `Unknown provider: ${provider}` };
  }
}
```

---

## 10. Error Handling

### 10.1 Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| VAL_001 | 400 | Invalid email format |
| VAL_002 | 400 | Password validation failed |
| VAL_003 | 400 | Invalid request body |
| AUTH_001 | 401 | Invalid credentials |
| AUTH_002 | 403 | Account suspended |
| AUTH_003 | 401 | Token expired or invalid |
| USER_001 | 409 | Email already registered |
| USER_002 | 404 | User not found |
| TOKEN_001 | 404 | Token not found |
| TOKEN_002 | 403 | Cannot delete primary token |
| TOKEN_003 | 403 | Token does not belong to user |
| TOKEN_004 | 400 | Token limit exceeded |
| BYOLLM_001 | 403 | BYOLLM requires paid_byollm tier |
| BYOLLM_002 | 400 | Invalid LLM provider |
| BYOLLM_003 | 400 | Invalid API key format |
| BYOLLM_004 | 400 | LLM key validation failed |
| RATE_001 | 429 | Hourly rate limit exceeded |
| RATE_002 | 429 | Daily rate limit exceeded |

### 10.2 Error Response Format

```typescript
interface ApiError {
  error: string;           // Error type (e.g., "ValidationError")
  code: string;            // Error code (e.g., "VAL_001")
  message: string;         // Human-readable message
  details?: unknown;       // Additional details
  timestamp: string;       // ISO 8601 timestamp
}
```

---

## 11. Testing Requirements

### 11.1 Unit Tests

**Location:** `test/users/`

```typescript
// test/users/store.test.ts
describe('UserStore', () => {
  describe('create', () => {
    it('should create user with valid data');
    it('should reject duplicate email');
    it('should hash password with bcrypt');
    it('should set default tier to free');
  });

  describe('authenticate', () => {
    it('should return user for valid credentials');
    it('should reject invalid password');
    it('should reject non-existent email');
    it('should update last_login_at on success');
  });
});

// test/users/llm-keys/encryption.test.ts
describe('LLM Key Encryption', () => {
  it('should encrypt and decrypt key correctly');
  it('should produce different ciphertext for same plaintext');
  it('should fail decryption with wrong key');
  it('should fail decryption with tampered auth tag');
});

// test/users/llm-keys/store.test.ts
describe('UserLLMKeyStore', () => {
  it('should store encrypted key');
  it('should retrieve and decrypt key');
  it('should update existing key for same provider');
  it('should delete key');
});
```

### 11.2 Integration Tests

**Location:** `test/integration/`

```typescript
// test/integration/user-registration.test.ts
describe('User Registration Flow', () => {
  it('should register new user and return token');
  it('should reject registration with existing email');
  it('should allow login after registration');
  it('should list user tokens after login');
});

// test/integration/anonymous-session.test.ts
describe('Anonymous Session Flow', () => {
  it('should create anonymous session');
  it('should allow routing requests with anonymous token');
  it('should enforce rate limits on anonymous session');
  it('should convert anonymous to registered user');
  it('should preserve token after conversion');
});

// test/integration/byollm.test.ts
describe('BYOLLM Flow', () => {
  it('should reject LLM key management for non-BYOLLM tier');
  it('should store and retrieve LLM keys');
  it('should use user keys for routing when configured');
  it('should fall back to system keys when user keys fail');
});
```

### 11.3 Security Tests

```typescript
// test/security/auth.test.ts
describe('Authentication Security', () => {
  it('should use constant-time comparison for passwords');
  it('should not reveal email existence on login failure');
  it('should rate limit login attempts');
  it('should log failed login attempts');
});

// test/security/encryption.test.ts
describe('Encryption Security', () => {
  it('should never log plaintext LLM keys');
  it('should clear sensitive data from memory');
  it('should validate encryption key format');
});
```

---

## 12. Implementation Tasks

### 12.1 Task Dependency Graph

```
Phase 1: Foundation (Can run in parallel)
├── Task 1.1: User Data Models & Types
├── Task 1.2: User Store (Redis)
├── Task 1.3: Password Hashing Utilities
├── Task 1.4: LLM Key Encryption Utilities
└── Task 1.5: Rate Limit Configuration

Phase 2: Core Services (Depends on Phase 1)
├── Task 2.1: User Store Implementation [depends on 1.1, 1.2, 1.3]
├── Task 2.2: Token Store Enhancement [depends on 1.1, 1.2]
├── Task 2.3: User LLM Key Store [depends on 1.1, 1.2, 1.4]
├── Task 2.4: Anonymous Session Store [depends on 1.1, 1.2]
└── Task 2.5: Tier Rate Limiter [depends on 1.5]

Phase 3: API Layer (Depends on Phase 2)
├── Task 3.1: User Registration Routes [depends on 2.1]
├── Task 3.2: User Login Routes [depends on 2.1]
├── Task 3.3: Anonymous Session Routes [depends on 2.4]
├── Task 3.4: Token Management Routes [depends on 2.2]
├── Task 3.5: LLM Key Management Routes [depends on 2.3]
└── Task 3.6: User Profile Routes [depends on 2.1]

Phase 4: Integration (Depends on Phase 3)
├── Task 4.1: Enhanced Auth Middleware [depends on 2.1, 2.2]
├── Task 4.2: BYOLLM Router LLM [depends on 2.3]
├── Task 4.3: Routing Engine Enhancement [depends on 4.2]
└── Task 4.4: App.ts Integration [depends on all Phase 3]

Phase 5: Testing & Documentation (Depends on Phase 4)
├── Task 5.1: Unit Tests
├── Task 5.2: Integration Tests
├── Task 5.3: Security Tests
└── Task 5.4: API Documentation
```

### 12.2 Detailed Task Specifications

---

#### Task 1.1: User Data Models & Types

**File:** `src/users/types.ts`

**Description:** Define TypeScript interfaces for User, UserTier, UserStatus, and related types.

**Acceptance Criteria:**
- [ ] User interface defined with all fields from Section 4.1
- [ ] UserTier type with 4 values: free, paid_system, paid_byollm, admin
- [ ] UserStatus type with 3 values: active, suspended, deleted
- [ ] UserCreateRequest and UserUpdateRequest interfaces
- [ ] AnonymousSession interface
- [ ] All types exported

**Dependencies:** None

**Estimated Time:** 1 hour

**Parallel:** Can run with 1.2, 1.3, 1.4, 1.5

---

#### Task 1.2: LLM Key Types

**File:** `src/users/llm-keys/types.ts`

**Description:** Define TypeScript interfaces for LLM key storage.

**Acceptance Criteria:**
- [ ] LLMProvider type: 'openai' | 'gemini'
- [ ] UserLLMKey interface with encryption fields
- [ ] UserLLMKeyCreateRequest interface
- [ ] DecryptedLLMKey interface
- [ ] All types exported

**Dependencies:** None

**Estimated Time:** 30 minutes

**Parallel:** Can run with 1.1, 1.3, 1.4, 1.5

---

#### Task 1.3: Password Hashing Utilities

**File:** `src/users/password.ts`

**Description:** Implement bcrypt password hashing and verification.

**Acceptance Criteria:**
- [ ] hashPassword(password: string): Promise<string>
- [ ] verifyPassword(password: string, hash: string): Promise<boolean>
- [ ] BCRYPT_WORK_FACTOR constant set to 12
- [ ] Uses native bcrypt (add to package.json)

**Dependencies:** None (but requires bcrypt package)

**Estimated Time:** 1 hour

**Parallel:** Can run with 1.1, 1.2, 1.4, 1.5

---

#### Task 1.4: LLM Key Encryption Utilities

**File:** `src/users/llm-keys/encryption.ts`

**Description:** Implement AES-256-GCM encryption for LLM API keys.

**Acceptance Criteria:**
- [ ] encryptLLMKey(plaintext: string): EncryptedData
- [ ] decryptLLMKey(data: EncryptedData): string
- [ ] getEncryptionKey(): Buffer (from env var)
- [ ] Validates encryption key format (64 hex chars)
- [ ] Uses crypto module (no external deps)

**Dependencies:** None

**Estimated Time:** 2 hours

**Parallel:** Can run with 1.1, 1.2, 1.3, 1.5

---

#### Task 1.5: Rate Limit Configuration

**File:** `src/middleware/rate-limit-config.ts`

**Description:** Define rate limit configuration types and defaults.

**Acceptance Criteria:**
- [ ] TierRateLimits interface
- [ ] RateLimitConfiguration interface
- [ ] DEFAULT_RATE_LIMITS constant with values from Section 4.4
- [ ] loadRateLimitConfig() function (reads from env)

**Dependencies:** None

**Estimated Time:** 1 hour

**Parallel:** Can run with 1.1, 1.2, 1.3, 1.4

---

#### Task 2.1: User Store Implementation

**Files:** `src/users/store.ts`, `src/users/index.ts`

**Description:** Implement UserStore interface with Redis backend.

**Acceptance Criteria:**
- [ ] UserStore interface defined
- [ ] InMemoryUserStore for testing
- [ ] RedisUserStore for production
- [ ] create(request: UserCreateRequest): Promise<User>
- [ ] getById(id: string): Promise<User | null>
- [ ] getByEmail(email: string): Promise<User | null>
- [ ] update(id: string, request: UserUpdateRequest): Promise<User | null>
- [ ] authenticate(email: string, password: string): Promise<User | null>
- [ ] Email indexed by hash for lookup

**Dependencies:** Task 1.1, Task 1.3

**Estimated Time:** 4 hours

**Parallel:** Can run with 2.2, 2.3, 2.4, 2.5

---

#### Task 2.2: Token Store Enhancement

**Files:** `src/tokens/store.ts` (modify), `src/tokens/types.ts` (new)

**Description:** Extend TokenConfig with user association fields.

**Acceptance Criteria:**
- [ ] TokenConfigExtended interface
- [ ] Add user_id, name, anonymous_session_id to TokenConfig
- [ ] Update create() to accept user_id
- [ ] Add getByUserId(userId: string): Promise<TokenConfig[]>
- [ ] Add setPrimary(tokenId: string, userId: string): Promise<void>
- [ ] Backward compatible with existing tokens (user_id = null)

**Dependencies:** Task 1.1

**Estimated Time:** 3 hours

**Parallel:** Can run with 2.1, 2.3, 2.4, 2.5

---

#### Task 2.3: User LLM Key Store

**Files:** `src/users/llm-keys/store.ts`, `src/users/llm-keys/index.ts`

**Description:** Implement encrypted storage for user LLM API keys.

**Acceptance Criteria:**
- [ ] UserLLMKeyStore interface
- [ ] InMemoryUserLLMKeyStore for testing
- [ ] RedisUserLLMKeyStore for production
- [ ] setKey(userId: string, request: UserLLMKeyCreateRequest): Promise<UserLLMKey>
- [ ] getKeys(userId: string): Promise<UserLLMKey[]> (metadata only, no decryption)
- [ ] getDecryptedKeys(userId: string): Promise<DecryptedLLMKey[]>
- [ ] deleteKey(userId: string, provider: LLMProvider): Promise<boolean>
- [ ] updateValidationStatus(userId: string, provider: LLMProvider, status, error?): Promise<void>

**Dependencies:** Task 1.2, Task 1.4

**Estimated Time:** 4 hours

**Parallel:** Can run with 2.1, 2.2, 2.4, 2.5

---

#### Task 2.4: Anonymous Session Store

**Files:** `src/users/anonymous/store.ts`, `src/users/anonymous/types.ts`

**Description:** Implement storage for anonymous sessions.

**Acceptance Criteria:**
- [ ] AnonymousSessionStore interface
- [ ] create(): Promise<{session: AnonymousSession, token: string}>
- [ ] getBySessionId(sessionId: string): Promise<AnonymousSession | null>
- [ ] getByTokenId(tokenId: string): Promise<AnonymousSession | null>
- [ ] incrementRequestCount(sessionId: string): Promise<number>
- [ ] delete(sessionId: string): Promise<boolean>
- [ ] Sessions expire after 7 days (Redis TTL)

**Dependencies:** Task 1.1

**Estimated Time:** 2 hours

**Parallel:** Can run with 2.1, 2.2, 2.3, 2.5

---

#### Task 2.5: Tier Rate Limiter

**File:** `src/middleware/tier-rate-limit.ts`

**Description:** Implement tier-aware rate limiting middleware.

**Acceptance Criteria:**
- [ ] createTierRateLimiter(redis?: Redis): Middleware
- [ ] Reads tier from req.userTier
- [ ] Enforces hourly and daily limits per tier
- [ ] Skips limiting for admin tier
- [ ] Returns 429 with appropriate message
- [ ] Sets rate limit headers
- [ ] Works with both Redis and in-memory

**Dependencies:** Task 1.5

**Estimated Time:** 3 hours

**Parallel:** Can run with 2.1, 2.2, 2.3, 2.4

---

#### Task 3.1: User Registration Routes

**File:** `src/users/routes.ts`

**Description:** Implement POST /api/users/register endpoint.

**Acceptance Criteria:**
- [ ] Validates email format
- [ ] Validates password requirements
- [ ] Creates user via UserStore
- [ ] Creates default token for user
- [ ] Returns user and token
- [ ] Handles duplicate email error

**Dependencies:** Task 2.1, Task 2.2

**Estimated Time:** 2 hours

**Parallel:** Can run with 3.2, 3.3, 3.4, 3.5, 3.6

---

#### Task 3.2: User Login Routes

**File:** `src/users/routes.ts`

**Description:** Implement POST /api/users/login endpoint.

**Acceptance Criteria:**
- [ ] Authenticates via UserStore
- [ ] Returns user and token list (no token values)
- [ ] Updates last_login_at
- [ ] Returns same error for invalid email/password
- [ ] Logs failed attempts

**Dependencies:** Task 2.1

**Estimated Time:** 2 hours

**Parallel:** Can run with 3.1, 3.3, 3.4, 3.5, 3.6

---

#### Task 3.3: Anonymous Session Routes

**File:** `src/users/anonymous/routes.ts`

**Description:** Implement anonymous session endpoints.

**Acceptance Criteria:**
- [ ] POST /api/anonymous/session - create session
- [ ] POST /api/anonymous/convert - convert to registered
- [ ] Returns token on session creation
- [ ] Preserves token on conversion
- [ ] Links token to new user on conversion

**Dependencies:** Task 2.4, Task 2.1

**Estimated Time:** 3 hours

**Parallel:** Can run with 3.1, 3.2, 3.4, 3.5, 3.6

---

#### Task 3.4: Token Management Routes

**File:** `src/tokens/user-routes.ts`

**Description:** Implement user token management endpoints.

**Acceptance Criteria:**
- [ ] GET /api/tokens - list user's tokens
- [ ] POST /api/tokens - create new token
- [ ] DELETE /api/tokens/:id - delete token
- [ ] POST /api/tokens/:id/rotate - rotate token
- [ ] All require authentication
- [ ] Cannot delete primary token
- [ ] Enforces token limit per user (10)

**Dependencies:** Task 2.2

**Estimated Time:** 3 hours

**Parallel:** Can run with 3.1, 3.2, 3.3, 3.5, 3.6

---

#### Task 3.5: LLM Key Management Routes

**File:** `src/users/llm-keys/routes.ts`

**Description:** Implement BYOLLM key management endpoints.

**Acceptance Criteria:**
- [ ] GET /api/llm-keys - list keys (metadata only)
- [ ] POST /api/llm-keys - add/update key
- [ ] DELETE /api/llm-keys/:provider - delete key
- [ ] POST /api/llm-keys/:provider/validate - validate key
- [ ] Requires paid_byollm tier
- [ ] Never returns plaintext keys

**Dependencies:** Task 2.3

**Estimated Time:** 3 hours

**Parallel:** Can run with 3.1, 3.2, 3.3, 3.4, 3.6

---

#### Task 3.6: User Profile Routes

**File:** `src/users/routes.ts`

**Description:** Implement user profile endpoints.

**Acceptance Criteria:**
- [ ] GET /api/users/me - get current user
- [ ] PATCH /api/users/me - update profile
- [ ] Returns rate limit usage info
- [ ] Returns LLM keys configured status

**Dependencies:** Task 2.1

**Estimated Time:** 2 hours

**Parallel:** Can run with 3.1, 3.2, 3.3, 3.4, 3.5

---

#### Task 4.1: Enhanced Auth Middleware

**File:** `src/auth/middleware.ts` (modify)

**Description:** Enhance auth middleware to load user and determine tier.

**Acceptance Criteria:**
- [ ] After token lookup, load user if user_id present
- [ ] Determine effective tier (user tier or admin for legacy)
- [ ] Attach user, tier to request
- [ ] Check user status (reject if suspended)
- [ ] Backward compatible with admin tokens

**Dependencies:** Task 2.1, Task 2.2

**Estimated Time:** 2 hours

**Parallel:** Can run with 4.2

---

#### Task 4.2: BYOLLM Router LLM

**File:** `src/routing/router-llm/byollm-router-llm.ts`

**Description:** Implement BYOLLM-aware router LLM wrapper.

**Acceptance Criteria:**
- [ ] BYOLLMRouterLLM class implements RouterLLM
- [ ] Accepts userLLMKeys in context
- [ ] Creates temporary router with user keys if provided
- [ ] Falls back to system router otherwise
- [ ] Logs which keys were used

**Dependencies:** Task 2.3

**Estimated Time:** 3 hours

**Parallel:** Can run with 4.1

---

#### Task 4.3: Routing Engine Enhancement

**File:** `src/routing/engine.ts` (modify)

**Description:** Enhance routing engine to support BYOLLM.

**Acceptance Criteria:**
- [ ] Load user LLM keys for BYOLLM tier users
- [ ] Pass keys to router LLM
- [ ] Log warning if BYOLLM user has no keys
- [ ] Update dependencies interface

**Dependencies:** Task 4.2

**Estimated Time:** 2 hours

**Parallel:** None

---

#### Task 4.4: App.ts Integration

**File:** `src/app.ts` (modify)

**Description:** Integrate all new routes and middleware.

**Acceptance Criteria:**
- [ ] Mount user routes at /api/users
- [ ] Mount anonymous routes at /api/anonymous
- [ ] Mount token routes at /api/tokens
- [ ] Mount LLM key routes at /api/llm-keys
- [ ] Apply tier rate limiter to /route
- [ ] Initialize new stores
- [ ] Update dependencies

**Dependencies:** All Phase 3 tasks

**Estimated Time:** 2 hours

**Parallel:** None

---

### 12.3 Task Assignment for Parallel Execution

**Agent 1 (Data Models & Types):**
- Task 1.1: User Data Models & Types
- Task 1.2: LLM Key Types
- Task 2.2: Token Store Enhancement

**Agent 2 (Security & Crypto):**
- Task 1.3: Password Hashing Utilities
- Task 1.4: LLM Key Encryption Utilities
- Task 2.3: User LLM Key Store

**Agent 3 (User Management):**
- Task 2.1: User Store Implementation
- Task 3.1: User Registration Routes
- Task 3.2: User Login Routes
- Task 3.6: User Profile Routes

**Agent 4 (Sessions & Rate Limiting):**
- Task 1.5: Rate Limit Configuration
- Task 2.4: Anonymous Session Store
- Task 2.5: Tier Rate Limiter
- Task 3.3: Anonymous Session Routes

**Agent 5 (Token & BYOLLM):**
- Task 3.4: Token Management Routes
- Task 3.5: LLM Key Management Routes
- Task 4.2: BYOLLM Router LLM

**Agent 6 (Integration):**
- Task 4.1: Enhanced Auth Middleware
- Task 4.3: Routing Engine Enhancement
- Task 4.4: App.ts Integration

---

## 13. Migration Plan

### 13.1 Backward Compatibility

The new system runs in parallel with existing admin tokens:

1. **Existing admin tokens continue to work:**
   - If token has no `user_id`, treat as legacy admin token
   - Apply admin tier (unlimited rate limits)
   - Use system LLM keys

2. **No database migration required:**
   - New fields are optional (user_id = null for legacy)
   - New Redis keys don't conflict with existing

3. **Gradual adoption:**
   - Users can self-register
   - Admin can still create tokens via existing API

### 13.2 Migration Steps

```
Step 1: Deploy Phase 1-4 code (feature flagged OFF)
Step 2: Run in shadow mode (log what would change)
Step 3: Enable feature flag for new user registration
Step 4: Monitor for issues
Step 5: Announce to existing users
Step 6: Deprecation timeline for admin-only token creation (optional)
```

### 13.3 Feature Flag

```typescript
// src/config.ts
export const FEATURE_FLAGS = {
  USER_SELF_SERVICE: process.env.FEATURE_USER_SELF_SERVICE === 'true',
};
```

---

## 14. Configuration

### 14.1 New Environment Variables

```bash
# User Authentication
LLM_KEY_ENCRYPTION_KEY=64_hex_characters_here  # Required for BYOLLM

# Rate Limits (optional, has defaults)
RATE_LIMIT_FREE_HOUR=10
RATE_LIMIT_FREE_DAY=50
RATE_LIMIT_FREE_BURST=5
RATE_LIMIT_PAID_SYSTEM_HOUR=100
RATE_LIMIT_PAID_SYSTEM_DAY=1000
RATE_LIMIT_PAID_SYSTEM_BURST=20
RATE_LIMIT_BYOLLM_HOUR=1000
RATE_LIMIT_BYOLLM_DAY=-1  # -1 = unlimited
RATE_LIMIT_BYOLLM_BURST=100

# Feature Flags
FEATURE_USER_SELF_SERVICE=true

# Anonymous Sessions
ANONYMOUS_SESSION_TTL_DAYS=7
MAX_TOKENS_PER_USER=10
```

### 14.2 Updated .env.example

Add to existing `.env.example`:

```bash
# ========================================
# User Authentication & BYOLLM
# ========================================

# REQUIRED: Encryption key for user LLM API keys (64 hex characters)
# Generate with: openssl rand -hex 32
LLM_KEY_ENCRYPTION_KEY=

# Rate limits per tier (defaults shown)
# RATE_LIMIT_FREE_HOUR=10
# RATE_LIMIT_FREE_DAY=50
# RATE_LIMIT_PAID_SYSTEM_HOUR=100
# RATE_LIMIT_PAID_SYSTEM_DAY=1000
# RATE_LIMIT_BYOLLM_HOUR=1000
# RATE_LIMIT_BYOLLM_DAY=-1

# Feature flags
FEATURE_USER_SELF_SERVICE=false

# User limits
# MAX_TOKENS_PER_USER=10
# ANONYMOUS_SESSION_TTL_DAYS=7
```

---

## 15. Open Questions

### Resolved

1. **Q:** Should we support password reset?
   **A:** Out of scope for initial release. Design schema to support later.

2. **Q:** Should BYOLLM users be able to mix system and user keys?
   **A:** No. If user has ANY keys configured, use only user keys.

3. **Q:** What happens if both user keys fail?
   **A:** Return error. Do not fall back to system keys (user pays for their LLM).

### Open (Require PM Decision Before Implementation)

1. **Q:** Should anonymous sessions be IP-limited?
   **Recommendation:** Yes, limit to 5 anonymous sessions per IP per day to prevent abuse.

2. **Q:** Should we send email on account creation?
   **Recommendation:** Not in initial release, but design for future.

3. **Q:** Should tier upgrades be immediate or require manual approval?
   **Recommendation:** Manual admin approval for now until billing is integrated.

---

## Appendix A: File Structure

```
src/
├── users/
│   ├── types.ts              # User, UserTier, UserStatus types
│   ├── store.ts              # UserStore interface & implementations
│   ├── password.ts           # Password hashing utilities
│   ├── validation.ts         # Email/password validation
│   ├── routes.ts             # Registration, login, profile routes
│   ├── index.ts              # Exports
│   ├── anonymous/
│   │   ├── types.ts          # AnonymousSession type
│   │   ├── store.ts          # AnonymousSessionStore
│   │   ├── routes.ts         # Session routes
│   │   └── index.ts
│   └── llm-keys/
│       ├── types.ts          # UserLLMKey, LLMProvider types
│       ├── encryption.ts     # AES-256-GCM encryption
│       ├── store.ts          # UserLLMKeyStore
│       ├── validation.ts     # Key validation service
│       ├── routes.ts         # Key management routes
│       └── index.ts
├── tokens/
│   ├── types.ts              # TokenConfigExtended (new)
│   ├── store.ts              # Enhanced with user_id
│   ├── routes.ts             # Admin routes (existing)
│   ├── user-routes.ts        # User token management (new)
│   └── index.ts
├── middleware/
│   ├── rate-limit.ts         # Existing rate limiter
│   ├── rate-limit-config.ts  # Tier configuration (new)
│   ├── tier-rate-limit.ts    # Tier-aware limiter (new)
│   └── index.ts
├── auth/
│   ├── middleware.ts         # Enhanced with user loading
│   └── index.ts
├── routing/
│   ├── router-llm/
│   │   ├── byollm-router-llm.ts  # BYOLLM wrapper (new)
│   │   └── ...existing files
│   ├── engine.ts             # Enhanced with BYOLLM support
│   └── ...existing files
└── app.ts                    # Updated with new routes

test/
├── users/
│   ├── store.test.ts
│   ├── password.test.ts
│   ├── validation.test.ts
│   ├── routes.test.ts
│   ├── anonymous/
│   │   └── store.test.ts
│   └── llm-keys/
│       ├── encryption.test.ts
│       ├── store.test.ts
│       └── routes.test.ts
├── integration/
│   ├── user-registration.test.ts
│   ├── anonymous-session.test.ts
│   └── byollm.test.ts
└── security/
    ├── auth.test.ts
    └── encryption.test.ts
```

---

## Appendix B: Interface Contracts

These interfaces define the contracts between components, allowing parallel implementation.

### B.1 UserStore Interface

```typescript
// src/users/store.ts
export interface UserStore {
  create(request: UserCreateRequest): Promise<User>;
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  update(id: string, request: UserUpdateRequest): Promise<User | null>;
  delete(id: string): Promise<boolean>;
  authenticate(email: string, password: string): Promise<User | null>;
  list(): Promise<User[]>;
}
```

### B.2 UserLLMKeyStore Interface

```typescript
// src/users/llm-keys/store.ts
export interface UserLLMKeyStore {
  setKey(userId: string, request: UserLLMKeyCreateRequest): Promise<UserLLMKey>;
  getKeys(userId: string): Promise<UserLLMKey[]>;
  getDecryptedKeys(userId: string): Promise<DecryptedLLMKey[]>;
  deleteKey(userId: string, provider: LLMProvider): Promise<boolean>;
  updateValidationStatus(
    userId: string,
    provider: LLMProvider,
    status: 'valid' | 'invalid' | 'unknown',
    error?: string
  ): Promise<void>;
}
```

### B.3 AnonymousSessionStore Interface

```typescript
// src/users/anonymous/store.ts
export interface AnonymousSessionStore {
  create(): Promise<{ session: AnonymousSession; token: string }>;
  getBySessionId(sessionId: string): Promise<AnonymousSession | null>;
  getByTokenId(tokenId: string): Promise<AnonymousSession | null>;
  incrementRequestCount(sessionId: string): Promise<number>;
  delete(sessionId: string): Promise<boolean>;
}
```

### B.4 Enhanced TokenStore Interface

```typescript
// src/tokens/store.ts (additions)
export interface TokenStore {
  // ... existing methods ...
  getByUserId(userId: string): Promise<TokenConfig[]>;
  setPrimary(tokenId: string, userId: string): Promise<void>;
  countByUserId(userId: string): Promise<number>;
}
```

---

**Design Complete**

This document provides a comprehensive blueprint for implementing user authentication and BYOLLM features in Wayfinder. The design maintains backward compatibility with existing admin tokens while enabling self-service user registration and LLM key management.

Implementation should follow the phased approach in Section 12, with tasks assigned to parallel agents according to Section 12.3.
