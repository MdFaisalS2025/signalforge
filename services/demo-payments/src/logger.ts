import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

export type LogSeverity = 'info' | 'warn' | 'error';

export interface SpanContextLike {
  traceId: string;
  spanId: string;
}

const SEVERITY_NUMBERS: Record<LogSeverity, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const SEVERITY_TEXT: Record<LogSeverity, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

/**
 * Pure formatter: no OTel API calls, no I/O. Caller-supplied attributes are
 * spread first and the reserved fields (level, message, timestamp, trace_id,
 * span_id) are assigned afterward, so an attribute can never spoof one of
 * them — including stripping a spoofed trace_id/span_id when no real span
 * context exists, rather than letting it leak through unmodified.
 */
export function formatLogLine(
  severity: LogSeverity,
  message: string,
  attributes: Record<string, string | number | boolean>,
  spanContext?: SpanContextLike,
): string {
  const record: Record<string, unknown> = { ...attributes };
  record.level = severity;
  record.message = message;
  record.timestamp = new Date().toISOString();
  if (spanContext) {
    record.trace_id = spanContext.traceId;
    record.span_id = spanContext.spanId;
  } else {
    delete record.trace_id;
    delete record.span_id;
  }
  return JSON.stringify(record);
}

export function logEvent(
  severity: LogSeverity,
  message: string,
  attributes: Record<string, string | number | boolean>,
): void {
  // The OTel LogRecord is correlated to the active trace/span automatically
  // by the SDK via ambient context — trace_id/span_id are never added here
  // as ordinary attributes.
  logs.getLogger('demo').emit({
    severityNumber: SEVERITY_NUMBERS[severity],
    severityText: SEVERITY_TEXT[severity],
    body: message,
    attributes,
  });

  // The stdout line needs its own, separate correlation: formatLogLine()
  // reads the active span explicitly, since the automatic OTLP correlation
  // above has no effect on a plain console.log string.
  const spanContext = trace.getActiveSpan()?.spanContext();
  console.log(formatLogLine(severity, message, attributes, spanContext));
}
