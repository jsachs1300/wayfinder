import {
  IntentClassifier,
  isValidIntentLabel,
  isCanonicalIntent,
} from '../intent';
import { ModelRegistry } from '../models';
import {
  IntentLabel,
  RoutingInferenceRecord,
  RoutingInferenceResult,
  RouterModelSelection,
} from '../types';

const INTENT_VERSION = 1;

export const ROUTER_LLM_PROMPT = `You are an objective, vendor-neutral judge with no bias.

Your task is to determine which large language model (LLM) is best suited to handle the given prompt.

Do not answer the prompt itself.

Evaluate models based on overall efficiency, considering:

expected response quality for this task

cost efficiency

latency

You must return:

the single best LLM for this prompt

the best alternate LLM

a confidence score from 0 to 10 indicating how confident you are that the primary choice is optimal

concise reasoning (maximum 3 sentences) for both the primary and alternate choices

an intent categorization for the prompt

Classify intent using exactly one of the following values:
code_change
debugging
architecture_design
explanation
summarization
data_analysis
content_generation
planning
other

Do not use 'other' unless none of the listed intents reasonably apply.
If 'other' is used, append a single-word subtype in the format other:<subcategory> (lowercase, no spaces).

Respond only with valid JSON matching the required schema. Do not include any additional text.`;

const INTENT_HINTS: Record<string, string[]> = {
  code_change: ['code_change', 'coding', 'code_review'],
  debugging: ['debugging', 'coding', 'planning'],
  architecture_design: ['architecture_design', 'explanation'],
  explanation: ['explanation', 'explanation', 'planning'],
  summarization: ['summarization'],
  data_analysis: ['data_analysis', 'explanation'],
  content_generation: ['content_generation', 'content_generation'],
  planning: ['planning', 'planning', 'summarization'],
};

export interface RoutingInferenceInput {
  prompt: string;
  availableModels?: string[];
  prefer_model?: string;
}

export class RoutingInferenceEngine {
  private cache: Map<string, RoutingInferenceRecord> = new Map();
  private intentClassifier: IntentClassifier;
  private modelRegistry: ModelRegistry;

  constructor(intentClassifier: IntentClassifier, modelRegistry: ModelRegistry) {
    this.intentClassifier = intentClassifier;
    this.modelRegistry = modelRegistry;
  }

  infer(input: RoutingInferenceInput): RoutingInferenceRecord {
    const cacheKey = this.buildCacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const intentResult = this.intentClassifier.classify(input.prompt);
    const intent = this.normalizeIntent(intentResult.label);
    const { primary, alternate } = this.selectModels(intent, input);

    const record: RoutingInferenceRecord = {
      primary,
      alternate,
      confidence: this.scaleConfidence(intentResult.confidence),
      intent,
      intent_version: INTENT_VERSION,
      timestamp: new Date().toISOString(),
    };

    this.validateInference(record);
    this.cache.set(cacheKey, record);
    return record;
  }

  private buildCacheKey(input: RoutingInferenceInput): string {
    return JSON.stringify({
      prompt: input.prompt,
      available: input.availableModels?.slice().sort(),
      prefer: input.prefer_model,
    });
  }

  private selectModels(
    intent: IntentLabel,
    input: RoutingInferenceInput
  ): { primary: RouterModelSelection; alternate: RouterModelSelection } {
    const availableModels = (input.availableModels?.length
      ? input.availableModels
      : this.modelRegistry.getAvailableModels().map((m) => m.id)
    ).filter((id) => this.modelRegistry.isValidModel(id));

    const scored = availableModels.map((modelId) => {
      const model = this.modelRegistry.getModel(modelId);
      const hints = INTENT_HINTS[intent] ?? [];
      const score = model
        ? hints.reduce((acc, hint) =>
            model.capabilities.includes(hint) ? acc + 1 : acc
          , 0)
        : 0;
      return { modelId, score };
    });

    scored.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));

    const preferredModel = input.prefer_model;
    const primaryId =
      preferredModel && this.modelRegistry.isValidModel(preferredModel)
        ? preferredModel
        : scored[0]?.modelId ?? this.modelRegistry.getDefaultModel();

    const alternateId =
      scored.find((entry) => entry.modelId !== primaryId)?.modelId ?? primaryId;

    return {
      primary: {
        model: primaryId,
        reason: this.buildReason(primaryId, intent, preferredModel ? 'preferred' : 'scored'),
      },
      alternate: {
        model: alternateId,
        reason: this.buildReason(alternateId, intent, 'fallback'),
      },
    };
  }

  private buildReason(
    modelId: string,
    intent: IntentLabel,
    strategy: 'preferred' | 'scored' | 'fallback'
  ): string {
    if (strategy === 'preferred') {
      return `${modelId} was requested directly and is valid for this routing decision.`;
    }

    if (strategy === 'fallback') {
      return `${modelId} is a secondary option with solid coverage for ${intent}.`;
    }

    return `${modelId} aligns well with the ${intent} intent based on registry capabilities.`;
  }

  private scaleConfidence(rawConfidence: number): number {
    const scaled = Math.round(rawConfidence * 10);
    if (Number.isNaN(scaled)) return 0;
    return Math.min(10, Math.max(0, scaled));
  }

  private normalizeIntent(intent: IntentLabel): IntentLabel {
    if (isCanonicalIntent(intent)) {
      return intent;
    }

    if (isValidIntentLabel(intent)) {
      return intent;
    }

    return 'other:general';
  }

  private validateInference(inference: RoutingInferenceResult): void {
    this.ensureModelValid(inference.primary.model);
    this.ensureModelValid(inference.alternate.model);

    if (!isValidIntentLabel(inference.intent)) {
      throw new Error('Intent must follow canonical rules');
    }

    if (inference.confidence < 0 || inference.confidence > 10) {
      throw new Error('Confidence must be between 0 and 10');
    }

    if (this.countSentences(inference.primary.reason) > 3) {
      throw new Error('Primary reason must not exceed 3 sentences');
    }

    if (this.countSentences(inference.alternate.reason) > 3) {
      throw new Error('Alternate reason must not exceed 3 sentences');
    }
  }

  private ensureModelValid(modelId: string): void {
    this.modelRegistry.assertModelExists(modelId, 'routing');
  }

  private countSentences(text: string): number {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0).length;
  }
}
