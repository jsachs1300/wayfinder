# Frontend Session Design (Wayfinder)

## Overview
Frontend sessions are required for user login, session validation, logout, and admin elevation. All session data is stored in Redis on the backend. Sessions are represented by a session token returned on login and sent with subsequent requests.

## Headers
- `X-Session-Token`: session token issued by `POST /api/sessions/login`
- `X-Admin-Api-Key`: admin key (only used for session elevation)

## Session Endpoints

### POST /api/sessions/login
Authenticate a user and create a session.

**Body**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response**
```json
{
  "session_token": "uuid-v4",
  "session": {
    "id": "uuid-v4",
    "token_id": "uuid-v4",
    "user_id": "user-id",
    "is_admin": false,
    "created_at": "2026-01-01T00:00:00.000Z",
    "last_seen_at": "2026-01-01T00:00:00.000Z",
    "expires_at": "2026-01-08T00:00:00.000Z"
  },
  "user": { "...": "sanitized user object" },
  "tokens": [ { "...": "sanitized token" } ]
}
```

### POST /api/sessions/validate
Validate a session token and return session + user data.

**Headers**
- `X-Session-Token: <session_token>`

**Response**
```json
{
  "session": { "...": "session fields" },
  "user": { "...": "sanitized user object" },
  "tokens": [ { "...": "sanitized token" } ]
}
```

### POST /api/sessions/logout
Invalidate the current session.

**Headers**
- `X-Session-Token: <session_token>`

**Response**
```json
{
  "message": "Session cleared",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

### POST /api/sessions/elevate
Elevate a user session to admin privileges.

**Headers**
- `X-Session-Token: <session_token>`

**Body**
```json
{
  "admin_api_key": "ADMIN_API_KEY"
}
```

**Response**
```json
{
  "session_token": "uuid-v4",
  "session": { "...": "session fields (is_admin: true)" },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

## Admin Access via Session
Session elevation returns a **new** `session_token`. The frontend must replace the stored token with the new one before calling admin endpoints.

Examples:
- `GET /admin/tokens`
- `GET /admin/models`
- `POST /admin/tokens`

## Session Usage Patterns
- After login, store `session_token` in memory (preferred) or sessionStorage.
- Attach `X-Session-Token` to all user-facing API calls:
  - `GET /api/users/me`
  - `GET /api/tokens`
  - `POST /api/llm-keys`
- If a request returns `401`, prompt for login again.

## Error Handling
Standard error format:
```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired session",
  "timestamp": "..."
}
```
