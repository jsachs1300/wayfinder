import type { ModelCostMetadata, ModelInfo, ModelPerformanceMetadata, MetadataConfidenceLevel } from '../../types';

const LOW_COST_PATTERN = /(mini|nano|flash|haiku|small|lite)/i;
const HIGH_COST_PATTERN = /(pro|opus|ultra|reasoning|o1|o3|o4)/i;

const FAST_PATTERN = /(mini|nano|flash|haiku|small|lite)/i;
const SLOW_PATTERN = /(pro|opus|ultra|reasoning|o1|o3|o4)/i;

function inferCostTier(modelId: string): ModelInfo['cost_tier'] {
  if (LOW_COST_PATTERN.test(modelId)) {
    return 'low';
  }
  if (HIGH_COST_PATTERN.test(modelId)) {
    return 'high';
  }
  return 'medium';
}

function inferSpeedTier(modelId: string): ModelInfo['speed_tier'] {
  if (FAST_PATTERN.test(modelId)) {
    return 'fast';
  }
  if (SLOW_PATTERN.test(modelId)) {
    return 'slow';
  }
  return 'medium';
}

function inferQualityTier(modelId: string): NonNullable<ModelPerformanceMetadata['quality_tier']> {
  if (HIGH_COST_PATTERN.test(modelId)) {
    return 'high';
  }
  if (LOW_COST_PATTERN.test(modelId)) {
    return 'low';
  }
  return 'medium';
}

function inferLatencyTier(modelId: string): NonNullable<ModelPerformanceMetadata['latency_tier']> {
  const speed = inferSpeedTier(modelId);
  if (speed === 'fast') {
    return 'fast';
  }
  if (speed === 'slow') {
    return 'slow';
  }
  return 'medium';
}

export function buildInferredCostMetadata(): ModelCostMetadata {
  return {
    source: 'inferred',
  };
}

export function buildInferredPerformanceMetadata(modelId: string): ModelPerformanceMetadata {
  return {
    quality_tier: inferQualityTier(modelId),
    latency_tier: inferLatencyTier(modelId),
  };
}

export function inferCoreModelTiers(modelId: string): Pick<ModelInfo, 'cost_tier' | 'speed_tier'> {
  return {
    cost_tier: inferCostTier(modelId),
    speed_tier: inferSpeedTier(modelId),
  };
}

export function inferredConfidenceLevel(): MetadataConfidenceLevel {
  return 'low';
}

