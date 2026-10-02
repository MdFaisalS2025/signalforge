import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { logs } from '@opentelemetry/api-logs';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { initMetrics, shutdownMetrics } from './metrics.js';

const BATCH_SCHEDULED_DELAY_MILLIS = 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Telemetry cannot start without it — set it before starting this service.`,
    );
  }
  return value;
}

const serviceName = requireEnv('OTEL_SERVICE_NAME');
const tracesEndpoint = requireEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
const metricsEndpoint = requireEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
const logsEndpoint = requireEnv('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');

// One resource, attached identically to the trace, metric, and log providers
// below, so every signal from this process reports the same service.name.
const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [
    // sdk-trace-node re-exports BatchSpanProcessor from the sdk-trace-base
    // backward-compatibility shim, which keeps the (exporter, config)
    // two-argument constructor — unlike BatchLogRecordProcessor below, which
    // uses the newer single-options-object form. Confirmed against the
    // installed .d.ts files rather than assumed.
    new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesEndpoint }), {
      scheduledDelayMillis: BATCH_SCHEDULED_DELAY_MILLIS,
    }),
  ],
});
tracerProvider.register();

const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: logsEndpoint }),
      scheduledDelayMillis: BATCH_SCHEDULED_DELAY_MILLIS,
    }),
  ],
});
logs.setGlobalLoggerProvider(loggerProvider);

initMetrics(metricsEndpoint, resource);

const unregisterInstrumentations = registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => req.url === '/health',
      ignoreOutgoingRequestHook: (req) => req.path === '/health',
    }),
  ],
});

export async function shutdownTelemetry(): Promise<void> {
  unregisterInstrumentations();
  await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown(), shutdownMetrics()]);
}
