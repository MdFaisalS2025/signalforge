// Cross-platform (Node child_process) check that demo-orders' OpenTelemetry
// instrumentation registers before Fastify/axios/http load, by verifying a
// syntactically valid, non-zero W3C `traceparent` header actually reaches a
// disposable stub Payments server for a real request.
//
// Task 5 scope note: this script verifies propagation at the wire (the
// traceparent header received by Payments), not stdout correlation — logEvent()
// and stdout trace_id/span_id enrichment don't exist until Task 6, which will
// extend this script with that additional assertion.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const ALL_ZERO_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZERO_SPAN_ID = '0000000000000000';

async function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startStubPaymentsServer() {
  let requestCount = 0;
  let capturedTraceparent;
  const server = http.createServer((req, res) => {
    requestCount++;
    capturedTraceparent = req.headers['traceparent'];
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { order_id } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ order_id, payment_status: 'approved' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        getRequestCount: () => requestCount,
        getCapturedTraceparent: () => capturedTraceparent,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

async function pollUntil(check, { intervalMs = 200, timeoutMs = 10000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

async function main() {
  const stubPayments = await startStubPaymentsServer();
  const ordersPort = await getEphemeralPort();
  let ordersProcess;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  try {
    ordersProcess = spawn('node', ['dist/main.js'], {
      cwd: 'services/demo-orders',
      env: {
        ...process.env,
        PORT: String(ordersPort),
        OTEL_SERVICE_NAME: 'demo-orders',
        PAYMENTS_URL: stubPayments.url,
        PAYMENTS_TIMEOUT_MS: '3000',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4318/v1/metrics',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
      },
    });
    ordersProcess.on('error', (err) => { stderrBuffer += `spawn error: ${err.message}\n`; });
    ordersProcess.stdout.on('data', (d) => { stdoutBuffer += d.toString(); });
    ordersProcess.stderr.on('data', (d) => { stderrBuffer += d.toString(); });

    await pollUntil(async () => {
      try { return (await fetch(`http://127.0.0.1:${ordersPort}/health`)).ok; }
      catch { return false; }
    }, { what: 'demo-orders /health to respond' });

    const orderId = randomUUID();
    const res = await fetch(`http://127.0.0.1:${ordersPort}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, item: 'widget', amount_cents: 500 }),
    });
    if (res.status !== 201) {
      throw new Error(`Expected 201 from /orders, got ${res.status}`);
    }

    await pollUntil(() => stubPayments.getRequestCount() >= 1, { what: 'Payments stub to receive the request' });

    if (stubPayments.getRequestCount() !== 1) {
      throw new Error(`Expected exactly 1 request to Payments, got ${stubPayments.getRequestCount()}`);
    }

    const traceparent = stubPayments.getCapturedTraceparent();
    if (!traceparent || !TRACEPARENT_PATTERN.test(traceparent)) {
      throw new Error(`Expected a syntactically valid W3C traceparent header, got: ${JSON.stringify(traceparent)}`);
    }

    const [, traceId, spanId] = traceparent.split('-');
    if (traceId.toLowerCase() === ALL_ZERO_TRACE_ID) {
      throw new Error(`traceparent trace-id must be non-zero, got: ${traceparent}`);
    }
    if (spanId.toLowerCase() === ALL_ZERO_SPAN_ID) {
      throw new Error(`traceparent parent-id must be non-zero, got: ${traceparent}`);
    }

    console.log('PASS: bootstrap order is correct — a valid, non-zero traceparent propagated to Payments');
    console.log(`      traceparent shape (representative): ${traceparent.slice(0, 3)}...-...-...-${traceparent.slice(-2)}`);
  } catch (err) {
    console.error('FAIL:', err.message);
    console.error('--- demo-orders stdout ---\n' + stdoutBuffer);
    console.error('--- demo-orders stderr ---\n' + stderrBuffer);
    process.exitCode = 1;
  } finally {
    if (ordersProcess) ordersProcess.kill();
    await stubPayments.close();
  }
}

main();
