import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine } from '../src/logger.js';

test('formatLogLine includes trace_id/span_id when a SpanContextLike is supplied', () => {
  const line = formatLogLine('info', 'test message', { order_id: 'abc-123' }, { traceId: 'trace-abc', spanId: 'span-def' });
  const parsed = JSON.parse(line);
  assert.equal(parsed.trace_id, 'trace-abc');
  assert.equal(parsed.span_id, 'span-def');
  assert.equal(parsed.order_id, 'abc-123');
  assert.equal(parsed.level, 'info');
});

test('formatLogLine omits trace_id/span_id when no span context is supplied', () => {
  const line = formatLogLine('info', 'no span here', { order_id: 'xyz' });
  const parsed = JSON.parse(line);
  assert.equal('trace_id' in parsed, false);
  assert.equal('span_id' in parsed, false);
  assert.equal(parsed.order_id, 'xyz');
});

test('formatLogLine output contains level, message, attributes, and a valid ISO timestamp', () => {
  const line = formatLogLine('warn', 'something happened', { order_id: 'order-1', status_code: 400 });
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.message, 'something happened');
  assert.equal(parsed.order_id, 'order-1');
  assert.equal(parsed.status_code, 400);
  assert.equal(typeof parsed.timestamp, 'string');
  assert.equal(Number.isNaN(Date.parse(parsed.timestamp)), false, 'timestamp must be a parseable date');
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'timestamp must be ISO 8601');
});

test('application attributes cannot overwrite reserved fields when a span context is active', () => {
  const line = formatLogLine(
    'error',
    'real message',
    { level: 'SPOOFED', message: 'SPOOFED', timestamp: 'SPOOFED', trace_id: 'SPOOFED', span_id: 'SPOOFED', order_id: 'real-order-id' },
    { traceId: 'real-trace-id', spanId: 'real-span-id' },
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.message, 'real message');
  assert.equal(parsed.trace_id, 'real-trace-id');
  assert.equal(parsed.span_id, 'real-span-id');
  assert.notEqual(parsed.timestamp, 'SPOOFED');
  assert.equal(parsed.order_id, 'real-order-id', 'non-reserved attributes must still pass through');
});

test('application attributes cannot inject trace_id/span_id when no span context is active', () => {
  const line = formatLogLine('info', 'no span here', { trace_id: 'SPOOFED', span_id: 'SPOOFED', order_id: 'real-order-id' });
  const parsed = JSON.parse(line);
  assert.equal('trace_id' in parsed, false, 'a spoofed trace_id must not survive when there is no real span context');
  assert.equal('span_id' in parsed, false, 'a spoofed span_id must not survive when there is no real span context');
  assert.equal(parsed.order_id, 'real-order-id');
});
