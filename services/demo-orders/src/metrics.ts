import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { Resource } from '@opentelemetry/resources';
import type { Counter, Histogram } from '@opentelemetry/api';

const METRIC_EXPORT_INTERVAL_MILLIS = 1000;

let meterProvider: MeterProvider | undefined;
let requestCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;

export function initMetrics(endpoint: string, resource: Resource): void {
  const exporter = new OTLPMetricExporter({ url: endpoint });
  meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: METRIC_EXPORT_INTERVAL_MILLIS })],
  });

  // Instruments are created exactly once, here, and reused by every call to
  // recordHttpRequest() — never created per-request.
  const meter = meterProvider.getMeter('demo');
  requestCounter = meter.createCounter('http_requests_total');
  durationHistogram = meter.createHistogram('http_request_duration_seconds');
}

export function recordHttpRequest(route: string, method: string, statusCode: number, durationSeconds: number): void {
  if (!meterProvider || !requestCounter || !durationHistogram) return; // safe no-op if telemetry was never initialized (e.g. in a unit test)
  const attributes = { route, method, status_code: statusCode };
  requestCounter.add(1, attributes);
  durationHistogram.record(durationSeconds, attributes);
}

export async function shutdownMetrics(): Promise<void> {
  if (!meterProvider) return;
  await meterProvider.shutdown();
}
