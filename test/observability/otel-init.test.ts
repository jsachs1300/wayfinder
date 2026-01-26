import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startSpy = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start() {
      startSpy();
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

vi.mock('@google-cloud/opentelemetry-cloud-monitoring-exporter', () => ({
  MetricExporter: class {},
}));

vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter', () => ({
  TraceExporter: class {},
}));

describe('Observability bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    startSpy.mockClear();
    process.env.OBSERVABILITY_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('initializes the OpenTelemetry SDK when enabled', async () => {
    await import('../../src/observability/index');
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
