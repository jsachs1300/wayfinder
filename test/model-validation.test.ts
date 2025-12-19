import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createModelRegistry, DefaultModelRegistry } from '../src/models/registry';
import { InMemoryKnowledgeStore } from '../src/knowledge/store';
import { StubOpinionPoller } from '../src/polling/stub';
import { InMemoryTokenStore } from '../src/tokens/store';
import { ModelInfo, TokenCreateRequest } from '../src/types';
import {
  InvalidModelError,
  DisabledModelError,
  ModelValidationError,
} from '../src/models/errors';

/**
 * Model Validation Proof Tests
 *
 * These tests prove that the model validation system:
 * 1. Rejects invalid models at ingestion points
 * 2. Enforces lifecycle rules (disabled, deprecated)
 * 3. Protects knowledge store integrity
 * 4. Logs warnings appropriately
 */

describe('Model Validation - Proof Tests', () => {
  let modelRegistry: DefaultModelRegistry;
  let knowledgeStore: InMemoryKnowledgeStore;
  let tokenStore: InMemoryTokenStore;
  let opinionPoller: StubOpinionPoller;

  beforeEach(() => {
    // Create registry with test models including a disabled and deprecated one
    const testModels: ModelInfo[] = [
      {
        id: 'active-model',
        provider: 'test',
        capabilities: ['coding'],
        cost_tier: 'low',
        speed_tier: 'fast',
        context_window: 8000,
        available: true,
        status: 'active',
        global_eligible: true,
        description: 'Active test model',
      },
      {
        id: 'disabled-model',
        provider: 'test',
        capabilities: ['coding'],
        cost_tier: 'low',
        speed_tier: 'fast',
        context_window: 8000,
        available: false,
        status: 'disabled',
        global_eligible: true,
        description: 'Disabled test model',
      },
      {
        id: 'deprecated-model',
        provider: 'test',
        capabilities: ['coding'],
        cost_tier: 'low',
        speed_tier: 'fast',
        context_window: 8000,
        available: true,
        status: 'deprecated',
        global_eligible: true,
        description: 'Deprecated test model',
      },
    ];

    modelRegistry = createModelRegistry(testModels);
    knowledgeStore = new InMemoryKnowledgeStore(modelRegistry);
    tokenStore = new InMemoryTokenStore();
    opinionPoller = new StubOpinionPoller(knowledgeStore, modelRegistry);
  });

  // ========== PROOF TEST 1: Invalid model rejected in token creation ==========
  it('PROOF 1: Invalid model rejected in token creation', async () => {
    const invalidRequest: TokenCreateRequest = {
      trusted_anchor_model: 'nonexistent-model',
      knowledge_scope: 'global',
    };

    expect(() => {
      modelRegistry.validateTokenConfig(invalidRequest);
    }).toThrow(InvalidModelError);

    // Verify the error message is clear
    try {
      modelRegistry.validateTokenConfig(invalidRequest);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidModelError);
      expect((error as Error).message).toContain('nonexistent-model');
      expect((error as Error).message).toContain('does not exist');
    }
  });

  // ========== PROOF TEST 2: Disabled model rejected everywhere ==========
  it('PROOF 2: Disabled model rejected everywhere', () => {
    const disabledModel = 'disabled-model';

    // Rejected in token config
    expect(() => {
      modelRegistry.validateTokenConfig({
        trusted_anchor_model: disabledModel,
      });
    }).toThrow(DisabledModelError);

    // Rejected in knowledge store
    expect(async () => {
      await knowledgeStore.recordVote('coding', disabledModel, {
        scope: 'global',
      });
    }).rejects.toThrow(DisabledModelError);

    // Rejected in opinion polling
    expect(async () => {
      await opinionPoller.startPoll(
        {
          prompt: 'test',
          intent: 'coding',
          models: ['active-model', disabledModel],
        },
        { scope: 'global' }
      );
    }).rejects.toThrow(DisabledModelError);

    // Verify error messages include context
    try {
      modelRegistry.assertModelActive(disabledModel, 'token_config');
    } catch (error) {
      expect(error).toBeInstanceOf(DisabledModelError);
      expect((error as Error).message).toContain('disabled');
      expect((error as Error).message).toContain('cannot be used');
    }
  });

  // ========== PROOF TEST 3: Feedback with invalid model does not alter votes ==========
  it('PROOF 3: Feedback with invalid model does not alter votes', async () => {
    // Record a valid vote first
    await knowledgeStore.recordVote('coding', 'active-model', {
      scope: 'global',
    });

    const initialEntry = await knowledgeStore.get('coding', { scope: 'global' });
    expect(initialEntry).toBeTruthy();
    expect(initialEntry!.total_votes).toBe(1);
    expect(initialEntry!.model_votes['active-model']).toBe(1);

    // Attempt to record vote with invalid model should throw
    await expect(async () => {
      await knowledgeStore.recordVote('coding', 'invalid-model-xyz', {
        scope: 'global',
      });
    }).rejects.toThrow(InvalidModelError);

    // Verify knowledge was NOT altered
    const finalEntry = await knowledgeStore.get('coding', { scope: 'global' });
    expect(finalEntry).toBeTruthy();
    expect(finalEntry!.total_votes).toBe(1); // Still 1, not 2
    expect(finalEntry!.model_votes['active-model']).toBe(1);
    expect(finalEntry!.model_votes['invalid-model-xyz']).toBeUndefined();

    // Attempt with disabled model should also not alter votes
    await expect(async () => {
      await knowledgeStore.recordVote('coding', 'disabled-model', {
        scope: 'global',
      });
    }).rejects.toThrow(DisabledModelError);

    const finalEntry2 = await knowledgeStore.get('coding', { scope: 'global' });
    expect(finalEntry2!.total_votes).toBe(1); // Still unchanged
  });

  // ========== PROOF TEST 4: Polling cannot emit unknown model IDs ==========
  it('PROOF 4: Polling cannot emit unknown model IDs', async () => {
    // Attempt to poll with invalid models
    await expect(async () => {
      await opinionPoller.startPoll(
        {
          prompt: 'test prompt',
          intent: 'coding',
          models: ['active-model', 'completely-fake-model'],
        },
        { scope: 'global' }
      );
    }).rejects.toThrow(InvalidModelError);

    // Verify no poll was created (would have thrown before creating)
    // This ensures no invalid model IDs enter the system

    // Valid poll should work
    const validPollId = await opinionPoller.startPoll(
      {
        prompt: 'test prompt',
        intent: 'coding',
        models: ['active-model'],
      },
      { scope: 'global' }
    );

    expect(validPollId).toBeDefined();
    const pollResult = await opinionPoller.getPollResult(validPollId);
    expect(pollResult).toBeTruthy();
    expect(pollResult!.votes).toHaveProperty('active-model');
    expect(pollResult!.votes).not.toHaveProperty('completely-fake-model');
  });

  // ========== PROOF TEST 5: Deprecated model routes but logs warning ==========
  it('PROOF 5: Deprecated model routes but logs warning', async () => {
    const deprecatedModel = 'deprecated-model';

    // Deprecated model should NOT throw, but should validate successfully
    expect(() => {
      modelRegistry.assertModelExists(deprecatedModel, 'token_config');
    }).not.toThrow();

    // assertModelActive should log warning but not throw
    const consoleWarnSpy = vi.spyOn(console, 'warn');

    expect(() => {
      modelRegistry.assertModelActive(deprecatedModel, 'token_config');
    }).not.toThrow();

    // Verify warning was logged
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnCalls = consoleWarnSpy.mock.calls;
    const deprecatedWarning = warnCalls.find((call) =>
      JSON.stringify(call).includes('deprecated')
    );
    expect(deprecatedWarning).toBeDefined();

    consoleWarnSpy.mockRestore();

    // Token config with deprecated model should validate
    expect(() => {
      modelRegistry.validateTokenConfig({
        trusted_anchor_model: deprecatedModel,
        knowledge_scope: 'global',
      });
    }).not.toThrow();

    // Knowledge store should accept deprecated model
    await expect(
      knowledgeStore.recordVote('coding', deprecatedModel, { scope: 'global' })
    ).resolves.toBeTruthy();

    const entry = await knowledgeStore.get('coding', { scope: 'global' });
    expect(entry!.model_votes[deprecatedModel]).toBe(1);
  });

  // ========== BONUS: Configuration contradiction detection ==========
  it('BONUS: Token config contradictions are detected', () => {
    // Model in both allowed and denied
    expect(() => {
      modelRegistry.validateTokenConfig({
        allowed_models: ['active-model'],
        denied_models: ['active-model'],
      });
    }).toThrow(ModelValidationError);

    // Anchor model in denied list
    expect(() => {
      modelRegistry.validateTokenConfig({
        trusted_anchor_model: 'active-model',
        denied_models: ['active-model'],
      });
    }).toThrow(ModelValidationError);

    // Default model not in allowed list
    expect(() => {
      modelRegistry.validateTokenConfig({
        allowed_models: ['deprecated-model'],
        default_model: 'active-model',
      });
    }).toThrow(ModelValidationError);
  });
});
