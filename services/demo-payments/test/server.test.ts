import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

test('POST /payments/charge with a valid body returns 200 approved', async () => {
  const app = buildServer();
  const res = await app.inject({
    method: 'POST',
    url: '/payments/charge',
    payload: { order_id: '11111111-1111-1111-1111-111111111111', amount_cents: 500 },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { order_id: '11111111-1111-1111-1111-111111111111', payment_status: 'approved' });
});

test('POST /payments/charge with an invalid body returns 400', async () => {
  const app = buildServer();
  const res = await app.inject({
    method: 'POST',
    url: '/payments/charge',
    payload: { amount_cents: 500 },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid_request', message: 'order_id is required' });
});

test('GET /health returns 200 ok', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});
