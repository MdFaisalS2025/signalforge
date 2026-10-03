// Acceptance verification for the Orders → Payments observability slice.
//
// Requires demo-orders, demo-payments, and otel-collector to be running from
// infra/docker/docker-compose.yml. Each test scopes every Docker Compose log
// read with --since to the moment just before its own request, and matches on
// the unique order_id and the trace_id recovered from application logs — so
// stale logs or Collector output from earlier runs cannot satisfy an assertion.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join('infra', 'docker', 'docker-compose.yml');
const ORDERS_URL = 'http://localhost:8081';
const PAYMENTS_HEALTH_URL = 'http://localhost:8082/health';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10000;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const COLLECTOR_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+info\s+/;
const RESOURCE_HEADER = /^(ResourceSpans|ResourceLog|ResourceMetrics) #\d+$/;
const RECORD_HEADER = /^(Span|LogRecord|Metric) #\d+$/;

let currentSince;

function compose(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
      cwd: REPO_ROOT,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`docker compose ${args.join(' ')} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function logsSince(service, since) {
  const { stdout, stderr } = await compose(['logs', '--no-color', '--no-log-prefix', '--since', since, service]);
  return stdout + stderr;
}

async function pollUntil(check, { intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

async function isHealthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function unwrapTypedValue(raw) {
  const match = raw.match(/^[A-Za-z0-9]+\((.*)\)$/);
  return match ? match[1] : raw;
}

function normalizeKey(label) {
  return label.replace(/\s+/g, '').toLowerCase();
}

// Parses the Collector's `debug` exporter output at verbosity "detailed".
// Each record keeps the service.name of the ResourceSpans/ResourceLog/
// ResourceMetrics block it was printed under.
function parseCollectorOutput(text) {
  const records = { spans: [], logs: [], metrics: [] };
  let service;
  let current;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(COLLECTOR_TIMESTAMP_PREFIX, '').trim();
    if (!line) continue;

    if (RESOURCE_HEADER.test(line)) {
      service = undefined;
      current = undefined;
      continue;
    }

    const header = line.match(RECORD_HEADER);
    if (header) {
      current = { service, attrs: {} };
      if (header[1] === 'Span') records.spans.push(current);
      else if (header[1] === 'LogRecord') records.logs.push(current);
      else records.metrics.push(current);
      continue;
    }

    if (line.startsWith('->')) {
      const attr = line.slice(2).match(/^([^:]+):\s*(.*)$/);
      if (!attr) continue;
      const key = attr[1].trim();
      const value = unwrapTypedValue(attr[2].trim());
      if (!current) {
        if (key === 'service.name') service = value;
      } else {
        current.attrs[key] = value;
      }
      continue;
    }

    const field = line.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/);
    if (field && current) {
      current[normalizeKey(field[1])] = field[2].trim();
    }
  }

  for (const log of records.logs) {
    if (typeof log.body === 'string') log.body = unwrapTypedValue(log.body);
  }
  return records;
}

function findStdoutRecord(text, orderId, message) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.order_id === orderId && parsed.message === message) return parsed;
  }
  return undefined;
}

function requireTraceId(record, description) {
  if (typeof record.trace_id !== 'string' || !TRACE_ID_PATTERN.test(record.trace_id)) {
    throw new Error(`${description} has no well-formed trace_id: ${JSON.stringify(record)}`);
  }
  return record.trace_id;
}

function findServerSpan(records, traceId, service, urlPath) {
  return records.spans.find((s) =>
    s.traceid === traceId && s.service === service && s.kind === 'Server' && s.attrs['url.path'] === urlPath);
}

function findPaymentsClientSpans(records, traceId) {
  return records.spans.filter((s) =>
    s.traceid === traceId && s.service === 'demo-orders' && s.kind === 'Client'
    && (s.attrs['url.full'] || '').includes('/payments/charge'));
}

function findLogs(records, traceId, service) {
  return records.logs.filter((l) => l.traceid === traceId && l.service === service);
}

function hasMetric(records, service, route) {
  return records.metrics.some((m) =>
    m.service === service && m.attrs.Name === 'http_requests_total' && m.attrs.route === route);
}

async function printDiagnostics(since) {
  if (!since) {
    console.error('(no request was issued, so there are no since-scoped logs to print)');
    return;
  }
  for (const service of ['demo-orders', 'demo-payments', 'otel-collector']) {
    try {
      const text = await logsSince(service, since);
      console.error(`--- ${service} logs since ${since} ---`);
      console.error(text.trimEnd() || '(no output)');
    } catch (err) {
      console.error(`(could not read ${service} logs: ${err.message})`);
    }
  }
}

async function testSuccessfulRequest() {
  const orderId = randomUUID();
  currentSince = new Date().toISOString();
  const res = await fetch(`${ORDERS_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId, item: 'widget', amount_cents: 500 }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`Test 1: expected HTTP 201, got ${res.status}`);
  if (body.order_id !== orderId) throw new Error(`Test 1: response order_id ${body.order_id} does not match ${orderId}`);
  if (body.payment_status !== 'approved') {
    throw new Error(`Test 1: expected payment_status "approved", got ${JSON.stringify(body.payment_status)}`);
  }

  const completed = await pollUntil(
    async () => findStdoutRecord(await logsSince('demo-orders', currentSince), orderId, 'request completed'),
    { what: `Orders stdout "request completed" line for order ${orderId}` },
  );
  const traceId = requireTraceId(completed, 'Orders "request completed" stdout line');

  let missing = [];
  let collected;
  try {
    collected = await pollUntil(async () => {
      const records = parseCollectorOutput(await logsSince('otel-collector', currentSince));
      const serverOrders = findServerSpan(records, traceId, 'demo-orders', '/orders');
      const clientPayments = findPaymentsClientSpans(records, traceId)[0];
      const serverPayments = findServerSpan(records, traceId, 'demo-payments', '/payments/charge');
      missing = [];
      if (!serverOrders) missing.push('Orders inbound server span');
      if (!clientPayments) missing.push('Orders outbound client span');
      if (!serverPayments) missing.push('Payments inbound server span');
      if (findLogs(records, traceId, 'demo-orders').length === 0) missing.push('OTLP log from demo-orders');
      if (findLogs(records, traceId, 'demo-payments').length === 0) missing.push('OTLP log from demo-payments');
      if (!hasMetric(records, 'demo-orders', '/orders')) missing.push('http_requests_total from demo-orders');
      if (!hasMetric(records, 'demo-payments', '/payments/charge')) missing.push('http_requests_total from demo-payments');
      return missing.length === 0 ? { records, serverOrders, clientPayments, serverPayments } : false;
    }, { what: `Collector telemetry for trace ${traceId}` });
  } catch (err) {
    throw new Error(`${err.message}; still missing: ${missing.join(', ') || 'nothing observed yet'}`);
  }

  const { serverOrders, clientPayments, serverPayments } = collected;
  if (clientPayments.parentid !== serverOrders.id) {
    throw new Error(`Test 1: Orders client span parent ${clientPayments.parentid} != Orders server span ${serverOrders.id}`);
  }
  if (serverPayments.parentid !== clientPayments.id) {
    throw new Error(`Test 1: Payments server span parent ${serverPayments.parentid} != Orders client span ${clientPayments.id}`);
  }
}

