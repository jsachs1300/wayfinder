import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { MetricExporter } from '@google-cloud/opentelemetry-cloud-monitoring-exporter';
import { TraceExporter } from '@google-cloud/opentelemetry-cloud-trace-exporter';

const enabled =
  process.env.OBSERVABILITY_ENABLED !== 'false' &&
  process.env.NODE_ENV !== 'test';

if (enabled) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new MetricExporter(),
    exportIntervalMillis: 60000,
  });

  const sdk = new NodeSDK({
    traceExporter: new TraceExporter(),
    metricReader,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  try {
    sdk.start();
  } catch (error) {
    console.error('Failed to start OpenTelemetry', error);
  }

  process.on('SIGTERM', () => {
    sdk.shutdown().catch((error) => {
      console.error('Failed to shutdown OpenTelemetry', error);
    });
  });
}
