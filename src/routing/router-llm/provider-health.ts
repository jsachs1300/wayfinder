import type { RouterLLMProvider } from '../config';

export type ProviderHealthState = 'healthy' | 'degraded' | 'unhealthy';
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';
export type PreflightStatus = 'unknown' | 'pass' | 'fail';

export interface RouterProviderHealthSnapshot {
  provider: RouterLLMProvider;
  model: string;
  health_state: ProviderHealthState;
  circuit_breaker_state: CircuitBreakerState;
  preflight_status: PreflightStatus;
  consecutive_failures: number;
  last_success_at?: string;
  last_failure_at?: string;
  last_error?: string;
  updated_at: string;
}

export interface RouterProviderHealthStore {
  get(provider: RouterLLMProvider, model: string): RouterProviderHealthSnapshot | undefined;
  set(snapshot: RouterProviderHealthSnapshot): void;
  list(): RouterProviderHealthSnapshot[];
}

function key(provider: RouterLLMProvider, model: string): string {
  return `${provider}:${model}`;
}

export class InMemoryRouterProviderHealthStore implements RouterProviderHealthStore {
  private readonly snapshots = new Map<string, RouterProviderHealthSnapshot>();

  get(provider: RouterLLMProvider, model: string): RouterProviderHealthSnapshot | undefined {
    return this.snapshots.get(key(provider, model));
  }

  set(snapshot: RouterProviderHealthSnapshot): void {
    this.snapshots.set(key(snapshot.provider, snapshot.model), snapshot);
  }

  list(): RouterProviderHealthSnapshot[] {
    return Array.from(this.snapshots.values()).sort((a, b) => {
      if (a.provider === b.provider) {
        return a.model.localeCompare(b.model);
      }
      return a.provider.localeCompare(b.provider);
    });
  }
}

