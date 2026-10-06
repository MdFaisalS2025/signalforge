import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClickHouseUnavailable,
  clientOptions,
  createClickHouseReader,
  readConfig,
  type ClickHouseConfig,
  type Logger,
  type Transport,
} from './clickhouse';
import { QUERIES } from './queries';

type Call = { sql: string; params: Record<string, unknown> };

// A transport that records each call and returns canned rows. It stands in for the ClickHouse client, so these
// tests need no server and no network.
function fakeTransport(rows: unknown[] = [], failure?: Error) {
  const calls: Call[] = [];
  const transport: Transport = {
    async select<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
      calls.push({ sql, params });
      if (failure) throw failure;
      return rows as T[];
    },
  };
  return { transport, calls };
}

function captureLogger() {
  const errors: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const logger: Logger = {
    error(message, meta) {
      errors.push({ message, meta });
    },
  };
  return { logger, errors };
}

const INCIDENT_ID = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const DEPLOYMENT_ID = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';

test('listIncidents sends Q1 with a typed limit parameter', async () => {
  const { transport, calls } = fakeTransport([{ incident_id: INCIDENT_ID }]);
  const reader = createClickHouseReader(transport, captureLogger().logger);
  const rows = await reader.listIncidents(20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, QUERIES.Q1);
  assert.deepEqual(calls[0].params, { limit: 20 });
  assert.deepEqual(rows, [{ incident_id: INCIDENT_ID }]);
});

test('getIncident sends Q2 and returns null when no row exists', async () => {
  const found = fakeTransport([{ incident_id: INCIDENT_ID }]);
  const row = await createClickHouseReader(found.transport, captureLogger().logger).getIncident(INCIDENT_ID);
  assert.equal(found.calls[0].sql, QUERIES.Q2);
  assert.deepEqual(found.calls[0].params, { incident_id: INCIDENT_ID });
  assert.deepEqual(row, { incident_id: INCIDENT_ID });

  const missing = fakeTransport([]);
  const none = await createClickHouseReader(missing.transport, captureLogger().logger).getIncident(INCIDENT_ID);
  assert.equal(none, null);
});

test('listEvidence sends Q3 with the incident ID', async () => {
  const { transport, calls } = fakeTransport([]);
  await createClickHouseReader(transport, captureLogger().logger).listEvidence(INCIDENT_ID);
  assert.equal(calls[0].sql, QUERIES.Q3);
  assert.deepEqual(calls[0].params, { incident_id: INCIDENT_ID });
});

test('getDeployment sends Q4 and returns null when no row exists', async () => {
  const found = fakeTransport([{ deployment_id: DEPLOYMENT_ID }]);
  const row = await createClickHouseReader(found.transport, captureLogger().logger).getDeployment(DEPLOYMENT_ID);
  assert.equal(found.calls[0].sql, QUERIES.Q4);
  assert.deepEqual(found.calls[0].params, { deployment_id: DEPLOYMENT_ID });
  assert.deepEqual(row, { deployment_id: DEPLOYMENT_ID });

  const missing = fakeTransport([]);
  assert.equal(await createClickHouseReader(missing.transport, captureLogger().logger).getDeployment(DEPLOYMENT_ID), null);
});

test('listDeployments sends Q5 with a typed limit parameter', async () => {
  const { transport, calls } = fakeTransport([]);
  await createClickHouseReader(transport, captureLogger().logger).listDeployments(10);
  assert.equal(calls[0].sql, QUERIES.Q5);
  assert.deepEqual(calls[0].params, { limit: 10 });
});

test('failingTraces sends Q6 with the deployment-ID array parameter', async () => {
  const { transport, calls } = fakeTransport([{ deployment_id: DEPLOYMENT_ID, failing_traces: '3' }]);
  const rows = await createClickHouseReader(transport, captureLogger().logger).failingTraces([DEPLOYMENT_ID]);
  assert.equal(calls[0].sql, QUERIES.Q6);
  assert.deepEqual(calls[0].params, { deployment_ids: [DEPLOYMENT_ID] });
  assert.deepEqual(rows, [{ deployment_id: DEPLOYMENT_ID, failing_traces: '3' }]);
});

test('incidentLinks sends Q7 with the deployment-ID array parameter', async () => {
  const { transport, calls } = fakeTransport([]);
  await createClickHouseReader(transport, captureLogger().logger).incidentLinks([DEPLOYMENT_ID]);
  assert.equal(calls[0].sql, QUERIES.Q7);
  assert.deepEqual(calls[0].params, { deployment_ids: [DEPLOYMENT_ID] });
});

