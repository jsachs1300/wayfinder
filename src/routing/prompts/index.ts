/**
 * Router Prompt Module (v1.0)
 *
 * This module provides the frozen v1.0 router prompt and configuration.
 * The prompt is schema-driven and config-driven with no hardcoded values.
 */

export {
  buildRouterPrompt,
  getRouteDecisionSchema,
  getCanonicalIntentList,
  type RouterPromptConfig,
} from './builder.js';
