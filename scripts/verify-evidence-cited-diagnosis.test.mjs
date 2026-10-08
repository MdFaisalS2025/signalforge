// Tests for the evidence-cited diagnosis slice's ClickHouse accounts (docs/specs/2026-10-07-evidence-cited-diagnosis.md,
// sections 8.1 and 8.5).
//
// These check the Compose ClickHouse service. They start nothing: they wait, with a bound, for ClickHouse to answer.
// Every child process uses an argument array and no shell. The denied-insert probes insert zero rows (`WHERE 0`), so
// even an over-privileged account could not write data through them: privileges are checked before any row exists.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = 'infra/docker/docker-compose.yml';
const AGENT = 'agent_writer';
const READER = 'dashboard_reader';
const PASSWORD = 'changeme-local-only'; // the existing local-only convention
const ADMIN = 'default';
const READY_DEADLINE_MS = 120_000;
const READY_POLL_MS = 2_000;
const CALL_TIMEOUT_MS = 30_000;

const DENIED = /ACCESS_DENIED|Not enough privileges/;

// Runs clickhouse-client inside the running clickhouse service and returns its exit code and output.
async function clickhouse(user, password, queryArgs) {
  const args = ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'clickhouse', 'clickhouse-client',
    '--user', user, '--password', password, ...queryArgs];
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { cwd: REPO, timeout: CALL_TIMEOUT_MS, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  }
}

const asAgent = (sql) => clickhouse(AGENT, PASSWORD, ['--query', sql]);
const asReader = (sql) => clickhouse(READER, PASSWORD, ['--query', sql]);
const asAdmin = (sql) => clickhouse(ADMIN, PASSWORD, ['--query', sql]);

