import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseError } from '@clickhouse/client';
import {
  ClickHouseUnavailable,
  DiagnosisUnavailable,
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
  await reader.latestDiagnosis(INCIDENT_ID);
  await reader.latestDiagnoses([INCIDENT_ID]);
  const constants = new Set(Object.values(QUERIES));
  for (const call of calls) assert.ok(constants.has(call.sql), `unexpected SQL: ${call.sql}`);
  assert.equal(calls.length, 9);
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

const DIAGNOSIS_ROW = {
  diagnosis_version: 2,
  status: 'completed',
  confidence: 'high',
  failure_code: '',
  document: '{}',
  created_at: '2026-10-07 21:49:41.208',
};

test('latestDiagnosis sends Q8 with the incident ID and returns the one row, or null', async () => {
  const found = fakeTransport([DIAGNOSIS_ROW]);
  const row = await createClickHouseReader(found.transport, captureLogger().logger).latestDiagnosis(INCIDENT_ID);
  assert.equal(found.calls.length, 1);
  assert.equal(found.calls[0].sql, QUERIES.Q8);
  assert.deepEqual(found.calls[0].params, { incident_id: INCIDENT_ID });
  assert.deepEqual(row, DIAGNOSIS_ROW);

  const none = fakeTransport([]);
  assert.equal(await createClickHouseReader(none.transport, captureLogger().logger).latestDiagnosis(INCIDENT_ID), null);
});

test('latestDiagnoses sends Q9 with the ID array, and sends nothing for an empty list', async () => {
  const summary = { incident_id: INCIDENT_ID, diagnosis_version: 2, status: 'completed', confidence: 'high' };
  const { transport, calls } = fakeTransport([summary]);
  const reader = createClickHouseReader(transport, captureLogger().logger);
  assert.deepEqual(await reader.latestDiagnoses([INCIDENT_ID]), [summary]);
  assert.equal(calls[0].sql, QUERIES.Q9);
  assert.deepEqual(calls[0].params, { incident_ids: [INCIDENT_ID] });

  assert.deepEqual(await reader.latestDiagnoses([]), []);
  assert.equal(calls.length, 1, 'an empty list must not reach ClickHouse');
});

test('latestDiagnoses refuses more than 100 IDs before any query is sent', async () => {
  const { transport, calls } = fakeTransport([]);
  const reader = createClickHouseReader(transport, captureLogger().logger);
  await assert.rejects(() => reader.latestDiagnoses(Array(101).fill(INCIDENT_ID)), RangeError);
  assert.equal(calls.length, 0);
  await reader.latestDiagnoses(Array(100).fill(INCIDENT_ID));
  assert.equal(calls.length, 1);
});

test('a ClickHouse rejection of a diagnosis query is DiagnosisUnavailable, not ClickHouseUnavailable', async () => {
  const missingTable = new ClickHouseError({ message: 'Table signalforge.diagnoses does not exist', code: '60', type: 'UNKNOWN_TABLE' });
  for (const call of [
    (r: ReturnType<typeof createClickHouseReader>) => r.latestDiagnosis(INCIDENT_ID),
    (r: ReturnType<typeof createClickHouseReader>) => r.latestDiagnoses([INCIDENT_ID]),
  ]) {
    const { transport } = fakeTransport([], missingTable);
    const { logger, errors } = captureLogger();
    await assert.rejects(
      () => call(createClickHouseReader(transport, logger)),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosisUnavailable);
        assert.ok(!(error instanceof ClickHouseUnavailable));
        assert.ok(!error.message.includes('diagnoses'), 'the public error must not name tables');
        return true;
      },
    );
    assert.equal(errors.length, 1);
  }
});

test('a connectivity failure on a diagnosis query is still ClickHouseUnavailable', async () => {
  const { transport } = fakeTransport([], new Error('connect ECONNREFUSED 127.0.0.1:8123'));
  const reader = createClickHouseReader(transport, captureLogger().logger);
  await assert.rejects(() => reader.latestDiagnosis(INCIDENT_ID), ClickHouseUnavailable);
  await assert.rejects(() => reader.latestDiagnoses([INCIDENT_ID]), ClickHouseUnavailable);
});

test('a ClickHouse rejection on an existing incident query is still ClickHouseUnavailable', async () => {
  const rejected = new ClickHouseError({ message: 'Table does not exist', code: '60', type: 'UNKNOWN_TABLE' });
  const { transport } = fakeTransport([], rejected);
  await assert.rejects(() => createClickHouseReader(transport, captureLogger().logger).getIncident(INCIDENT_ID), ClickHouseUnavailable);
});
