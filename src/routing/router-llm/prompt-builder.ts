/**
 * Router LLM Prompt Builder
 *
 * Constructs the canonical prompt for the router LLM.
 * The prompt MUST instruct the LLM to return a RouteDecision conforming to the schema.
 */

import type { TokenConfig } from '../../types/index.js';

/**
 * Context for building the routing prompt
 */
export interface PromptContext {
  /** User's prompt to route */
  prompt: string;

  /** List of eligible models (after policy constraints) */
  eligibleModels: string[];

  /** Token configuration */
  tokenConfig: TokenConfig;

  /** Optional preferred model */
  preferModel?: string;

  /** Optional request metadata */
  requestMetadata?: Record<string, unknown>;
}

/**
 * Builds the routing prompt for the router LLM
 *
 * The prompt MUST:
 * - Clearly define the task (select primary and alternate models)
 * - Specify the exact JSON schema for RouteDecision
 * - Provide the user's prompt and eligible models
 * - Request intent inference (advisory only)
 * - Request confidence scores (0-10 scale)
 * - Request explanations for recommendations
 *
 * @param context - Prompt building context
 * @returns Formatted prompt string
 */
export function buildRoutingPrompt(context: PromptContext): string {
  const { prompt, eligibleModels, preferModel } = context;

  // Build the system instructions
  const systemInstructions = `You are a router that selects the best LLM model for a given user prompt.

Your task is to analyze the user's prompt and select:
1. A PRIMARY model - the best model for this specific task
2. An ALTERNATE model - a viable alternative with different strengths

IMPORTANT RULES:
- You MUST select from the eligible models provided
- You MUST provide a confidence score (0-10 scale) for each recommendation
- You MUST provide a clear explanation for each selection
- You MUST infer the user's intent (e.g., "coding", "creative writing", "data analysis")
- Intent is advisory only - focus on selecting the best models

RESPONSE FORMAT:
You MUST respond with valid JSON matching this exact schema:

{
  "intent": "string describing the inferred intent",
  "primary": {
    "model": "model identifier from eligible models",
    "score": number between 0-10,
    "reason": "explanation for why this model is best"
  },
  "alternate": {
    "model": "different model identifier from eligible models",
    "score": number between 0-10,
    "reason": "explanation for why this is a good alternative"
  }
}

SCORING GUIDANCE:
- 9-10: Excellent match, model is ideal for this task
- 7-8: Good match, model is well-suited
- 5-6: Adequate match, model can handle this
- 3-4: Marginal match, model may struggle
- 0-2: Poor match, not recommended

NO ADDITIONAL PROPERTIES are allowed in the response.
`;

  // Build the eligible models list
  const modelsSection = `ELIGIBLE MODELS:
${eligibleModels.map((model) => `- ${model}`).join('\n')}`;

  // Build prefer model hint if present
  const preferSection = preferModel
    ? `\nUSER PREFERENCE:
The user has expressed a preference for: ${preferModel}
Consider this preference but select based on task suitability.`
    : '';

  // Build the user prompt section
  const userPromptSection = `USER PROMPT:
"""
${prompt}
"""`;

  // Build the final instruction
  const finalInstruction = `
Analyze the user prompt above and respond with your routing decision in the exact JSON format specified.`;

  // Combine all sections
  return [
    systemInstructions,
    modelsSection,
    preferSection,
    userPromptSection,
    finalInstruction,
  ]
    .filter(Boolean)
    .join('\n\n');
}
