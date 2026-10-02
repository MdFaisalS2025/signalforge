import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordHttpRequest } from '../src/metrics.js';

test('recordHttpRequest does not throw when telemetry was never initialized', () => {
  // metrics.ts never calls any global OpenTelemetry API setter — initMetrics()
  // only creates a local MeterProvider instance — so this test exercises the
  // no-op safety path without touching any global registry other tests share.
  assert.doesNotThrow(() => recordHttpRequest('/payments/charge', 'POST', 200, 0.01));
});
