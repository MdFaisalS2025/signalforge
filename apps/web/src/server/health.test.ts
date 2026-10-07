import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../app/api/health/route';

// The health route reports only that the process is up. It must not touch ClickHouse, so this test calls the
// handler directly with no ClickHouse configuration present.
test('GET /api/health returns 200 with the exact ok body and no-store caching', async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /api/health carries exactly "application/json; charset=utf-8"', async () => {
  const response = await GET();
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
});
