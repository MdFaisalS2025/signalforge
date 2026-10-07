// Tests for the incident dashboard acceptance script and for the dashboard's read-only ClickHouse account.
//
// Part 1 tests the script's helpers with in-process HTTP stubs. It needs no Docker and no ClickHouse. The stubs
// stand in for the dashboard through the script's base-URL parameter (the script reads DASHBOARD_BASE_URL, which
// exists only so tests and local debugging can point it elsewhere).
//
// Part 2 checks the reader account against the Compose ClickHouse service. It starts nothing; it waits, with a
// bound, for ClickHouse to answer. Every child process uses an argument array and no shell.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  STEPS,
  REQUEST_TIMEOUT_MS,
  OVERALL_DEADLINE_MS,
  DEFAULT_BASE_URL,
  scanBody,
  compareTraceIds,
  evaluateReaderProbe,
  createContext,
  requestWithDeadline,
  checkNonGetMethods,
  runAcceptance,
} from './verify-incident-dashboard.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Part 1: acceptance script helpers

const INCIDENT_NEW = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const INCIDENT_OLD = '64d254ef-85a6-51ef-b4ab-80bc16c71baa';
const DEPLOYMENT = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';
const TRACES = ['70c13b1f8287d5205b842d532c6f09ea', '4955662a3ed95b514cd85676abb329b3', 'e1b78f9d0c507fd45879576baf849ff7'];
const TITLE = `Payments 5xx burst after deployment ${DEPLOYMENT}`;

const readerOk = async () => ({
  select: { code: 0, stdout: '48\n' },
  insertIncidents: { code: 164, stderr: 'Code: 164. DB::Exception: dashboard_reader: Cannot execute query in readonly mode. (READONLY)' },
  insertDeployments: { code: 164, stderr: 'Code: 164. DB::Exception: dashboard_reader: Cannot execute query in readonly mode. (READONLY)' },
});

function incident(id, detectedAt) {
  return { incident_id: id, title: TITLE, deployment_id: DEPLOYMENT, detected_at: detectedAt };
}

function goodState() {
  return {
    health: [200, { status: 'ok' }],
    incidents: [incident(INCIDENT_NEW, '2026-10-06T14:00:00.000000000Z'), incident(INCIDENT_OLD, '2026-10-06T13:00:00.000000000Z')],
    evidence: [
      { source_type: 'deployment', source_ref: DEPLOYMENT, reliability: 'high' },
      ...TRACES.map((ref) => ({ source_type: 'trace', source_ref: ref, reliability: 'high' })),
    ],
    deployments: [{ deployment_id: DEPLOYMENT, class: 'faulty', incident_ids: [INCIDENT_NEW] }],
    nonGet: () => ({ status: 405, headers: { Allow: 'GET' }, body: '{"error":"method_not_allowed"}' }),
    page: `<html><body><h1>Incidents</h1><a>${TITLE}</a></body></html>`,
  };
}