// Waits until the default account answers SELECT 1. Bounded: fails with the last error if ClickHouse never answers.
// It does not wait for migration 2, so a missing account or table fails the tests with its own error.
async function waitForClickHouse() {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let last = { stderr: 'no attempt made' };
  while (Date.now() < deadline) {
    last = await asAdmin('SELECT 1');
    if (last.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  assert.fail(`ClickHouse did not answer within ${READY_DEADLINE_MS}ms. Last error: ${last.stderr.trim()}`);
}

describe('agent_writer account (needs ClickHouse)', () => {
  before(waitForClickHouse, { timeout: READY_DEADLINE_MS + 30_000 });

  // ---- Allowed ----

  test('agent_writer can read the incidents table', async () => {
    const result = await asAgent('SELECT count() FROM signalforge.incidents');
    assert.equal(result.code, 0, `SELECT as ${AGENT} failed: ${result.stderr.trim()}`);
    assert.match(result.stdout.trim(), /^\d+$/, `expected a count, got: ${result.stdout.trim()}`);
  });

  test('agent_writer can read telemetry_events', async () => {
    const result = await asAgent('SELECT count() FROM signalforge.telemetry_events');
    assert.equal(result.code, 0, `SELECT as ${AGENT} failed: ${result.stderr.trim()}`);
    assert.match(result.stdout.trim(), /^\d+$/);
  });

  test('agent_writer can read every table the agent needs: evidence_items, deployments, and diagnoses', async () => {
    for (const table of ['evidence_items', 'deployments', 'diagnoses']) {
      const result = await asAgent(`SELECT count() FROM signalforge.${table}`);
      assert.equal(result.code, 0, `SELECT from ${table} as ${AGENT} failed: ${result.stderr.trim()}`);
      assert.match(result.stdout.trim(), /^\d+$/, table);
    }
  });

  test('agent_writer can insert into diagnoses (a zero-row write is accepted)', async () => {
    const result = await asAgent('INSERT INTO signalforge.diagnoses (diagnosis_id) SELECT generateUUIDv4() WHERE 0');
    assert.equal(result.code, 0, `INSERT into diagnoses as ${AGENT} failed: ${result.stderr.trim()}`);
  });

  // ---- Denied: every other write, DDL, and system read ----

  for (const table of ['incidents', 'evidence_items', 'deployments']) {
    const column = table === 'incidents' ? 'incident_id' : table === 'evidence_items' ? 'evidence_id' : 'deployment_id';
    test(`agent_writer cannot insert into ${table}`, async () => {
      const result = await asAgent(`INSERT INTO signalforge.${table} (${column}) SELECT generateUUIDv4() WHERE 0`);
      assert.notEqual(result.code, 0, `INSERT into ${table} was accepted for ${AGENT}`);
      assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
    });
  }

  test('agent_writer cannot insert into telemetry_events or the migration table', async () => {
    for (const [table, column] of [['telemetry_events', 'event_id'], ['schema_migrations', 'version']]) {
      const value = column === 'version' ? 'toUInt32(99)' : 'generateUUIDv4()';
      const result = await asAgent(`INSERT INTO signalforge.${table} (${column}) SELECT ${value} WHERE 0`);
      assert.notEqual(result.code, 0, `INSERT into ${table} was accepted for ${AGENT}`);
      assert.match(result.stderr, DENIED, `${table}: ${result.stderr.trim()}`);
    }
  });

  test('agent_writer cannot alter diagnoses', async () => {
    const result = await asAgent('ALTER TABLE signalforge.diagnoses ADD COLUMN x String');
    assert.notEqual(result.code, 0, `ALTER was accepted for ${AGENT}`);
    assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  test('agent_writer cannot drop diagnoses', async () => {
    const result = await asAgent('DROP TABLE signalforge.diagnoses');
    assert.notEqual(result.code, 0, `DROP was accepted for ${AGENT}`);
    assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  test('agent_writer cannot truncate, create, delete from, or grant on anything', async () => {
    const statements = [
      'TRUNCATE TABLE signalforge.diagnoses',
      'CREATE TABLE signalforge.agent_probe (x UInt8) ENGINE = Memory',
      'ALTER TABLE signalforge.diagnoses DELETE WHERE 0',
      'GRANT SELECT ON signalforge.* TO agent_writer',
      'SYSTEM FLUSH LOGS',
    ];
    for (const sql of statements) {
      const result = await asAgent(sql);
      assert.notEqual(result.code, 0, `${sql} was accepted for ${AGENT}`);
      assert.match(result.stderr, DENIED, `${sql}: ${result.stderr.trim()}`);
    }
  });

  test('agent_writer is denied a read of system.query_log', async () => {
    const result = await asAgent('SELECT * FROM system.query_log LIMIT 1');
    assert.notEqual(result.code, 0, `read of system.query_log was allowed for ${AGENT}: ${result.stdout.trim()}`);
    assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  // ---- Exactly these grants and these limits, nothing broader ----

  // access_type is an enum, so ClickHouse's ORDER BY does not sort it alphabetically. Compare exact sorted sets instead.
  test('agent_writer holds exactly the five SELECT grants and the one INSERT grant', async () => {
    const result = await asAdmin(`SELECT access_type, database, table FROM system.grants WHERE user_name = '${AGENT}' FORMAT TSV`);
    assert.equal(result.code, 0, `could not read the grants: ${result.stderr.trim()}`);
    const rows = result.stdout.trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(rows, [
      'INSERT\tsignalforge\tdiagnoses',
      'SELECT\tsignalforge\tdeployments',
      'SELECT\tsignalforge\tdiagnoses',
      'SELECT\tsignalforge\tevidence_items',
      'SELECT\tsignalforge\tincidents',
      'SELECT\tsignalforge\ttelemetry_events',
    ].sort());
    assert.equal(rows.length, 6, 'no grant beyond the six named ones');
  });

  test('agent_writer runs under a non-readonly profile with the documented limits', async () => {
    const result = await asAgent("SELECT getSetting('readonly'), getSetting('max_execution_time'), getSetting('max_rows_to_read'), getSetting('max_result_rows') FORMAT TSV");
    assert.equal(result.code, 0, `could not read the settings: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), '0\t10\t5000000\t1000');
  });

  test('agent_writer is limited to the signalforge database', async () => {
    const result = await asAgent("SELECT count() FROM system.tables WHERE database != 'signalforge'");
    assert.equal(result.code, 0, `catalog read failed: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), '0', `catalog exposes ${result.stdout.trim()} entries outside signalforge`);
  });
});

describe('dashboard_reader and the diagnoses table (needs ClickHouse)', () => {
  before(waitForClickHouse, { timeout: READY_DEADLINE_MS + 30_000 });

  test('dashboard_reader can read the diagnoses table', async () => {
    const result = await asReader('SELECT count() FROM signalforge.diagnoses');
    assert.equal(result.code, 0, `SELECT as ${READER} failed: ${result.stderr.trim()}`);
    assert.match(result.stdout.trim(), /^\d+$/, `expected a count, got: ${result.stdout.trim()}`);
  });

  // The readonly profile must reject the write by name, so a missing account or table cannot pass.
  test('dashboard_reader cannot insert into diagnoses', async () => {
    const result = await asReader('INSERT INTO signalforge.diagnoses (diagnosis_id) SELECT generateUUIDv4() WHERE 0');
    assert.notEqual(result.code, 0, 'INSERT into diagnoses was accepted for the read-only account');
    assert.match(result.stderr, /READONLY|readonly/, `expected a read-only rejection, got: ${result.stderr.trim()}`);
  });
});
