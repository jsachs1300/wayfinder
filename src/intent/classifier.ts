export interface IntentClassifier {
  classify(prompt: string): Promise<never>;
}

export class HeuristicIntentClassifier implements IntentClassifier {
  async classify(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    prompt: string
  ): Promise<never> {
    throw new Error('Intent classifier removed pending LLM router implementation');
  }
}

export function createIntentClassifier(): IntentClassifier {
  return new HeuristicIntentClassifier();
}
