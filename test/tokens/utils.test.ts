import { describe, expect, it } from 'vitest';
import {
  resolveEligibleModels,
  selectDefaultEligibleModelIds,
  type DefaultTokenLike,
  type DefaultEligibleModelCandidate,
} from '../../src/tokens/utils';

describe('token utils', () => {
  describe('selectDefaultEligibleModelIds', () => {
    it('returns empty list when no models are available', () => {
      expect(selectDefaultEligibleModelIds([])).toEqual([]);
    });

    it('handles single provider by selecting one model', () => {
      const models: DefaultEligibleModelCandidate[] = [
        { id: 'gpt-4o', provider: 'openai', cost_tier: 'high', speed_tier: 'medium' },
        { id: 'gpt-4o-mini', provider: 'openai', cost_tier: 'low', speed_tier: 'fast' },
      ];

      const selected = selectDefaultEligibleModelIds(models);
      expect(selected).toEqual(['gpt-4o-mini']);
    });

    it('selects one lightweight model per provider', () => {
      const models: DefaultEligibleModelCandidate[] = [
        { id: 'gpt-4o', provider: 'openai', cost_tier: 'high', speed_tier: 'medium' },
        { id: 'gpt-4o-mini', provider: 'openai', cost_tier: 'low', speed_tier: 'fast' },
        { id: 'gemini-2.5-pro', provider: 'google', cost_tier: 'high', speed_tier: 'medium' },
        { id: 'gemini-2.5-flash-lite', provider: 'google', cost_tier: 'low', speed_tier: 'fast' },
        { id: 'claude-3-5-sonnet', provider: 'anthropic', cost_tier: 'medium', speed_tier: 'medium' },
        { id: 'claude-3-haiku', provider: 'anthropic', cost_tier: 'low', speed_tier: 'fast' },
      ];

      const selected = selectDefaultEligibleModelIds(models);

      expect(selected).toContain('gpt-4o-mini');
      expect(selected).toContain('gemini-2.5-flash-lite');
      expect(selected).toContain('claude-3-haiku');
      expect(selected).toHaveLength(3);
    });

    it('applies regex heuristics (mini/lite/flash positive, pro/opus negative)', () => {
      const models: DefaultEligibleModelCandidate[] = [
        { id: 'gemini-2.5-pro', provider: 'google', cost_tier: 'medium', speed_tier: 'medium' },
        { id: 'gemini-2.5-flash', provider: 'google', cost_tier: 'medium', speed_tier: 'fast' },
        { id: 'gemini-2.5-flash-lite', provider: 'google', cost_tier: 'low', speed_tier: 'fast' },
      ];

      const selected = selectDefaultEligibleModelIds(models);
      expect(selected).toEqual(['gemini-2.5-flash-lite']);
    });

    it('uses shorter id as tie-break when scores match', () => {
      const models: DefaultEligibleModelCandidate[] = [
        { id: 'x123456', provider: 'test' },
        { id: 'x1', provider: 'test' },
      ];

      const selected = selectDefaultEligibleModelIds(models);
      expect(selected).toEqual(['x1']);
    });

    it('uses lexicographic tie-break when score and length are equal', () => {
      const models: DefaultEligibleModelCandidate[] = [
        { id: 'zzz', provider: 'test' },
        { id: 'aaa', provider: 'test' },
      ];

      const selected = selectDefaultEligibleModelIds(models);
      expect(selected).toEqual(['aaa']);
    });

    it('handles missing cost_tier/speed_tier fields', () => {
      const models: DefaultEligibleModelCandidate[] = [
        { id: 'model-basic', provider: 'test' },
        { id: 'model-mini', provider: 'test' },
      ];

      const selected = selectDefaultEligibleModelIds(models);
      expect(selected).toEqual(['model-mini']);
    });
  });

  describe('resolveEligibleModels', () => {
    const available = ['model-a', 'model-b', 'model-c'];
    const compactDefault = ['model-a', 'model-c'];

    it('uses compact default set for default tokens even if token has persisted eligible_models', () => {
      const token: DefaultTokenLike = {
        is_default: true,
        eligible_models: ['stale-model-x'],
      };

      const resolved = resolveEligibleModels(token, available, compactDefault);
      expect(resolved).toEqual(compactDefault);
    });

    it('uses compact default set for legacy default token shape', () => {
      const token: DefaultTokenLike = {
        user_id: 'u1',
        name: 'Default Token',
        eligible_models: ['stale-model-y'],
      };

      const resolved = resolveEligibleModels(token, available, compactDefault);
      expect(resolved).toEqual(compactDefault);
    });

    it('uses token eligible_models for non-default tokens', () => {
      const token: DefaultTokenLike = {
        name: 'Custom',
        user_id: 'u1',
        eligible_models: ['custom-model-1'],
      };

      const resolved = resolveEligibleModels(token, available, compactDefault);
      expect(resolved).toEqual(['custom-model-1']);
    });

    it('falls back to available models for non-default token without eligible_models', () => {
      const token: DefaultTokenLike = {
        name: 'Custom',
        user_id: 'u1',
      };

      const resolved = resolveEligibleModels(token, available, compactDefault);
      expect(resolved).toEqual(available);
    });

    it('falls back to available models when default token compact list is omitted', () => {
      const token: DefaultTokenLike = {
        is_default: true,
      };

      const resolved = resolveEligibleModels(token, available);
      expect(resolved).toEqual(available);
    });
  });
});
