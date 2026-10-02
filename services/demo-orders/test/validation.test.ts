import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderRequest } from '../src/validation.js';

const VALID_ORDER_ID = '11111111-1111-1111-1111-111111111111';

test('accepts a valid order request', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: 'widget', amount_cents: 500 });
  assert.equal(result.ok, true);
});

test('rejects missing order_id', () => {
  const result = validateOrderRequest({ item: 'widget', amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'order_id is required' });
});

test('rejects a non-string order_id', () => {
  const result = validateOrderRequest({ order_id: 12345, item: 'widget', amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'order_id is required' });
});

test('rejects a malformed order_id', () => {
  const result = validateOrderRequest({ order_id: 'not-a-uuid', item: 'widget', amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'order_id must be a valid UUID' });
});

test('rejects missing item', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'item is required' });
});

test('rejects a non-string item', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: 42, amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'item is required' });
});

test('rejects an empty item', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: '', amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'item must not be empty' });
});

test('rejects a whitespace-only item', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: '   ', amount_cents: 500 });
  assert.deepEqual(result, { ok: false, message: 'item must not be empty' });
});

test('rejects missing amount_cents', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: 'widget' });
  assert.deepEqual(result, { ok: false, message: 'amount_cents is required' });
});

test('rejects non-integer amount_cents', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: 'widget', amount_cents: 12.5 });
  assert.deepEqual(result, { ok: false, message: 'amount_cents must be a positive integer' });
});

test('rejects zero amount_cents', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: 'widget', amount_cents: 0 });
  assert.deepEqual(result, { ok: false, message: 'amount_cents must be a positive integer' });
});

test('rejects negative amount_cents', () => {
  const result = validateOrderRequest({ order_id: VALID_ORDER_ID, item: 'widget', amount_cents: -1 });
  assert.deepEqual(result, { ok: false, message: 'amount_cents must be a positive integer' });
});
