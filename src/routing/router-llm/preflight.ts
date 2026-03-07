import type { RouterLLMConfig, RouterLLMProvider } from '../config';
import { createProviderClient } from './providers';
import type { ProviderClient } from './providers/types';
import type { RouterProviderHealthStore, ProviderHealthState, CircuitBreakerState } from './provider-health';
import type { Logger } from '../../logging/logger';
import { recordRouterPreflightOutcome } from '../../observability/metrics';

export interface RouterPreflightProviderResult {
  provider: RouterLLMProvider;
  model: string;
  status: 'pass' | 'fail';
  latencyMs: number;
  error?: string;
}

export interface RouterPreflightSummary {
  results: RouterPreflightProviderResult[];
  passCount: number;
  failCount: number;
}

export type RouterPreflightTrigger = 'startup' | 'admin';

export class RouterStartupPreflightError extends Error {
  constructor(message: string, public readonly summary: RouterPreflightSummary) {
    super(message);
    this.name = 'RouterStartupPreflightError';
  }
}

type ProviderClientFactory = (provider: RouterLLMProvider, apiKey: string) => ProviderClient;

export class RouterStartupPreflight {
  constructor(
    private readonly config: RouterLLMConfig,
    private readonly healthStore: RouterProviderHealthStore,
    private readonly logger?: Pick<Logger, 'info' | 'warn'>,
    private readonly clientFactory: ProviderClientFactory = createProviderClient,
    private readonly trigger: RouterPreflightTrigger = 'startup'
  ) {}

  async run(): Promise<RouterPreflightSummary> {
    const probes = this.getConfiguredProviderProbes();
    const results = await Promise.all(
      probes.map(async (probe): Promise<RouterPreflightProviderResult> => {
        const startedAt = Date.now();
        if (!probe.apiKey) {
          return {
            provider: probe.provider,
            model: probe.model,
            status: 'fail',
            latencyMs: Date.now() - startedAt,
            error: `${probe.provider} is enabled but API key is missing`,
          };
        }

        try {
          const client = this.clientFactory(probe.provider, probe.apiKey);
          await this.invokeProbe(client, probe.provider, probe.model);
          return {
            provider: probe.provider,
            model: probe.model,
            status: 'pass',
            latencyMs: Date.now() - startedAt,
          };
        } catch (error) {
          return {
            provider: probe.provider,
            model: probe.model,
            status: 'fail',
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    for (const result of results) {
      this.updateHealth(result);
    }

    const passCount = results.filter((result) => result.status === 'pass').length;
    const failCount = results.length - passCount;
    return { results, passCount, failCount };
  }

  private async invokeProbe(
    client: ProviderClient,
    provider: RouterLLMProvider,
    model: string
  ): Promise<void> {
    const probePayload = {
      intent: 'startup_preflight',
      ranked_models: [
        {
          rank: 1,
          model,
          score: 10,
          reason: 'startup preflight probe',
        },
      ],
    };

    const response = await client.invoke({
      prompt:
        'Return only valid JSON matching this exact structure (no markdown):\n' +
        `${JSON.stringify(probePayload)}`,
      model,
      temperature: 0,
      maxTokens: 256,
      timeout: this.config.reliability.preflightTimeoutMs,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch (error) {
      throw new Error(
        `${provider} preflight returned non-JSON response: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('ranked_models' in parsed) ||
      !Array.isArray((parsed as { ranked_models: unknown[] }).ranked_models) ||
      (parsed as { ranked_models: unknown[] }).ranked_models.length === 0
    ) {
      throw new Error(`${provider} preflight returned invalid routing payload`);
    }

    const firstRankedModel = (parsed as { ranked_models: unknown[] }).ranked_models[0];
    if (
      typeof firstRankedModel !== 'object' ||
      firstRankedModel === null ||
      typeof (firstRankedModel as { model?: unknown }).model !== 'string' ||
      (firstRankedModel as { model: string }).model.trim().length === 0
    ) {
      throw new Error(`${provider} preflight returned ranked_models without a valid model id`);
    }
  }

  private getConfiguredProviderProbes(): Array<{
    provider: RouterLLMProvider;
    model: string;
    apiKey?: string;
  }> {
    const providers: Array<{ provider: RouterLLMProvider; model: string; apiKey?: string }> = [];

    if (this.config.openai.enabled) {
      providers.push({
        provider: 'openai',
        model: this.config.openai.model,
        apiKey: this.config.openai.apiKey,
      });
    }
    if (this.config.gemini.enabled) {
      providers.push({
        provider: 'gemini',
        model: this.config.gemini.model,
        apiKey: this.config.gemini.apiKey,
      });
    }

    return providers;
  }

  private updateHealth(result: RouterPreflightProviderResult): void {
    const existing = this.healthStore.get(result.provider, result.model);
    const now = new Date().toISOString();
    const circuitBreakerState: CircuitBreakerState = existing?.circuitBreakerState ?? 'closed';
    const existingFailures = existing?.consecutiveFailures ?? 0;

    this.healthStore.set({
      provider: result.provider,
      model: result.model,
      healthState: (result.status === 'pass' ? 'healthy' : 'unhealthy') as ProviderHealthState,
      circuitBreakerState,
      preflightStatus: result.status,
      consecutiveFailures: result.status === 'fail' ? existingFailures + 1 : 0,
      lastSuccessAt: result.status === 'pass' ? now : existing?.lastSuccessAt,
      lastFailureAt: result.status === 'fail' ? now : existing?.lastFailureAt,
      lastError: result.status === 'fail' ? result.error : undefined,
      updatedAt: now,
    });

    if (result.status === 'pass') {
      this.logger?.info('Router provider preflight passed', {
        provider: result.provider,
        model: result.model,
        latency_ms: result.latencyMs,
      });
    } else {
      this.logger?.warn('Router provider preflight failed', {
        provider: result.provider,
        model: result.model,
        latency_ms: result.latencyMs,
        error: result.error,
      });
    }

    recordRouterPreflightOutcome(
      result.provider,
      result.model,
      result.status,
      result.latencyMs,
      this.trigger
    );
  }
}
