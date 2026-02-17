import type { ModelInfo } from '../../types';

const EPHEMERAL_VARIANT_PATTERNS: RegExp[] = [
  /(^|[-_])preview([-\d_]|$)/i,
  /(^|[-_])experimental([-\d_]|$)/i,
  /(^|[-_])exp([-\d_]|$)/i,
  /(^|[-_])tts([-\d_]|$)/i,
  /(^|[-_])image([-\d_]|$)/i,
  /(^|[-_])audio([-\d_]|$)/i,
  /(^|[-_])transcribe([-\d_]|$)/i,
  /(^|[-_])realtime([-\d_]|$)/i,
  /(^|[-_])thinking([-\d_]|$)/i,
];

const DATE_SUFFIX_PATTERNS: RegExp[] = [
  /-\d{4}-\d{2}-\d{2}$/i,
  /-\d{4}-\d{2}$/i,
  /-\d{8}$/i,
  /-\d{2}-\d{4}$/i,
];

export interface TrimmedProviderCatalog {
  models: ModelInfo[];
  dropped: number;
  canonicalized: number;
}

function shouldTrimVariants(): boolean {
  return process.env.MODEL_REGISTRY_TRIM_VARIANTS !== 'false';
}

function isEphemeralVariant(modelId: string): boolean {
  return EPHEMERAL_VARIANT_PATTERNS.some((pattern) => pattern.test(modelId));
}

function stripDateSuffix(modelId: string): string {
  let current = modelId;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of DATE_SUFFIX_PATTERNS) {
      const next = current.replace(pattern, '');
      if (next !== current) {
        current = next;
        changed = true;
      }
    }
  }
  return current;
}

function toCanonicalModelId(modelId: string): string {
  let canonical = modelId.trim();
  canonical = canonical.replace(/-latest$/i, '');
  canonical = stripDateSuffix(canonical);
  return canonical;
}

function variantScore(model: ModelInfo, originalId: string, canonicalId: string): number {
  let score = 0;

  if (originalId === canonicalId) {
    score += 100;
  }
  if (!DATE_SUFFIX_PATTERNS.some((pattern) => pattern.test(originalId))) {
    score += 10;
  }
  if (model.status === 'active') {
    score += 5;
  }
  if (model.available) {
    score += 5;
  }
  // Prefer concise canonical aliases over verbose variants.
  score += Math.max(0, 50 - originalId.length);

  return score;
}

function attachCatalogSourceId(model: ModelInfo, originalId: string): ModelInfo {
  return {
    ...model,
    provider_metadata: {
      ...model.provider_metadata,
      raw: {
        ...(model.provider_metadata?.raw ?? {}),
        catalog_model_id: originalId,
      },
    },
  };
}

export function trimProviderCatalog(
  _providerName: string,
  models: ModelInfo[]
): TrimmedProviderCatalog {
  if (!shouldTrimVariants()) {
    return {
      models,
      dropped: 0,
      canonicalized: 0,
    };
  }

  type Candidate = {
    model: ModelInfo;
    originalId: string;
    canonicalId: string;
    score: number;
  };

  const chosenByCanonicalId = new Map<string, Candidate>();

  for (const model of models) {
    const originalId = model.id.trim();
    if (!originalId || isEphemeralVariant(originalId)) {
      continue;
    }

    const canonicalId = toCanonicalModelId(originalId);
    if (!canonicalId || isEphemeralVariant(canonicalId)) {
      continue;
    }

    const normalizedModel = canonicalId === originalId
      ? model
      : attachCatalogSourceId({ ...model, id: canonicalId }, originalId);

    const candidate: Candidate = {
      model: normalizedModel,
      originalId,
      canonicalId,
      score: variantScore(model, originalId, canonicalId),
    };

    const existing = chosenByCanonicalId.get(canonicalId);
    if (!existing || candidate.score > existing.score) {
      chosenByCanonicalId.set(canonicalId, candidate);
    }
  }

  const trimmed = Array.from(chosenByCanonicalId.values()).map((entry) => entry.model);
  const canonicalized = Array.from(chosenByCanonicalId.values()).reduce((count, entry) => (
    entry.originalId !== entry.canonicalId ? count + 1 : count
  ), 0);

  return {
    models: trimmed,
    dropped: Math.max(0, models.length - trimmed.length),
    canonicalized,
  };
}