async function testPaymentsUnavailable() {
  try {
    await compose(['stop', 'demo-payments']);

    currentSince = new Date().toISOString();
    const orderId = randomUUID();
    const res = await fetch(`${ORDERS_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, item: 'widget', amount_cents: 500 }),
    });
    const body = await res.json();
    if (res.status !== 502) throw new Error(`Test 2: expected HTTP 502, got ${res.status}`);
    const expectedBody = { order_id: orderId, status: 'failed', reason: 'payment_unavailable' };
    if (JSON.stringify(body) !== JSON.stringify(expectedBody)) {
      throw new Error(`Test 2: expected body ${JSON.stringify(expectedBody)}, got ${JSON.stringify(body)}`);
    }

    const errorLine = await pollUntil(
      async () => findStdoutRecord(await logsSince('demo-orders', currentSince), orderId, 'payment failed'),
      { what: `Orders stdout "payment failed" line for order ${orderId}` },
    );
    const traceId = requireTraceId(errorLine, 'Orders "payment failed" stdout line');

    const serverSpan = await pollUntil(async () => {
      const records = parseCollectorOutput(await logsSince('otel-collector', currentSince));
      return findServerSpan(records, traceId, 'demo-orders', '/orders');
    }, { what: `Orders inbound server span for trace ${traceId}` });
    if (serverSpan.statuscode !== 'Error') {
      throw new Error(
        `Test 2: Orders server span ${serverSpan.id} for trace ${traceId} has status "${serverSpan.statuscode}", expected "Error"`,
      );
    }
    if (serverSpan.statusmessage !== 'payment unavailable') {
      throw new Error(
        `Test 2: Orders server span ${serverSpan.id} for trace ${traceId} has status message "${serverSpan.statusmessage}", expected "payment unavailable"`,
      );
    }

    await pollUntil(async () => {
      const records = parseCollectorOutput(await logsSince('otel-collector', currentSince));
      return findLogs(records, traceId, 'demo-orders').some((l) => l.severitytext === 'ERROR');
    }, { what: `OTLP ERROR log from demo-orders for trace ${traceId}` });

    const clientCount = await pollUntil(async () => {
      const records = parseCollectorOutput(await logsSince('otel-collector', currentSince));
      const count = findPaymentsClientSpans(records, traceId).length;
      return count > 0 ? count : false;
    }, { what: `Orders outbound client span for trace ${traceId}` });
    if (clientCount !== 1) {
      throw new Error(`Test 2: expected exactly 1 outbound client span for trace ${traceId}, found ${clientCount}`);
    }
  } finally {
    await compose(['start', 'demo-payments']);
    await pollUntil(() => isHealthy(PAYMENTS_HEALTH_URL), { what: 'demo-payments /health after restart' });
  }
}

async function main() {
  try {
    await testSuccessfulRequest();
    console.log('PASS Test 1: successful request produced a correlated three-span trace, OTLP logs and metrics from both services');
    await testPaymentsUnavailable();
    console.log('PASS Test 2: payments-unavailable request returned 502, marked the server span ERROR, and made exactly one outbound attempt');
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    await printDiagnostics(currentSince);
    process.exitCode = 1;
  }
}

main();
