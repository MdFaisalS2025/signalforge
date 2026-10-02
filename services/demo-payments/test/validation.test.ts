import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChargeRequest } from '../src/validation.js';

test('accepts a valid charge request', () => {
  const result = validateChargeRequest({ order_id: '11111111-1111-1111-1111-111111111111', amount_cents: 500 });
  assert.equal(result.ok, true);
});

test('rejects missing order_id', () => {
  const result = validateChargeRequest({ amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'order_id is required' });
});

test('rejects a malformed order_id', () => {
  const result = validateChargeRequest({ order_id: 'not-a-uuid', amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'order_id must be a valid UUID' });
});

test('rejects missing amount_cents', () => {
  const result = validateChargeRequest({ order_id: '11111111-1111-1111-1111-111111111111' });
  assert.deepEqual(result, { ok: false, message: 'amount_cents is required' });
});

test('rejects non-integer amount_cents', () => {
  const result = validateChargeRequest({ order_id: '11111111-1111-1111-1111-111111111111', amount_cents: 12.5 });
  assert.deepEqual(result, { ok: false, message: 'amount_cents must be a positive integer' });
});

test('rejects non-positive amount_cents', () => {
  const result = validateChargeRequest({ order_id: '11111111-1111-1111-1111-111111111111', amount_cents: 0 });
  assert.deepEqual(result, { ok: false, message: 'amount_cents must be a positive integer' });
});
