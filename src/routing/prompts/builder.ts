/**
 * Router Prompt Builder (v1.0)
 *
 * This module handles prompt construction for the router LLM.
 * It injects runtime values into the frozen v1.0 prompt template.
 *
 * Placeholders:
 * - {{ROUTER_JSON_SCHEMA}} - The canonical RouteDecision schema
 * - {{INTENT_LIST}} - Authoritative list of allowed intents
 * - {{MODEL_LIST}} - Authoritative list of eligible models
 * - {{USER_PROMPT}} - The user's request
 */

/**
 * Router prompt configuration
 */
export interface RouterPromptConfig {
  /** JSON schema for RouteDecision (will be stringified) */
  schema: object;
  /** List of allowed intent values */
  intentList: string[];
  /** List of eligible model identifiers */
  modelList: string[];
  /** User's request/prompt */
  userPrompt: string;
}

/**
 * Frozen v1.0 Router Prompt Template
 *
 * This is the canonical router prompt with placeholders for runtime injection.
 * Stored as an inline constant for distribution simplicity.
 */
const ROUTER_PROMPT_V1_0 = `You are a model routing system. Your task is to select the best primary model and best alternate model for a user request.

RESPONSE FORMAT

Return JSON only. No markdown, no prose, no code blocks.

The JSON must exactly match this schema:

{{ROUTER_JSON_SCHEMA}}

INTENT CLASSIFICATION

Select intent from this list only:

{{INTENT_LIST}}

If no intent applies, use: other:<category>
where <category> is exactly one lowercase word describing the request type.

MODEL SELECTION

Select models from this list only:

{{MODEL_LIST}}

You must return exactly one primary and one alternate.

SCORING RULES

Scores are integers from 0 to 10.

10 = clear best choice with low risk and meaningful advantage
7 = solid choice with notable tradeoffs
5 = marginally acceptable fallback
0–3 = poor or unsuitable fit

primary.score must be >= alternate.score

Use close scores when the decision is marginal.

COST AWARENESS

Prefer more efficient models when capability differences are small.
Cost influences score deltas and ordering.
Do not downgrade a clearly better model solely due to cost.

REASON FIELD

Write short, concrete reasons tied directly to the request.
Do not mention routing systems, policies, or internal mechanics.

USER REQUEST

{{USER_PROMPT}}`;

function getPromptTemplate(): string {
  return ROUTER_PROMPT_V1_0;
}

/**
 * Build the router LLM prompt with injected runtime values
 *
 * @param config - Configuration with schema, intent list, model list, and user prompt
 * @returns Fully constructed prompt ready for LLM invocation
 */
export function buildRouterPrompt(config: RouterPromptConfig): string {
  const template = getPromptTemplate();

  // Format schema as indented JSON for readability
  const schemaJson = JSON.stringify(config.schema, null, 2);

  // Format intent list as bullet points
  const intentList = config.intentList.map((intent) => `- ${intent}`).join('\n');

  // Format model list as bullet points
  const modelList = config.modelList.map((model) => `- ${model}`).join('\n');

  // Inject all placeholders
  return template
    .replace('{{ROUTER_JSON_SCHEMA}}', schemaJson)
    .replace('{{INTENT_LIST}}', intentList)
    .replace('{{MODEL_LIST}}', modelList)
    .replace('{{USER_PROMPT}}', config.userPrompt);
}

/**
 * Get the canonical RouteDecision schema for prompt injection
 *
 * This is the authoritative schema definition that will be sent to the router LLM.
 * It must match the Zod schema in validation.ts exactly.
 *
 * Key constraints mirrored from validation.ts:
 * - All string fields require minLength: 1 (non-empty)
 * - Score is type: number (not integer) to match z.number()
 * - All nested objects disallow additional properties
 */
export function getRouteDecisionSchema(): object {
  return {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        minLength: 1,
        description: 'Intent classification (must be from allowed list or other:<category>)',
      },
      primary: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            minLength: 1,
            description: 'Model identifier (must be from allowed list)',
          },
          score: {
            type: 'number',
            minimum: 0,
            maximum: 10,
            description: 'Confidence score (0-10)',
          },
          reason: {
            type: 'string',
            minLength: 1,
            description: 'Short, concrete reason for this recommendation',
          },
        },
        required: ['model', 'score', 'reason'],
        additionalProperties: false,
      },
      alternate: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            minLength: 1,
            description: 'Model identifier (must be from allowed list)',
          },
          score: {
            type: 'number',
            minimum: 0,
            maximum: 10,
            description: 'Confidence score (0-10, must be <= primary.score)',
          },
          reason: {
            type: 'string',
            minLength: 1,
            description: 'Short, concrete reason for this recommendation',
          },
        },
        required: ['model', 'score', 'reason'],
        additionalProperties: false,
      },
    },
    required: ['intent', 'primary', 'alternate'],
    additionalProperties: false,
  };
}

/**
 * Get the canonical intent list for prompt injection
 *
 * This list is the authoritative set of allowed intents from REQUIREMENTS.md.
 * The router LLM must select from this list or use other:<category>.
 */
export function getCanonicalIntentList(): string[] {
  return [
    'code_change',
    'debugging',
    'architecture_design',
    'explanation',
    'summarization',
    'data_analysis',
    'content_generation',
    'planning',
  ];
}
