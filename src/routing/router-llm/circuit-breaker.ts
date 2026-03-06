import type { RouterLLMProvider } from '../config';
import type { CircuitBreakerState } from './provider-health';

interface CircuitBreakerEntry {
  failureTimestampsMs: number[];
  openUntilMs?: number;
  halfOpenProbeInFlight: boolean;
}

export interface CircuitBreakerConfig {
  errorThreshold: number;
  windowMs: number;
  openMs: number;
}

export interface CircuitBreakerDecision {
  allowed: boolean;
  state: CircuitBreakerState;
}

export class ProviderCircuitBreaker {
  private readonly entries = new Map<string, CircuitBreakerEntry>();

  constructor(private readonly config: CircuitBreakerConfig) {}

  shouldAllowRequest(provider: RouterLLMProvider, model: string, nowMs = Date.now()): CircuitBreakerDecision {
    const entry = this.getOrCreateEntry(provider, model);
    this.pruneFailures(entry, nowMs);

    if (entry.openUntilMs && nowMs < entry.openUntilMs) {
      return { allowed: false, state: 'open' };
    }

    if (entry.openUntilMs && nowMs >= entry.openUntilMs) {
      if (entry.halfOpenProbeInFlight) {
        return { allowed: false, state: 'half_open' };
      }
      entry.halfOpenProbeInFlight = true;
      return { allowed: true, state: 'half_open' };
    }

    return { allowed: true, state: 'closed' };
  }

  recordSuccess(provider: RouterLLMProvider, model: string, nowMs = Date.now()): void {
    const entry = this.getOrCreateEntry(provider, model);
    this.pruneFailures(entry, nowMs);
    entry.failureTimestampsMs = [];
    entry.openUntilMs = undefined;
    entry.halfOpenProbeInFlight = false;
  }

  recordFailure(provider: RouterLLMProvider, model: string, nowMs = Date.now()): void {
    const entry = this.getOrCreateEntry(provider, model);
    this.pruneFailures(entry, nowMs);

    if (entry.halfOpenProbeInFlight) {
      entry.halfOpenProbeInFlight = false;
      // A failed half-open probe starts a fresh open interval from now,
      // so we reset failure history to this probe failure timestamp.
      entry.failureTimestampsMs = [nowMs];
      entry.openUntilMs = nowMs + this.config.openMs;
      return;
    }

    entry.failureTimestampsMs.push(nowMs);
    if (entry.failureTimestampsMs.length >= this.config.errorThreshold) {
      entry.openUntilMs = nowMs + this.config.openMs;
    }
  }

  getState(provider: RouterLLMProvider, model: string, nowMs = Date.now()): CircuitBreakerState {
    const entry = this.entries.get(this.toKey(provider, model));
    if (!entry) {
      return 'closed';
    }
    this.pruneFailures(entry, nowMs);

    if (entry.openUntilMs && nowMs < entry.openUntilMs) {
      return 'open';
    }
    if (entry.openUntilMs && nowMs >= entry.openUntilMs) {
      return 'half_open';
    }
    return 'closed';
  }

  private getOrCreateEntry(provider: RouterLLMProvider, model: string): CircuitBreakerEntry {
    const key = this.toKey(provider, model);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        failureTimestampsMs: [],
        halfOpenProbeInFlight: false,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private pruneFailures(entry: CircuitBreakerEntry, nowMs: number): void {
    const cutoff = nowMs - this.config.windowMs;
    entry.failureTimestampsMs = entry.failureTimestampsMs.filter((timestamp) => timestamp >= cutoff);
  }

  private toKey(provider: RouterLLMProvider, model: string): string {
    return `${provider}:${model}`;
  }
}
