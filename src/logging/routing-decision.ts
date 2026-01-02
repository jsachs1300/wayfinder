/**
 * DEPRECATED: Legacy logging for old routing response structure
 *
 * This module is deprecated and will be removed in favor of
 * simplified logging for the canonical RouteDecision contract.
 */

import type { RoutingDecisionLog, TokenConfig, RoutingReason } from '../types/index';

/**
 * DEPRECATED: Create a routing decision log from routing response and token config
 *
 * This function is deprecated and stubbed out. The new canonical contract
 * uses a simplified response structure that doesn't include internal context.
 */
export function createRoutingDecisionLog(
  _response: unknown,
  _tokenConfig: TokenConfig,
): RoutingDecisionLog {
  throw new Error(
    'createRoutingDecisionLog is deprecated. Use simplified logging for canonical RouteDecision contract.',
  );
}

/**
 * DEPRECATED: Validate routing decision log for behavioral guarantees
 */
export function validateRoutingDecisionLog(_log: RoutingDecisionLog): void {
  // Stubbed - deprecated in favor of canonical contract
}

/**
 * DEPRECATED: Emit routing decision log
 */
export function emitRoutingDecisionLog(_log: RoutingDecisionLog): void {
  // Stubbed - deprecated in favor of canonical contract
}
