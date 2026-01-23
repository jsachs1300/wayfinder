import * as bcrypt from 'bcrypt';

const BCRYPT_WORK_FACTOR = 12;
export const DUMMY_PASSWORD_HASH =
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5jtRBzC3yRqb.';

/**
 * Hash password using bcrypt with work factor 12
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_WORK_FACTOR);
}

/**
 * Verify password against bcrypt hash
 * Uses constant-time comparison built into bcrypt
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
