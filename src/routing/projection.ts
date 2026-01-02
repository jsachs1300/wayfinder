/**
 * Routing Response Projection Layer
 *
 * Transforms internal RouteDecision (from router LLM) to user-facing RouteResponse.
 * Intent is dropped from user-facing responses as it's advisory only.
 */

import type { RouteDecision, RouteResponse } from '../types/index';

/**
 * Projects RouteDecision to user-facing RouteResponse
 *
 * Transformation:
 * - Drops intent field (advisory only, for internal analysis)
 * - Preserves primary and alternate recommendations
 * - Adds request_id for tracing
 *
 * No field names or nesting changes between internal and external representations
 * beyond dropping intent.
 *
 * @param decision - Validated RouteDecision from router LLM
 * @param requestId - Request identifier for tracing
 * @returns User-facing RouteResponse (excludes intent)
 */
export function projectRouteResponse(
  decision: RouteDecision,
  requestId: string,
): RouteResponse {
  return {
    primary: decision.primary,
    alternate: decision.alternate,
    request_id: requestId,
  };
}