// An in-process stand-in for the dashboard. It serves the routes the script reads, from a mutable state object.
async function startStub(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/api/incidents' && req.method !== 'GET') {
      const reply = state.nonGet(req.method);
      return send(reply.status, reply.body, reply.headers);
    }
    if (url.pathname === '/api/health') return send(...state.health);
    if (url.pathname === '/api/incidents') return send(200, { incidents: state.incidents });
    if (url.pathname.startsWith('/api/incidents/')) {
      const id = url.pathname.split('/').pop();
      const found = state.incidents.find((item) => item.incident_id === id);
      return found ? send(200, { incident: found, evidence: state.evidence }) : send(404, { error: 'incident_not_found' });
    }
    if (url.pathname === '/api/deployments') return send(200, { deployments: state.deployments });
    if (url.pathname === '/incidents') return send(200, state.page, { 'content-type': 'text/html' });
    return send(404, { error: 'nope' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withStub(state, run) {
  const stub = await startStub(state);
  try {
    return await run(stub.baseUrl);
  } finally {
    await stub.close();
  }
}

const accept = (baseUrl, extra = {}) => runAcceptance({ baseUrl, readerProbe: readerOk, ...extra });
const stepOf = (result, id) => result.steps.find((step) => step.id === id);

test('the step list has all nine spec section 8.3 checks, in order', () => {
  assert.deepEqual(
    STEPS.map((step) => [step.n, step.id]),
    [
      [1, 'health'],
      [2, 'incidents-listed'],
      [3, 'evidence-four'],
      [4, 'trace-ids'],
      [5, 'deployment-faulty'],
      [6, 'non-get-405'],
      [7, 'reader-readonly'],
      [8, 'page-renders'],
      [9, 'no-leaks'],
    ],
  );
});

test('every request has a deadline, and the whole run has a 60-second deadline', () => {
  assert.equal(OVERALL_DEADLINE_MS, 60_000);
  assert.equal(REQUEST_TIMEOUT_MS, 5_000);
  assert.ok(REQUEST_TIMEOUT_MS < OVERALL_DEADLINE_MS);
  assert.equal(DEFAULT_BASE_URL, 'http://localhost:3000');
});

test('a request that gets no answer is cut off at its deadline', async () => {
  const hang = http.createServer(() => {});
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  const ctx = createContext({ baseUrl: `http://127.0.0.1:${hang.address().port}`, requestTimeoutMs: 250, overallDeadlineMs: 30_000 });
  const started = Date.now();
  try {
    await assert.rejects(() => requestWithDeadline(ctx, '/api/health'), /deadline/);
    assert.ok(Date.now() - started < 3_000, 'the request outlived its deadline');
  } finally {
    hang.closeAllConnections();
    await new Promise((resolve) => hang.close(resolve));
  }
});

test('the whole run stops at its overall deadline and reports it as a failure', async () => {
  const hang = http.createServer(() => {});
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  try {
    const result = await accept(`http://127.0.0.1:${hang.address().port}`, { overallDeadlineMs: 400, requestTimeoutMs: 5_000 });
    assert.equal(result.ok, false);
    assert.match(stepOf(result, 'health').detail, /deadline/);
    assert.ok(Date.now() - started < 5_000, 'the run outlived its overall deadline');
  } finally {
    hang.closeAllConnections();
    await new Promise((resolve) => hang.close(resolve));
  }
});

test('POST, PUT, PATCH, and DELETE must each return 405 with Allow: GET', async () => {
  await withStub(goodState(), async (baseUrl) => {
    const outcome = await checkNonGetMethods(createContext({ baseUrl }));
    assert.equal(outcome.ok, true);
  });
});

test('a method that is not refused is named in the failure', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const state = goodState();
    state.nonGet = (m) => (m === method ? { status: 200, headers: {}, body: '{}' } : { status: 405, headers: { Allow: 'GET' }, body: '{}' });
    await withStub(state, async (baseUrl) => {
      const outcome = await checkNonGetMethods(createContext({ baseUrl }));
      assert.equal(outcome.ok, false);
      assert.match(outcome.detail, new RegExp(method));
    });
  }
});

