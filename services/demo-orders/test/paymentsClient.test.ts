import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAxiosPaymentsClient, PaymentsClientError } from '../src/paymentsClient.js';

const ORDER_ID = '11111111-1111-1111-1111-111111111111';

function startStubServer(handler: http.RequestListener) {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    handler(req, res);
  });
  return new Promise<{ url: string; getRequestCount: () => number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        getRequestCount: () => requestCount,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

test('charge() resolves with paymentStatus approved on a clean 200 response', async () => {
  const stub = await startStubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ order_id: ORDER_ID, payment_status: 'approved' }));
  });
  try {
    const client = createAxiosPaymentsClient(stub.url, 1000);
    const result = await client.charge(ORDER_ID, 500);
    assert.deepEqual(result, { paymentStatus: 'approved' });
    assert.equal(stub.getRequestCount(), 1, 'exactly one request attempt');
  } finally {
    await stub.close();
  }
});

test('charge() sends POST /payments/charge with the exact order_id and amount_cents in the body', async () => {
  let capturedMethod = '';
  let capturedUrl = '';
  let capturedBody: unknown;
  const stub = await startStubServer(async (req, res) => {
    capturedMethod = req.method ?? '';
    capturedUrl = req.url ?? '';
    capturedBody = JSON.parse(await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ order_id: ORDER_ID, payment_status: 'approved' }));
  });
  try {
    const client = createAxiosPaymentsClient(stub.url, 1000);
    await client.charge(ORDER_ID, 500);
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedUrl, '/payments/charge');
    assert.deepEqual(capturedBody, { order_id: ORDER_ID, amount_cents: 500 });
  } finally {
    await stub.close();
  }
});

test('charge() throws PaymentsClientError on a non-2xx response', async () => {
  const stub = await startStubServer((req, res) => { res.writeHead(404); res.end(); });
  try {
    const client = createAxiosPaymentsClient(stub.url, 1000);
    await assert.rejects(() => client.charge(ORDER_ID, 500), PaymentsClientError);
    assert.equal(stub.getRequestCount(), 1, 'exactly one request attempt');
  } finally {
    await stub.close();
  }
});

test('charge() throws PaymentsClientError on a malformed 200 response body', async () => {
  const stub = await startStubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ unexpected: 'shape' }));
  });
  try {
    const client = createAxiosPaymentsClient(stub.url, 1000);
    await assert.rejects(() => client.charge(ORDER_ID, 500), PaymentsClientError);
    assert.equal(stub.getRequestCount(), 1, 'exactly one request attempt');
  } finally {
    await stub.close();
  }
});

test('charge() throws PaymentsClientError when the response order_id does not match the request', async () => {
  const stub = await startStubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ order_id: '22222222-2222-2222-2222-222222222222', payment_status: 'approved' }));
  });
  try {
    const client = createAxiosPaymentsClient(stub.url, 1000);
    await assert.rejects(() => client.charge(ORDER_ID, 500), PaymentsClientError);
    assert.equal(stub.getRequestCount(), 1, 'exactly one request attempt');
  } finally {
    await stub.close();
  }
});

test('charge() throws PaymentsClientError on connection refusal', async () => {
  // Nothing listens on port 1 (a privileged port); no server to start or clean up.
  const client = createAxiosPaymentsClient('http://127.0.0.1:1', 500);
  await assert.rejects(() => client.charge(ORDER_ID, 500), PaymentsClientError);
});

test('charge() throws PaymentsClientError when the server does not respond before the timeout', async () => {
  const stub = await startStubServer(() => {
    // Intentionally never call res.end() or res.writeHead() — the connection hangs.
  });
  try {
    const client = createAxiosPaymentsClient(stub.url, 200);
    await assert.rejects(() => client.charge(ORDER_ID, 500), PaymentsClientError);
    assert.equal(stub.getRequestCount(), 1, 'exactly one request attempt');
  } finally {
    await stub.close();
  }
});
