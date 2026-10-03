import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

const VALID = { order_id: '11111111-1111-1111-1111-111111111111', amount_cents: 500 };

test('fault enabled: a valid charge returns 500 with the exact injected-fault body', async () => {
  const app = buildServer({ faultMode: 'enabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: VALID });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'injected_fault' });
  await app.close();
});

test('fault enabled: the fault is checked before validation, so an invalid body also returns 500', async () => {
  const app = buildServer({ faultMode: 'enabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: { amount_cents: 1 } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'injected_fault' });
  await app.close();
});

test('fault enabled: health remains 200', async () => {
  const app = buildServer({ faultMode: 'enabled' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});

test('fault disabled: a valid charge still returns the approved 200 response', async () => {
  const app = buildServer({ faultMode: 'disabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: VALID });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { order_id: VALID.order_id, payment_status: 'approved' });
  await app.close();
});

test('fault disabled: an invalid body still returns the existing 400 response', async () => {
  const app = buildServer({ faultMode: 'disabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: { amount_cents: 1 } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid_request', message: 'order_id is required' });
  await app.close();
});
