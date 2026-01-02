/**
 * Router LLM Response Parser
 *
 * Parses and validates router LLM responses against the canonical RouteDecision schema.
 * MUST fail hard on invalid responses - no auto-repair or inference.
 */

import { validateRouteDecision } from '../validation';
import type { RouteDecision } from '../../types/index';
import {
  RouterLLMParseError,
  RouterLLMValidationError,
  RouterLLMPolicyBypassError
} from './errors';

/**
 * Validates that selected models are in the eligible set
 *
 * This is a critical security check that prevents the LLM from bypassing
 * policy constraints by hallucinating or selecting unauthorized models.
 *
 * @param decision - Validated RouteDecision
 * @param eligibleModels - Models that were marked eligible by policy
 * @throws RouterLLMPolicyBypassError if selected model is not eligible
 */
function validateModelEligibility(
  decision: RouteDecision,
  eligibleModels: string[]
): void {
  const eligibleSet = new Set(eligibleModels);

  // Validate primary model
  if (!eligibleSet.has(decision.primary.model)) {
    throw new RouterLLMPolicyBypassError(
      `Router LLM selected primary model "${decision.primary.model}" which is not in the eligible set. ` +
      `This indicates the LLM ignored policy constraints or hallucinated a model name. ` +
      `Eligible models: [${eligibleModels.join(', ')}]`,
      decision.primary.model,
      eligibleModels,
      'primary'
    );
  }

  // Validate alternate model
  if (!eligibleSet.has(decision.alternate.model)) {
    throw new RouterLLMPolicyBypassError(
      `Router LLM selected alternate model "${decision.alternate.model}" which is not in the eligible set. ` +
      `This indicates the LLM ignored policy constraints or hallucinated a model name. ` +
      `Eligible models: [${eligibleModels.join(', ')}]`,
      decision.alternate.model,
      eligibleModels,
      'alternate'
    );
  }
}

/**
 * Parses a router LLM response into a validated RouteDecision
 *
 * Steps:
 * 1. Parse raw response as JSON
 * 2. Validate against RouteDecision schema using Zod
 * 3. Validate selected models are in eligible set (security check)
 * 4. Return validated decision
 *
 * @param rawResponse - Raw text response from LLM provider
 * @param eligibleModels - Models that policy marked as eligible (REQUIRED for security)
 * @returns Validated RouteDecision
 * @throws RouterLLMParseError if JSON parsing fails
 * @throws RouterLLMValidationError if schema validation fails
 * @throws RouterLLMPolicyBypassError if selected models not in eligible set
 */
export function parseRouteDecision(
  rawResponse: string,
  eligibleModels: string[]
): RouteDecision {
  // Step 1: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch (error) {
    throw new RouterLLMParseError(
      'Failed to parse router LLM response as JSON',
      rawResponse,
      error instanceof Error ? error : undefined
    );
  }

  // Step 2: Validate against schema
  let decision: RouteDecision;
  try {
    decision = validateRouteDecision(parsed);
  } catch (error) {
    // Extract validation errors from Zod error
    const validationErrors: string[] = [];
    if (error && typeof error === 'object' && 'errors' in error) {
      const zodError = error as { errors: Array<{ message: string; path: Array<string | number> }> };
      validationErrors.push(
        ...zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
      );
    } else if (error instanceof Error) {
      validationErrors.push(error.message);
    }

    throw new RouterLLMValidationError(
      'Router LLM response failed schema validation',
      validationErrors,
      error instanceof Error ? error : undefined
    );
  }

  // Step 3: Validate model eligibility (CRITICAL SECURITY CHECK)
  validateModelEligibility(decision, eligibleModels);

  // Step 4: Return validated decision
  return decision;
}

/**
 * Extracts JSON from a response that may contain additional text
 *
 * Some LLMs may wrap JSON in markdown code blocks or add explanatory text.
 * This function attempts to extract the JSON portion.
 *
 * @param response - Raw response that may contain JSON
 * @returns Extracted JSON string
 */
export function extractJSON(response: string): string {
  // Try to find JSON in markdown code blocks
  const codeBlockMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch && jsonMatch[0]) {
    return jsonMatch[0].trim();
  }

  // Return original if no JSON found
  return response.trim();
}

/**
 * Parses a router LLM response with JSON extraction
 *
 * This is a lenient version that attempts to extract JSON from responses
 * that may contain additional text or formatting.
 *
 * @param rawResponse - Raw text response from LLM provider
 * @param eligibleModels - Models that policy marked as eligible (REQUIRED for security)
 * @returns Validated RouteDecision
 * @throws RouterLLMParseError if JSON extraction/parsing fails
 * @throws RouterLLMValidationError if schema validation fails
 * @throws RouterLLMPolicyBypassError if selected models not in eligible set
 */
export function parseRouteDecisionLenient(
  rawResponse: string,
  eligibleModels: string[]
): RouteDecision {
  const extracted = extractJSON(rawResponse);
  return parseRouteDecision(extracted, eligibleModels);
}
