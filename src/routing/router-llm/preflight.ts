import type { RouterLLMConfig, RouterLLMProvider } from '../config';
import { createProviderClient } from './providers';
import type { ProviderClient } from './providers/types';
import type { RouterProviderHealthStore, ProviderHealthState, CircuitBreakerState } from './provider-health';
import type { Logger } from '../../logging/logger';

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
    private readonly clientFactory: ProviderClientFactory = createProviderClient
  ) {}

  async run(): Promise<RouterPreflightSummary> {
    const probes = this.getEnabledProviderConfigs();
    const results: RouterPreflightProviderResult[] = [];

    for (const probe of probes) {
      const startedAt = Date.now();
      try {
        const client = this.clientFactory(probe.provider, probe.apiKey);
        await this.invokeProbe(client, probe.provider, probe.model);

        const latencyMs = Date.now() - startedAt;
        const result: RouterPreflightProviderResult = {
          provider: probe.provider,
          model: probe.model,
          status: 'pass',
          latencyMs,
        };
        this.updateHealth(result);
        results.push(result);
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const result: RouterPreflightProviderResult = {
          provider: probe.provider,
          model: probe.model,
          status: 'fail',
          latencyMs,
          error: error instanceof Error ? error.message : String(error),
        };
        this.updateHealth(result);
        results.push(result);
      }
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
  }

  private getEnabledProviderConfigs(): Array<{
    provider: RouterLLMProvider;
    model: string;
    apiKey: string;
  }> {
    const providers: Array<{ provider: RouterLLMProvider; model: string; apiKey: string }> = [];

    if (this.config.openai.enabled && this.config.openai.apiKey) {
      providers.push({
        provider: 'openai',
        model: this.config.openai.model,
        apiKey: this.config.openai.apiKey,
      });
    }
    if (this.config.gemini.enabled && this.config.gemini.apiKey) {
      providers.push({
        provider: 'gemini',
        model: this.config.gemini.model,
        apiKey: this.config.gemini.apiKey,
      });
    }

    return providers;
  }

  private healthStateForResult(result: RouterPreflightProviderResult): ProviderHealthState {
    return result.status === 'pass' ? 'healthy' : 'unhealthy';
  }

  private updateHealth(result: RouterPreflightProviderResult): void {
    const existing = this.healthStore.get(result.provider, result.model);
    const now = new Date().toISOString();
    const circuitBreakerState: CircuitBreakerState = existing?.circuitBreakerState ?? 'closed';

    this.healthStore.set({
      provider: result.provider,
      model: result.model,
      healthState: this.healthStateForResult(result),
      circuitBreakerState,
      preflightStatus: result.status,
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      lastSuccessAt: result.status === 'pass' ? now : existing?.lastSuccessAt,
      lastFailureAt: result.status === 'fail' ? now : existing?.lastFailureAt,
      lastError: result.status === 'fail' ? result.error : existing?.lastError,
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
  }
}
