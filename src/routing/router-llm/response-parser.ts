/**
 * Router LLM Response Parser
 *
 * Parses and validates router LLM responses against the canonical RouteDecision schema.
 * MUST fail hard on invalid responses - no auto-repair or inference.
 */

import { validateRouteDecision } from '../validation.js';
import type { RouteDecision } from '../../types/index.js';
import { RouterLLMParseError, RouterLLMValidationError } from './errors.js';

/**
 * Parses a router LLM response into a validated RouteDecision
 *
 * Steps:
 * 1. Parse raw response as JSON
 * 2. Validate against RouteDecision schema using Zod
 * 3. Return validated decision
 *
 * @param rawResponse - Raw text response from LLM provider
 * @returns Validated RouteDecision
 * @throws RouterLLMParseError if JSON parsing fails
 * @throws RouterLLMValidationError if schema validation fails
 */
export function parseRouteDecision(rawResponse: string): RouteDecision {
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
  try {
    return validateRouteDecision(parsed);
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
 * @returns Validated RouteDecision
 * @throws RouterLLMParseError if JSON extraction/parsing fails
 * @throws RouterLLMValidationError if schema validation fails
 */
export function parseRouteDecisionLenient(rawResponse: string): RouteDecision {
  const extracted = extractJSON(rawResponse);
  return parseRouteDecision(extracted);
}
