/**
 * Router LLM Contract Validation
 *
 * This module provides strict validation for the canonical RouteDecision schema.
 * Validation MUST fail hard if the router LLM output violates the schema.
 * No auto-repair, inference, or substitution is permitted.
 */

import { z } from 'zod';

/**
 * ModelRecommendation schema
 * Validates individual model recommendations with score and reasoning
 */
export const ModelRecommendationSchema = z
  .object({
    model: z.string().min(1, 'Model identifier is required'),
    score: z
      .number()
      .min(0, 'Score must be between 0 and 10')
      .max(10, 'Score must be between 0 and 10'),
    reason: z.string().min(1, 'Reason is required'),
  })
  .strict(); // No additional properties allowed

/**
 * RouteDecision schema (Router LLM output)
 * Canonical contract for all routing decisions
 *
 * Requirements:
 * - intent: free text string (advisory only, for internal analysis)
 * - primary: exactly one ModelRecommendation
 * - alternate: exactly one ModelRecommendation
 * - No additional properties allowed anywhere
 */
export const RouteDecisionSchema = z
  .object({
    intent: z.string().min(1, 'Intent is required'),
    primary: ModelRecommendationSchema,
    alternate: ModelRecommendationSchema,
  })
  .strict(); // No additional properties allowed

/**
 * Validates a router LLM response against the canonical schema
 *
 * @param data - Unvalidated data from router LLM
 * @returns Validated RouteDecision
 * @throws ZodError if validation fails (fail hard, no auto-repair)
 */
export function validateRouteDecision(data: unknown): {
  intent: string;
  primary: { model: string; score: number; reason: string };
  alternate: { model: string; score: number; reason: string };
} {
  return RouteDecisionSchema.parse(data);
}

/**
 * Safe validation that returns success/error result instead of throwing
 *
 * @param data - Unvalidated data from router LLM
 * @returns Validation result with parsed data or error
 */
export function safeValidateRouteDecision(data: unknown) {
  return RouteDecisionSchema.safeParse(data);
}