test('every operation sends only the static query constants, never caller text', async () => {
  const { transport, calls } = fakeTransport([]);
  const reader = createClickHouseReader(transport, captureLogger().logger);
  await reader.listIncidents(5);
  await reader.getIncident(INCIDENT_ID);
  await reader.listEvidence(INCIDENT_ID);
  await reader.getDeployment(DEPLOYMENT_ID);
  await reader.listDeployments(5);
  await reader.failingTraces([DEPLOYMENT_ID]);
  await reader.incidentLinks([DEPLOYMENT_ID]);
  const constants = new Set(Object.values(QUERIES));
  for (const call of calls) assert.ok(constants.has(call.sql), `unexpected SQL: ${call.sql}`);
  assert.equal(calls.length, 7);
});

test('an out-of-range limit is refused before any query is sent', async () => {
  const { transport, calls } = fakeTransport([]);
  const reader = createClickHouseReader(transport, captureLogger().logger);
  for (const bad of [0, -1, 1.5, Number.NaN, 1e12]) {
    await assert.rejects(() => reader.listIncidents(bad), RangeError);
  }
  assert.equal(calls.length, 0);
});

test('a transport failure becomes ClickHouseUnavailable with a stable, redacted message', async () => {
  const driverError = new Error('Code: 210. DB::NetException: Connection refused to clickhouse:8123 SELECT count() FROM signalforge.incidents');
  const { transport } = fakeTransport([], driverError);
  const { logger } = captureLogger();
  const reader = createClickHouseReader(transport, logger);

  await assert.rejects(
    () => reader.listIncidents(20),
    (error: unknown) => {
      assert.ok(error instanceof ClickHouseUnavailable, 'expected ClickHouseUnavailable');
      assert.equal(error.message, 'ClickHouse is unavailable');
      assert.equal(error.name, 'ClickHouseUnavailable');
      const text = `${error.message} ${String(error)}`;
      assert.ok(!text.includes('SELECT'), 'public error must not contain SQL text');
      assert.ok(!text.includes('Connection refused'), 'public error must not contain driver text');
      assert.ok(!text.includes('Code: 210'), 'public error must not contain driver error codes');
      return true;
    },
  );
});

test('the driver error is logged server-side with the operation name', async () => {
  const driverError = new Error('Code: 210. DB::NetException: Connection refused');
  const { transport } = fakeTransport([], driverError);
  const { logger, errors } = captureLogger();
  await assert.rejects(() => createClickHouseReader(transport, logger).getIncident(INCIDENT_ID), ClickHouseUnavailable);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.operation, 'getIncident');
  assert.match(String(errors[0].meta.error), /Connection refused/);
});

test('clientOptions sets the read-only setting and the five-second request timeout', () => {
  const config: ClickHouseConfig = {
    url: 'http://clickhouse:8123',
    database: 'signalforge',
    username: 'dashboard_reader',
    password: 'changeme-local-only',
  };
  const options = clientOptions(config);
  assert.equal(options.request_timeout, 5000);
  assert.deepEqual(options.clickhouse_settings, { readonly: '1' });
  assert.equal(options.url, 'http://clickhouse:8123');
  assert.equal(options.database, 'signalforge');
  assert.equal(options.username, 'dashboard_reader');
  assert.equal(options.password, 'changeme-local-only');
});

const FULL_ENV = {
  CLICKHOUSE_URL: 'http://clickhouse:8123',
  CLICKHOUSE_DATABASE: 'signalforge',
  CLICKHOUSE_USER: 'dashboard_reader',
  CLICKHOUSE_PASSWORD: 'changeme-local-only',
};

test('readConfig reads the four variables from the environment', () => {
  assert.deepEqual(readConfig(FULL_ENV), {
    url: 'http://clickhouse:8123',
    database: 'signalforge',
    username: 'dashboard_reader',
    password: 'changeme-local-only',
  });
});

test('readConfig refuses to start when any variable is missing, and names only the variable', () => {
  for (const name of Object.keys(FULL_ENV)) {
    const env: Record<string, string | undefined> = { ...FULL_ENV, [name]: undefined };
    assert.throws(
      () => readConfig(env),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(name));
        assert.ok(!error.message.includes('changeme-local-only'), 'the error must not echo a credential');
        return true;
      },
    );
  }
});

test('readConfig does not fall back to a default account or password', () => {
  assert.throws(() => readConfig({ ...FULL_ENV, CLICKHOUSE_USER: '' }), /CLICKHOUSE_USER/);
  assert.throws(() => readConfig({ ...FULL_ENV, CLICKHOUSE_PASSWORD: '' }), /CLICKHOUSE_PASSWORD/);
});