test('a 405 without Allow: GET is a failure', async () => {
  const state = goodState();
  state.nonGet = () => ({ status: 405, headers: {}, body: '{}' });
  await withStub(state, async (baseUrl) => {
    const outcome = await checkNonGetMethods(createContext({ baseUrl }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /Allow/);
  });
});

test('the response scanner rejects SELECT and Code:, and accepts clean bodies', () => {
  assert.equal(scanBody('{"error":"clickhouse_unavailable"}'), null);
  assert.equal(scanBody('<html>Incidents</html>'), null);
  assert.equal(scanBody('boom SELECT count() FROM incidents'), 'SELECT');
  assert.equal(scanBody('Code: 62. DB::Exception'), 'Code:');
});

test('expected trace IDs must equal the evidence trace IDs exactly', () => {
  assert.deepEqual(compareTraceIds(TRACES, [...TRACES].reverse()), { equal: true, missing: [], extra: [] });
  assert.equal(compareTraceIds(TRACES, TRACES.slice(0, 2)).equal, false);
  assert.deepEqual(compareTraceIds(TRACES, TRACES.slice(0, 2)).missing, [TRACES[2]]);
  assert.deepEqual(compareTraceIds(TRACES.slice(0, 2), TRACES).extra, [TRACES[2]]);
  assert.equal(compareTraceIds(TRACES, [TRACES[0], TRACES[0], TRACES[1]]).equal, false, 'duplicates must not match');
});

test('supplied expected trace IDs are compared with the newest incident, and a mismatch fails step 4', async () => {
  await withStub(goodState(), async (baseUrl) => {
    const good = await accept(baseUrl, { expectedTraceIds: TRACES });
    assert.equal(stepOf(good, 'trace-ids').status, 'pass');
    const bad = await accept(baseUrl, { expectedTraceIds: [TRACES[0], TRACES[1], '00000000000000000000000000000000'] });
    assert.equal(bad.ok, false);
    assert.equal(stepOf(bad, 'trace-ids').status, 'fail');
    assert.match(stepOf(bad, 'trace-ids').detail, /missing|extra/);
  });
});

test('without expected trace IDs, step 4 is skipped and step 3 is the check', async () => {
  await withStub(goodState(), async (baseUrl) => {
    const result = await accept(baseUrl);
    assert.equal(stepOf(result, 'trace-ids').status, 'skip');
    assert.equal(result.ok, true, 'a skipped optional step must not fail the run');
  });
});

test('a zero-incident dashboard fails with a named step, never a false pass', async () => {
  const state = goodState();
  state.incidents = [];
  await withStub(state, async (baseUrl) => {
    const result = await accept(baseUrl);
    assert.equal(result.ok, false);
    assert.equal(stepOf(result, 'incidents-listed').status, 'fail');
    assert.match(stepOf(result, 'incidents-listed').detail, /no incidents/);
    for (const id of ['evidence-four', 'deployment-faulty', 'page-renders']) {
      assert.equal(stepOf(result, id).status, 'fail', `${id} must not pass without an incident`);
      assert.match(stepOf(result, id).detail, /not run/);
    }
  });
});

test('a fully correct dashboard passes all nine steps', async () => {
  await withStub(goodState(), async (baseUrl) => {
    const result = await accept(baseUrl, { expectedTraceIds: TRACES });
    assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => s.status === 'fail')));
    assert.deepEqual(result.steps.map((s) => s.status), Array(9).fill('pass'));
  });
});

test('an incident list that is not newest-first fails step 2', async () => {
  const state = goodState();
  state.incidents.reverse();
  await withStub(state, async (baseUrl) => {
    const result = await accept(baseUrl);
    assert.equal(stepOf(result, 'incidents-listed').status, 'fail');
    assert.match(stepOf(result, 'incidents-listed').detail, /newest/);
  });
});

test('evidence that is not one deployment plus three high-reliability traces fails step 3', async () => {
  const variants = {
    'three rows': (rows) => rows.slice(0, 3),
    'two deployments': (rows) => [rows[0], rows[0], rows[1], rows[2]],
    'low reliability': (rows) => rows.map((row, i) => (i === 2 ? { ...row, reliability: 'low' } : row)),
  };
  for (const [name, change] of Object.entries(variants)) {
    const state = goodState();
    state.evidence = change(state.evidence);
    await withStub(state, async (baseUrl) => {
      assert.equal(stepOf(await accept(baseUrl), 'evidence-four').status, 'fail', name);
    });
  }
});

test('a linked deployment that is not faulty, or does not list the incident, fails step 5', async () => {
  for (const change of [{ class: 'healthy' }, { incident_ids: [] }]) {
    const state = goodState();
    state.deployments = [{ ...state.deployments[0], ...change }];
    await withStub(state, async (baseUrl) => {
      assert.equal(stepOf(await accept(baseUrl), 'deployment-faulty').status, 'fail');
    });
  }
});

test('a page that lacks the incident title fails step 8', async () => {
  const state = goodState();
  state.page = '<html><body>Incidents</body></html>';
  await withStub(state, async (baseUrl) => {
    assert.equal(stepOf(await accept(baseUrl), 'page-renders').status, 'fail');
  });
});

test('a leaked SELECT or Code: in any inspected body fails step 9', async () => {
  for (const leak of ['SELECT count() FROM incidents', 'Code: 62. DB::Exception']) {
    const state = goodState();
    state.nonGet = () => ({ status: 405, headers: { Allow: 'GET' }, body: JSON.stringify({ error: leak }) });
    await withStub(state, async (baseUrl) => {
      const result = await accept(baseUrl);
      assert.equal(stepOf(result, 'no-leaks').status, 'fail');
      assert.ok(!stepOf(result, 'no-leaks').detail.includes('count()'), 'the leaked text must not be echoed');
    });
  }
});

