import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { PaymentsClientError } from '../src/paymentsClient.js';
import type { PaymentsClient } from '../src/paymentsClient.js';

const ORDER_ID = '11111111-1111-1111-1111-111111111111';

interface RecordingClient extends PaymentsClient {
  calls: Array<{ orderId: string; amountCents: number }>;
}

function createRecordingClient(
  impl: (orderId: string, amountCents: number) => Promise<{ paymentStatus: 'approved' }>,
): RecordingClient {
  const calls: Array<{ orderId: string; amountCents: number }> = [];
  return {
    calls,
    async charge(orderId: string, amountCents: number) {
      calls.push({ orderId, amountCents });
      return impl(orderId, amountCents);
    },
  };
}

test('POST /orders returns the exact documented 201 body when Payments approves', async () => {
  const paymentsClient = createRecordingClient(async () => ({ paymentStatus: 'approved' }));
  const app = buildServer({ paymentsClient });
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { order_id: ORDER_ID, item: 'widget', amount_cents: 500 },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { order_id: ORDER_ID, status: 'created', payment_status: 'approved' });
  await app.close();
});

test('POST /orders calls Payments exactly once with the exact order_id and amount_cents', async () => {
  const paymentsClient = createRecordingClient(async () => ({ paymentStatus: 'approved' }));
  const app = buildServer({ paymentsClient });
  await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { order_id: ORDER_ID, item: 'widget', amount_cents: 500 },
  });
  assert.equal(paymentsClient.calls.length, 1);
  assert.deepEqual(paymentsClient.calls[0], { orderId: ORDER_ID, amountCents: 500 });
  await app.close();
});

test('POST /orders returns the exact documented 502 body when Payments fails', async () => {
  const paymentsClient = createRecordingClient(async () => {
    throw new PaymentsClientError('payments request failed');
  });
  const app = buildServer({ paymentsClient });
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { order_id: ORDER_ID, item: 'widget', amount_cents: 500 },
  });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { order_id: ORDER_ID, status: 'failed', reason: 'payment_unavailable' });
  await app.close();
});

test('POST /orders calls Payments exactly once even when it fails', async () => {
  const paymentsClient = createRecordingClient(async () => {
    throw new PaymentsClientError('payments request failed');
  });
  const app = buildServer({ paymentsClient });
  await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { order_id: ORDER_ID, item: 'widget', amount_cents: 500 },
  });
  assert.equal(paymentsClient.calls.length, 1);
  await app.close();
});

test('POST /orders does not convert an unrelated programming error into a 502', async () => {
  const paymentsClient = createRecordingClient(async () => {
    throw new Error('unexpected bug unrelated to payments');
  });
  const app = buildServer({ paymentsClient });
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { order_id: ORDER_ID, item: 'widget', amount_cents: 500 },
  });
  assert.notEqual(res.statusCode, 502, 'a non-PaymentsClientError must not be reported as a payment failure');
  assert.equal(res.statusCode, 500, "Fastify's default error handling applies instead");
  await app.close();
});

test('POST /orders with an invalid body returns the exact 400 validation response', async () => {
  const paymentsClient = createRecordingClient(async () => ({ paymentStatus: 'approved' }));
  const app = buildServer({ paymentsClient });
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { item: 'widget', amount_cents: 500 },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid_request', message: 'order_id is required' });
  assert.equal(paymentsClient.calls.length, 0, 'Payments must not be called for an invalid request');
  await app.close();
});

test('POST /orders with malformed JSON returns Fastify\'s safe 400', async () => {
  const paymentsClient = createRecordingClient(async () => ({ paymentStatus: 'approved' }));
  const app = buildServer({ paymentsClient });
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'content-type': 'application/json' },
    payload: '{ "order_id": "11111111-1111-1111-1111-111111111111", "item": "widget", "amount_cents": 500 ',
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal('stack' in body, false, 'response must not expose a stack trace');
  await app.close();
});

test('GET /health returns the exact documented 200 body', async () => {
  const paymentsClient = createRecordingClient(async () => ({ paymentStatus: 'approved' }));
  const app = buildServer({ paymentsClient });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});
