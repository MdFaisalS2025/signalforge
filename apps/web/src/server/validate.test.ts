import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidInput, parseIncidentId, parseLimit } from './validate';

// UUIDv5 incident IDs from the correlator (for example, from UUIDv5(dedup_key|<nanoseconds>)).
const UUIDV5 = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const UUIDV4 = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';

test('parseIncidentId accepts a UUIDv5 incident ID and returns it unchanged', () => {
  assert.equal(parseIncidentId(UUIDV5), UUIDV5);
});

test('parseIncidentId accepts an upper-case UUID', () => {
  assert.equal(parseIncidentId(UUIDV4.toUpperCase()), UUIDV4.toUpperCase());
});

test('parseIncidentId rejects malformed input and names incident_id', () => {
  const malformed = [
    '',
    'not-a-uuid',
    'e53eb170-13e0-5ea4-b38e-3738b5013ce',
    'e53eb170-13e0-5ea4-b38e-3738b5013ce45',
    ' e53eb170-13e0-5ea4-b38e-3738b5013ce4',
    'e53eb170-13e0-5ea4-b38e-3738b5013ce4; DROP TABLE incidents',
    'e53eb170-13e0-5ea4-b38e-3738b5013ce4}',
    'z53eb170-13e0-5ea4-b38e-3738b5013ce4',
  ];
  for (const input of malformed) {
    assert.throws(
      () => parseIncidentId(input),
      (error: unknown) => error instanceof InvalidInput && error.field === 'incident_id',
      `expected InvalidInput for ${JSON.stringify(input)}`,
    );
  }
});

test('parseIncidentId rejects non-string input', () => {
  for (const input of [undefined, null, 42, ['e53eb170-13e0-5ea4-b38e-3738b5013ce4']]) {
    assert.throws(
      () => parseIncidentId(input),
      (error: unknown) => error instanceof InvalidInput && error.field === 'incident_id',
    );
  }
});

test('an absent limit uses the fallback', () => {
  assert.equal(parseLimit(undefined, { fallback: 20, max: 100 }), 20);
  assert.equal(parseLimit(undefined, { fallback: 10, max: 50 }), 10);
});

test('the incident-list limit accepts 1 through its cap of 100', () => {
  assert.equal(parseLimit('1', { fallback: 20, max: 100 }), 1);
  assert.equal(parseLimit('20', { fallback: 20, max: 100 }), 20);
  assert.equal(parseLimit('100', { fallback: 20, max: 100 }), 100);
});

test('the deployment-list limit accepts 1 through its cap of 50', () => {
  assert.equal(parseLimit('1', { fallback: 10, max: 50 }), 1);
  assert.equal(parseLimit('50', { fallback: 10, max: 50 }), 50);
});

test('a limit over its cap is rejected and names limit', () => {
  assert.throws(
    () => parseLimit('101', { fallback: 20, max: 100 }),
    (error: unknown) => error instanceof InvalidInput && error.field === 'limit',
  );
  assert.throws(
    () => parseLimit('51', { fallback: 10, max: 50 }),
    (error: unknown) => error instanceof InvalidInput && error.field === 'limit',
  );
});

test('zero, negatives, decimals, whitespace, and non-numeric limits are rejected', () => {
  const rejected = ['0', '-1', '-0', '1.5', '2.0', '1e2', '0x10', '+5', '05', ' 5', '5 ', '   ', '', 'abc', '5;'];
  for (const input of rejected) {
    assert.throws(
      () => parseLimit(input, { fallback: 20, max: 100 }),
      (error: unknown) => error instanceof InvalidInput && error.field === 'limit',
      `expected InvalidInput for ${JSON.stringify(input)}`,
    );
  }
});

test('a huge limit is rejected before any numeric conversion can overflow', () => {
  assert.throws(
    () => parseLimit('9'.repeat(400), { fallback: 20, max: 100 }),
    (error: unknown) => error instanceof InvalidInput && error.field === 'limit',
  );
});

test('a non-string limit is rejected', () => {
  for (const input of [20, null, ['20'], {}]) {
    assert.throws(
      () => parseLimit(input, { fallback: 20, max: 100 }),
      (error: unknown) => error instanceof InvalidInput && error.field === 'limit',
    );
  }
});

test('InvalidInput carries its field name and is an Error', () => {
  const error = new InvalidInput('limit', 'limit must be an integer from 1 to 100');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'InvalidInput');
  assert.equal(error.field, 'limit');
  assert.equal(error.message, 'limit must be an integer from 1 to 100');
});
