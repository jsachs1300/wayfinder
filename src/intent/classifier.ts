import { IntentLabel, IntentClassification } from '../types';

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
  code_review: [
    /review\s+(this\s+)?(code|pr|pull\s+request|commit|diff)/i,
    /check\s+(this\s+)?(code|implementation)/i,
    /what('s|\s+is)\s+wrong\s+with\s+(this\s+)?code/i,
    /find\s+(bugs?|issues?|problems?)\s+in/i,
    /code\s+quality/i,
    /refactor\s+suggestions?/i,
  ],
  coding: [
    /write\s+(a\s+)?(function|class|method|code|script|program)/i,
    /implement\s+(a\s+)?/i,
    /create\s+(a\s+)?(function|class|component|api|endpoint)/i,
    /fix\s+(this\s+)?(bug|error|issue)/i,
    /debug\s+(this|the)/i,
    /how\s+(do\s+i|to)\s+(code|implement|write)/i,
    /convert\s+(this\s+)?code/i,
    /add\s+(a\s+)?feature/i,
    /\b(function|class|const|let|var|def|import|export)\b/,
  ],
  legal: [
    /\b(legal|law|lawyer|attorney|court|lawsuit|contract|liability)\b/i,
    /\b(compliance|regulation|regulatory|gdpr|hipaa|sox)\b/i,
    /\b(terms\s+of\s+service|privacy\s+policy|license|copyright)\b/i,
    /\b(sue|lawsuit|litigation|defendant|plaintiff)\b/i,
    /is\s+(this|it)\s+legal/i,
    /legal\s+(advice|opinion|question)/i,
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
  reasoning: [
    /explain\s+(why|how)/i,
    /what\s+(is|are)\s+the\s+reason/i,
    /analyze\s+(this|the)/i,
    /compare\s+(and\s+contrast)?/i,
    /pros\s+and\s+cons/i,
    /advantages?\s+(and|or)\s+disadvantages?/i,
    /logic(al)?\s+(behind|of)/i,
    /step\s+by\s+step/i,
    /think\s+(through|about)/i,
    /evaluate\s+(this|the)/i,
    /critical(ly)?\s+(think|analyze)/i,
  ],
  creative: [
    /write\s+(a\s+)?(story|poem|song|essay|article|blog)/i,
    /creative\s+(writing|content)/i,
    /brainstorm/i,
    /come\s+up\s+with\s+(ideas?|names?)/i,
    /imagine\s+(a|that)/i,
    /create\s+(a\s+)?(story|narrative|character)/i,
    /fiction(al)?/i,
    /make\s+(it\s+)?(funny|humorous|engaging)/i,
    /rewrite\s+(this\s+)?in\s+a\s+(more\s+)?(creative|engaging)/i,
  ],
  support: [
    /help\s+(me\s+)?(with|understand)/i,
    /how\s+do\s+i/i,
    /what\s+(is|are|does)/i,
    /can\s+you\s+(explain|help|tell)/i,
    /having\s+(trouble|issues?|problems?)/i,
    /not\s+working/i,
    /error\s+message/i,
    /stuck\s+(on|with)/i,
    /troubleshoot/i,
  ],
  other: [], // Fallback, no specific patterns
};

/**
 * Weight multipliers for each intent (some are more specific than others)
 */
const INTENT_WEIGHTS: Record<IntentLabel, number> = {
  code_review: 1.2,
  coding: 1.0,
  legal: 1.5,  // Legal is highly specific
  summarization: 1.3,
  reasoning: 1.1,
  creative: 1.2,
  support: 0.8,  // Support is more generic
  other: 0.5,
};

/**
 * Heuristic-based intent classifier using keyword patterns
 */
export class HeuristicIntentClassifier implements IntentClassifier {
  classify(prompt: string): IntentClassification {
    const normalizedPrompt = prompt.toLowerCase().trim();
    const scores: Record<IntentLabel, number> = {
      code_review: 0,
      coding: 0,
      legal: 0,
      summarization: 0,
      reasoning: 0,
      creative: 0,
      support: 0,
      other: 0,
    };

    // Calculate raw scores based on pattern matches
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      const intentLabel = intent as IntentLabel;
      for (const pattern of patterns) {
        if (pattern.test(normalizedPrompt)) {
          scores[intentLabel] += INTENT_WEIGHTS[intentLabel];
        }
      }
    }

    // Find the intent with the highest score
    let maxScore = 0;
    let selectedIntent: IntentLabel = 'other';
    let totalScore = 0;

    for (const [intent, score] of Object.entries(scores)) {
      totalScore += score;
      if (score > maxScore) {
        maxScore = score;
        selectedIntent = intent as IntentLabel;
      }
    }

    // If no patterns matched, default to 'other' with low confidence
    if (maxScore === 0) {
      return {
        label: 'other',
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
