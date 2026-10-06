// Checks for the incident dashboard's read-only ClickHouse account. The dashboard must be able to read the
// signalforge tables and must not be able to write to them. These checks run against the Compose ClickHouse
// service and need it running. The test starts nothing; it waits, with a bound, for ClickHouse to answer.
// Every child process uses an argument array and no shell.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMPOSE_FILE = 'infra/docker/docker-compose.yml';
const READER = 'dashboard_reader';
const READER_PASSWORD = 'changeme-local-only';
const ADMIN_PASSWORD = 'changeme-local-only';
const READY_DEADLINE_MS = 120_000;
const READY_POLL_MS = 2_000;

// Runs clickhouse-client inside the running clickhouse service and returns its exit code and output.
async function clickhouse(user, password, queryArgs) {
  const args = ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'clickhouse', 'clickhouse-client',
    '--user', user, '--password', password, ...queryArgs];
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 30_000, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  }
}

// Waits until the default account answers SELECT 1. Bounded: fails with the last error if ClickHouse never answers.
async function waitForClickHouse() {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let last = { stderr: 'no attempt made' };
  while (Date.now() < deadline) {
    last = await clickhouse('default', ADMIN_PASSWORD, ['--query', 'SELECT 1']);
    if (last.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  assert.fail(`ClickHouse did not answer within ${READY_DEADLINE_MS}ms. Last error: ${last.stderr.trim()}`);
}

before(waitForClickHouse, { timeout: READY_DEADLINE_MS + 30_000 });

test('dashboard_reader can read the incidents table', async () => {
  const result = await clickhouse(READER, READER_PASSWORD, ['--query', 'SELECT count() FROM signalforge.incidents']);
  assert.equal(result.code, 0, `SELECT as ${READER} failed: ${result.stderr.trim()}`);
  assert.match(result.stdout.trim(), /^\d+$/, `expected a count, got: ${result.stdout.trim()}`);
});

// Both writes must be rejected by the readonly profile. The reader's error must name the read-only restriction,
// not an authentication failure, so a missing account cannot pass this check.
test('dashboard_reader cannot insert into incidents', async () => {
  const result = await clickhouse(READER, READER_PASSWORD,
    ['--query', 'INSERT INTO signalforge.incidents (incident_id) VALUES (generateUUIDv4())']);
  assert.notEqual(result.code, 0, 'INSERT into incidents was accepted for the read-only account');
  assert.match(result.stderr, /READONLY|readonly/, `expected a read-only rejection, got: ${result.stderr.trim()}`);
});

test('dashboard_reader cannot insert into deployments', async () => {
  const result = await clickhouse(READER, READER_PASSWORD,
    ['--query', 'INSERT INTO signalforge.deployments (deployment_id) VALUES (generateUUIDv4())']);
  assert.notEqual(result.code, 0, 'INSERT into deployments was accepted for the read-only account');
  assert.match(result.stderr, /READONLY|readonly/, `expected a read-only rejection, got: ${result.stderr.trim()}`);
});
