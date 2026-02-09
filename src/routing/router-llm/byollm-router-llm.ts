/**
 * BYOLLM Router LLM Wrapper
 *
 * Wraps the multi-provider router LLM to support user-provided API keys (BYOLLM).
 * If user has configured their own LLM keys, uses those keys for routing decisions.
 * Otherwise, falls back to system keys.
 */

import { MultiProviderRouterLLM, type MultiProviderResult } from './multi-provider-router-llm';
import type { RouterLLM } from '../engine';
import type { TokenConfig } from '../../types/index';
import type { DecryptedLLMKey } from '../../users/llm-keys/types';
import type { RouterLLMConfig } from '../config';
import { loadRouterLLMConfig } from '../config';

/**
 * BYOLLM-aware Router LLM wrapper
 *
 * Determines whether to use user-provided LLM keys or system keys for routing.
 */
export class BYOLLMRouterLLM implements RouterLLM {
  private readonly systemConfig: RouterLLMConfig;
  private readonly systemRouter: MultiProviderRouterLLM;
  private readonly logger?: Console;

  /**
   * Creates a new BYOLLM Router LLM instance
   *
   * @param systemConfig - System router LLM configuration (fallback)
   * @param logger - Optional logger (defaults to console)
   */
  constructor(systemConfig?: RouterLLMConfig, logger?: Console) {
    this.systemConfig = systemConfig ?? loadRouterLLMConfig();
    this.systemRouter = new MultiProviderRouterLLM(this.systemConfig, logger);
    this.logger = logger;
  }

  /**
   * Invokes router LLM with user keys if available, otherwise system keys
   *
   * @param prompt - User's prompt
   * @param eligibleModels - Models eligible for selection
   * @param context - Request context
   * @returns Router LLM response
   */
  async invoke(
    prompt: string,
    eligibleModels: string[],
    context: {
      tokenConfig: TokenConfig;
      preferModel?: string;
      requestMetadata?: Record<string, unknown>;
      userLLMKeys?: DecryptedLLMKey[]; // Injected by routing handler
      eligibleModelRegistry?: Record<string, Record<string, unknown>>;
    }
  ): Promise<unknown> {
    // Check if user has BYOLLM keys configured
    if (context.userLLMKeys && context.userLLMKeys.length > 0) {
      this.logger?.log('[BYOLLMRouterLLM] Using user-provided LLM keys', {
        providers: context.userLLMKeys.map((k) => k.provider),
      });

      // Create temporary router with user's keys
      const userRouter = this.createUserRouter(context.userLLMKeys);

      try {
        return await userRouter.invoke(prompt, eligibleModels, context);
      } catch (error) {
        // If user keys fail, re-throw the error
        // DO NOT fall back to system keys - user is paying for their own LLM usage
        this.logger?.error('[BYOLLMRouterLLM] User LLM keys failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    // No user keys configured - use system router
    this.logger?.log('[BYOLLMRouterLLM] Using system LLM keys (no user keys configured)');
    return this.systemRouter.invoke(prompt, eligibleModels, context);
  }

  /**
   * Creates a router LLM instance using user's API keys
   *
   * @param keys - User's decrypted LLM API keys
   * @returns MultiProviderRouterLLM configured with user keys
   */
  private createUserRouter(keys: DecryptedLLMKey[]): MultiProviderRouterLLM {
    const userConfig = this.buildUserConfig(keys);
    return new MultiProviderRouterLLM(userConfig, this.logger);
  }

  /**
   * Builds router LLM config using user's API keys
   *
   * @param keys - User's decrypted LLM API keys
   * @returns RouterLLMConfig with user keys
   */
  private buildUserConfig(keys: DecryptedLLMKey[]): RouterLLMConfig {
    const openaiKey = keys.find((k) => k.provider === 'openai');
    const geminiKey = keys.find((k) => k.provider === 'gemini');

    return {
      openai: {
        enabled: !!openaiKey,
        apiKey: openaiKey?.api_key,
        model: process.env.ROUTER_LLM_OPENAI_MODEL || 'gpt-4o-mini',
      },
      gemini: {
        enabled: !!geminiKey,
        apiKey: geminiKey?.api_key,
        model: process.env.ROUTER_LLM_GEMINI_MODEL || 'gemini-1.5-flash',
      },
      timeout: parseInt(process.env.ROUTER_LLM_TIMEOUT || '30000', 10),
      maxRetries: parseInt(process.env.ROUTER_LLM_MAX_RETRIES || '2', 10),
      temperature: parseFloat(process.env.ROUTER_LLM_TEMPERATURE || '0.0'),
      maxTokens: parseInt(process.env.ROUTER_LLM_MAX_TOKENS || '2000', 10),
    };
  }

  /**
   * Returns the system configuration
   */
  getConfig(): RouterLLMConfig {
    return { ...this.systemConfig };
  }
}
