/**
 * Password validation utilities
 *
 * Implements password validation rules from design section 7.1
 */

export interface PasswordRequirements {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSpecial: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export const PASSWORD_REQUIREMENTS: PasswordRequirements = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecial: false, // Not required but allowed
};

/**
 * Validate password against requirements
 *
 * @param password - Password to validate
 * @returns ValidationResult with valid flag and error messages
 */
export function validatePassword(password: string): ValidationResult {
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

/**
 * Email validation regex from design section 5.1
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate email format
 *
 * @param email - Email to validate
 * @returns True if valid email format
 */
export function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}
