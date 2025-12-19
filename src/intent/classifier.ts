import {
  CanonicalIntentLabel,
  IntentLabel,
  IntentClassification,
} from '../types';

const CANONICAL_INTENTS: CanonicalIntentLabel[] = [
  'code_change',
  'debugging',
  'architecture_design',
  'explanation',
  'summarization',
  'data_analysis',
  'content_generation',
  'planning',
];

const INTENT_LABELS: IntentLabel[] = [
  ...CANONICAL_INTENTS,
  'other:general',
  'other:legal',
];

/**
 * Intent classifier interface for swappability
 */
export interface IntentClassifier {
  classify(prompt: string): IntentClassification;
}

/**
 * Keyword patterns for each intent type
 */
const INTENT_PATTERNS: Record<IntentLabel, RegExp[]> = {
  code_change: [
    /\b(write|implement|create|build|develop)\b.*\b(code|function|class|script|program|component)/i,
    /\brefactor\b/i,
    /\b(update|modify|change)\b.*\b(code|logic)/i,
    /\b(add|implement)\b.*\b(feature)/i,
    /\breview\b.*\b(code|pr|pull\s+request|commit|diff)/i,
  ],
  debugging: [
    /\b(debug|fix)\b.*\b(bug|issue|error|problem)/i,
    /\berror\s+message\b/i,
    /\bstack\s*trace\b/i,
    /\bnot\s+working\b/i,
    /\bwhy\s+is\s+this\s+failing\b/i,
    /\bdebug(ging)?\b/i,
  ],
  architecture_design: [
    /\b(system|software|solution|api)\s+design\b/i,
    /\barchitecture\b/i,
    /\bdesign\s+(a|an)\s+(service|system|module)/i,
    /\bchoose\s+(a|the)\s+pattern\b/i,
    /\bhigh\s*level\s+approach\b/i,
    /\bmicroservice\s+architecture\b/i,
    /\bpattern\b/i,
  ],
  explanation: [
    /\bexplain\b/i,
    /\bwhy\s+does\b/i,
    /\bhow\s+does\b/i,
    /\bwalk\s+me\s+through\b/i,
    /\bwhat\s+is\s+the\s+reason\b/i,
    /\bcompare\s+and\s+contrast\b/i,
  ],
  summarization: [
    /summarize\s+(this|the)/i,
    /give\s+(me\s+)?a\s+summary/i,
    /tl;?dr/i,
    /key\s+(points|takeaways)/i,
    /main\s+(points|ideas)/i,
    /brief\s+overview/i,
    /in\s+short/i,
    /condense\s+(this|the)/i,
  ],
  data_analysis: [
    /analy(s|z)e\s+(this\s+)?data/i,
    /dataset/i,
    /csv/i,
    /derive\s+(insights|stats)/i,
    /run\s+(an\s+)?analysis/i,
    /data\s+summary/i,
  ],
  content_generation: [
    /write\s+(a\s+)?(story|poem|song|essay|article|blog|post)/i,
    /creative\s+(writing|content)/i,
    /brainstorm/i,
    /come\s+up\s+with\s+(ideas?|names?)/i,
    /imagine\s+(a|that)/i,
    /fiction(al)?/i,
  ],
  planning: [
    /plan\s+(a|the)?\s*(project|sprint|roadmap|tasks?)/i,
    /create\s+(a|the)?\s*(timeline|schedule|checklist)/i,
    /step\s+by\s+step\s+plan/i,
    /milestones?/i,
    /organize\s+(work|tasks)/i,
  ],
  'other:general': [], // Fallback
  'other:legal': [
    /\b(legal|law|lawyer|attorney|court|lawsuit|contract|liability)\b/i,
    /\b(compliance|regulation|regulatory|gdpr|hipaa|sox)\b/i,
    /\b(terms\s+of\s+service|privacy\s+policy|license|copyright)\b/i,
    /\b(sue|lawsuit|litigation|defendant|plaintiff)\b/i,
    /is\s+(this|it)\s+legal/i,
    /legal\s+(advice|opinion|question)/i,
  ],
};

/**
 * Weight multipliers for each intent (some are more specific than others)
 */
const INTENT_WEIGHTS: Record<IntentLabel, number> = {
  code_change: 1.2,
  debugging: 1.2,
  architecture_design: 1.1,
  explanation: 1.0,
  summarization: 1.1,
  data_analysis: 1.1,
  content_generation: 1.0,
  planning: 0.9,
  'other:general': 0.5,
  'other:legal': 1.3,
};

export function isCanonicalIntent(label: string): label is CanonicalIntentLabel {
  return (CANONICAL_INTENTS as string[]).includes(label);
}

export function isOtherIntent(label: string): label is `other:${string}` {
  return /^other:[a-z]+$/.test(label);
}

export function isValidIntentLabel(label: string): label is IntentLabel {
  return isCanonicalIntent(label) || isOtherIntent(label);
}

/**
 * Heuristic-based intent classifier using keyword patterns
 */
export class HeuristicIntentClassifier implements IntentClassifier {
  classify(prompt: string): IntentClassification {
    const normalizedPrompt = prompt.toLowerCase().trim();
    const scores = Object.fromEntries(
      INTENT_LABELS.map((intent) => [intent, 0])
    ) as Record<IntentLabel, number>;

    const quickHeuristics: Array<[IntentLabel, RegExp]> = [
      ['code_change', /(function|code|implement|feature|pull\s*request)/i],
      ['debugging', /(debug|bug|error|issue|stack\s*trace)/i],
      [
        'architecture_design',
        /(architecture|system design|microservice|design pattern|high level)/i,
      ],
    ];

    for (const [intent, pattern] of quickHeuristics) {
      if (pattern.test(normalizedPrompt)) {
        scores[intent] += INTENT_WEIGHTS[intent] ?? 0.1;
      }
    }

    // Calculate raw scores based on pattern matches
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      const intentLabel = intent as IntentLabel;
      for (const pattern of patterns) {
        if (pattern.test(normalizedPrompt)) {
          scores[intentLabel] += INTENT_WEIGHTS[intentLabel] ?? 0;
        }
      }
    }

    // Find the intent with the highest score
    let maxScore = 0;
    let selectedIntent: IntentLabel = 'other:general';
    let totalScore = 0;

    for (const [intent, score] of Object.entries(scores)) {
      totalScore += score;
      if (score > maxScore) {
        maxScore = score;
        selectedIntent = intent as IntentLabel;
      }
    }

    // If no patterns matched, default to 'other:general' with low confidence
    if (maxScore === 0) {
      return {
        label: 'other:general',
        confidence: 0.3,
        raw_scores: scores,
      };
    }

    // Calculate confidence based on score dominance
    // Higher confidence when one intent clearly dominates
    const confidence = Math.min(0.95, maxScore / Math.max(totalScore, 1) + 0.2);

    return {
      label: selectedIntent,
      confidence,
      raw_scores: scores,
    };
  }
}

/**
 * Default classifier instance
 */
export function createIntentClassifier(): IntentClassifier {
  return new HeuristicIntentClassifier();
}