test('the reader probe passes only for a working SELECT and two READONLY rejections', () => {
  const rejected = { code: 164, stderr: 'Cannot execute query in readonly mode. (READONLY)' };
  assert.equal(evaluateReaderProbe({ select: { code: 0, stdout: '48' }, insertIncidents: rejected, insertDeployments: rejected }).ok, true);
  assert.equal(evaluateReaderProbe({ select: { code: 1, stdout: '' }, insertIncidents: rejected, insertDeployments: rejected }).ok, false);
  assert.equal(evaluateReaderProbe({ select: { code: 0, stdout: '48' }, insertIncidents: { code: 0, stderr: '' }, insertDeployments: rejected }).ok, false);
  const auth = { code: 516, stderr: 'Authentication failed (AUTHENTICATION_FAILED)' };
  const authFailure = evaluateReaderProbe({ select: { code: 0, stdout: '48' }, insertIncidents: auth, insertDeployments: rejected });
  assert.equal(authFailure.ok, false, 'a non-READONLY rejection is not proof of read-only access');
  assert.ok(!authFailure.detail.includes('Authentication failed'), 'driver text must not be echoed');
});

test('a failing reader probe fails step 7 without printing driver output', async () => {
  const probe = async () => ({
    select: { code: 0, stdout: '48' },
    insertIncidents: { code: 0, stderr: 'secret-driver-text' },
    insertDeployments: { code: 164, stderr: 'READONLY' },
  });
  await withStub(goodState(), async (baseUrl) => {
    const result = await runAcceptance({ baseUrl, readerProbe: probe });
    assert.equal(stepOf(result, 'reader-readonly').status, 'fail');
    assert.ok(!stepOf(result, 'reader-readonly').detail.includes('secret-driver-text'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Part 2: the read-only ClickHouse account (needs the Compose ClickHouse service)

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

describe('dashboard_reader account (needs ClickHouse)', () => {
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

  // The reader is scoped to signalforge. The probe reads system.query_log, a table that holds data and is not
  // filtered by database scope. Verified on the running stack: the server answers with ACCESS_DENIED (code 497).
  // The probe writes nothing. A nonzero exit alone is not enough, because a bad password would also exit nonzero,
  // so the rejection must name a privilege error.
  test('dashboard_reader is denied a read of system.query_log', async () => {
    const result = await clickhouse(READER, READER_PASSWORD, ['--query', 'SELECT count() FROM system.query_log']);
    assert.notEqual(result.code, 0, `read of system.query_log was allowed for ${READER}: ${result.stdout.trim()}`);
    assert.match(result.stderr, /ACCESS_DENIED|Not enough privileges/,
      `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  // system.tables is readable, but only for the account's own databases. Any row outside signalforge is a scope leak.
  test('dashboard_reader sees no catalog entries outside signalforge', async () => {
    const result = await clickhouse(READER, READER_PASSWORD,
      ['--query', "SELECT count() FROM system.tables WHERE database != 'signalforge'"]);
    assert.equal(result.code, 0, `catalog read failed: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), '0', `catalog exposes ${result.stdout.trim()} entries outside signalforge`);
  });

  test('dashboard_reader cannot insert into deployments', async () => {
    const result = await clickhouse(READER, READER_PASSWORD,
      ['--query', 'INSERT INTO signalforge.deployments (deployment_id) VALUES (generateUUIDv4())']);
    assert.notEqual(result.code, 0, 'INSERT into deployments was accepted for the read-only account');
    assert.match(result.stderr, /READONLY|readonly/, `expected a read-only rejection, got: ${result.stderr.trim()}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Part 3: the dashboard is unauthenticated, so Compose must publish it on the loopback interface only.
// This reads the resolved Compose model (no containers are started) and is bounded by a timeout.

const COMPOSE_CONFIG_TIMEOUT_MS = 30_000;

async function resolvedWebPorts() {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', 'infra/docker/docker-compose.yml', 'config', '--format', 'json'],
    { timeout: COMPOSE_CONFIG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout).services.web.ports;
}

test('the resolved Compose config publishes web port 3000 on 127.0.0.1 only', { timeout: COMPOSE_CONFIG_TIMEOUT_MS + 5_000 }, async () => {
  const ports = await resolvedWebPorts();
  const published = ports.filter((port) => Number(port.target) === 3000);
  assert.equal(published.length, 1, 'web must publish container port 3000 exactly once');
  assert.equal(published[0].host_ip, '127.0.0.1', 'the unauthenticated dashboard must bind to loopback, not all interfaces');
  assert.equal(String(published[0].published), '3000');
  assert.equal(ports.length, 1, 'web must publish no other port');
});
