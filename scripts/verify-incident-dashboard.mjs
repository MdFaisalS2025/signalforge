// Acceptance check for the incident dashboard (docs/specs/2026-10-06-incident-dashboard.md, section 8.3).
// Run it against the running Compose stack after a faulty deployment has produced an incident:
//
//   node scripts/verify-incident-dashboard.mjs [--expected-traces <id>,<id>,<id>]
//
// It is read-only. It never creates deployments, sends orders, writes to ClickHouse, publishes to Kafka, or
// writes files. The two inserts in step 7 are attempts that the read-only account must reject. Every request has a
// deadline and the whole run has a 60-second deadline. Child processes use argument arrays and no shell. It
// prints one line per step and never prints credentials, SQL, or driver error text.
//
// DASHBOARD_BASE_URL overrides the default base URL. It exists so tests and local debugging can point the script at a
// stand-in server; the default is the Compose dashboard.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_BASE_URL = 'http://localhost:3000';
export const REQUEST_TIMEOUT_MS = 5_000;
export const OVERALL_DEADLINE_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'docker', 'docker-compose.yml');
// The local-only reader account from infra/clickhouse/users.d/dashboard-reader.xml. It is never printed.
const READER = 'dashboard_reader';
const READER_PASSWORD = 'changeme-local-only';

export const STEPS = Object.freeze([
  { n: 1, id: 'health', name: 'health returns 200' },
  { n: 2, id: 'incidents-listed', name: 'incidents listed, newest first' },
  { n: 3, id: 'evidence-four', name: 'newest incident has one deployment and three high-reliability traces' },
  { n: 4, id: 'trace-ids', name: 'evidence trace IDs match the expected IDs' },
  { n: 5, id: 'deployment-faulty', name: 'linked deployment is faulty and lists the incident' },
  { n: 6, id: 'non-get-405', name: 'POST, PUT, PATCH, DELETE are refused with 405' },
  { n: 7, id: 'reader-readonly', name: 'dashboard reader can select and cannot insert' },
  { n: 8, id: 'page-renders', name: 'incidents page renders the newest title' },
  { n: 9, id: 'no-leaks', name: 'no response leaks SELECT or Code:' },
]);

// ---- HTTP with deadlines ----------------------------------------------------------------------------------------

export function createContext({
  baseUrl = DEFAULT_BASE_URL,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  overallDeadlineMs = OVERALL_DEADLINE_MS,
} = {}) {
  return { baseUrl, requestTimeoutMs, signal: AbortSignal.timeout(overallDeadlineMs), bodies: [] };
}

// One request, cut off at the per-request deadline or the overall deadline, whichever comes first. Failures carry
// fixed wording only. The body is kept for the leak scan in step 9.
export async function requestWithDeadline(ctx, requestPath, { method = 'GET' } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(ctx.requestTimeoutMs), ctx.signal]);
  try {
    const response = await fetch(new URL(requestPath, ctx.baseUrl), { method, signal, redirect: 'manual' });
    const text = await response.text();
    ctx.bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('deadline exceeded');
    throw new Error('request failed');
  }
}

// ---- Pure helpers -----------------------------------------------------------------------------------------------

// Returns the first forbidden token found in a body, or null. SELECT is SQL text. "Code:" is the ClickHouse error prefix.
export function scanBody(text) {
  for (const token of ['SELECT', 'Code:']) {
    if (text.includes(token)) return token;
  }
  return null;
}

// Exact multiset comparison of trace IDs. A duplicate or an extra ID is a difference.
export function compareTraceIds(expected, actual) {
  const count = (ids) => ids.reduce((map, id) => map.set(id, (map.get(id) ?? 0) + 1), new Map());
  const want = count(expected);
  const have = count(actual);
  const missing = [];
  const extra = [];
  for (const [id, n] of want) for (let i = have.get(id) ?? 0; i < n; i += 1) missing.push(id);
  for (const [id, n] of have) for (let i = want.get(id) ?? 0; i < n; i += 1) extra.push(id);
  return { equal: missing.length === 0 && extra.length === 0, missing, extra };
}

// Step 7. The reader must be able to select, and both inserts must be rejected specifically as READONLY. A
// rejection for any other reason, such as a missing account, is not proof. The detail never includes driver text.
export function evaluateReaderProbe(probe) {
  if (probe.select.code !== 0 || !/^\d+$/.test(probe.select.stdout.trim())) {
    return { ok: false, detail: 'the reader could not select from incidents' };
  }
  for (const [name, attempt] of [['incidents', probe.insertIncidents], ['deployments', probe.insertDeployments]]) {
    if (attempt.code === 0) return { ok: false, detail: `insert into ${name} was accepted` };
    if (!/READONLY|readonly/.test(attempt.stderr)) {
      return { ok: false, detail: `insert into ${name} was not rejected with READONLY` };
    }
  }
  return { ok: true, detail: 'select works; inserts into incidents and deployments are rejected with READONLY' };
}

// Step 6. Each non-GET method must return 405 with Allow: GET.
export async function checkNonGetMethods(ctx) {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await requestWithDeadline(ctx, '/api/incidents', { method });
    if (response.status !== 405) return { ok: false, detail: `${method} returned ${response.status}, expected 405` };
    if (response.headers.get('allow') !== 'GET') return { ok: false, detail: `${method} response lacks Allow: GET` };
  }
  return { ok: true, detail: 'POST, PUT, PATCH, DELETE each returned 405 with Allow: GET' };
}

// ---- The reader probe (bounded subprocess, argument arrays) ----------------------------------------------------

async function runClickhouse(queryArgs, signal) {
  const args = ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'clickhouse', 'clickhouse-client',
    '--user', READER, '--password', READER_PASSWORD, ...queryArgs];
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, signal });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

export async function dockerReaderProbe(signal) {
  return {
    select: await runClickhouse(['--query', 'SELECT count() FROM signalforge.incidents'], signal),
    insertIncidents: await runClickhouse(
      ['--query', 'INSERT INTO signalforge.incidents (incident_id) VALUES (generateUUIDv4())'], signal),
    insertDeployments: await runClickhouse(
      ['--query', 'INSERT INTO signalforge.deployments (deployment_id) VALUES (generateUUIDv4())'], signal),
  };
}

// ---- The nine steps ----------------------------------------------------------------------------------------------

const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const notRun = (step) => fail(`not run: needs step ${step}`);

const IMPLEMENTATIONS = {
  async health(ctx) {
    const response = await requestWithDeadline(ctx, '/api/health');
    return response.status === 200 && response.json?.status === 'ok'
      ? pass('GET /api/health returned 200')
      : fail(`GET /api/health returned ${response.status}`);
  },

  async 'incidents-listed'(ctx, state) {
    const response = await requestWithDeadline(ctx, '/api/incidents?limit=20');
    if (response.status !== 200 || !Array.isArray(response.json?.incidents)) {
      return fail(`GET /api/incidents returned ${response.status}`);
    }
    const incidents = response.json.incidents;
    if (incidents.length === 0) return fail('no incidents returned; create one with the demo flow first');
    for (let i = 1; i < incidents.length; i += 1) {
      if (incidents[i - 1].detected_at < incidents[i].detected_at) return fail('incidents are not newest first');
    }
    state.newest = incidents[0];
    return pass(`${incidents.length} incidents, newest ${incidents[0].incident_id}`);
  },

  async 'evidence-four'(ctx, state) {
    if (!state.newest) return notRun(2);
    const response = await requestWithDeadline(ctx, `/api/incidents/${state.newest.incident_id}`);
    const evidence = response.json?.evidence;
    if (response.status !== 200 || !Array.isArray(evidence)) return fail(`incident detail returned ${response.status}`);
    const deployments = evidence.filter((row) => row.source_type === 'deployment').length;
    const traces = evidence.filter((row) => row.source_type === 'trace');
    if (evidence.length !== 4 || deployments !== 1 || traces.length !== 3) {
      return fail(`expected 1 deployment and 3 trace evidence rows, got ${deployments} and ${traces.length} of ${evidence.length}`);
    }
    if (!evidence.every((row) => row.reliability === 'high')) return fail('not every evidence row has reliability high');
    state.traceIds = traces.map((row) => row.source_ref);
    return pass('1 deployment and 3 trace evidence rows, all high reliability');
  },

  async 'trace-ids'(ctx, state, { expectedTraceIds }) {
    if (expectedTraceIds === undefined) return { status: 'skip', detail: 'no expected IDs supplied; step 3 is the check' };
    if (!state.traceIds) return notRun(3);
    const { equal, missing, extra } = compareTraceIds(expectedTraceIds, state.traceIds);
    return equal
      ? pass('evidence trace IDs equal the expected IDs')
      : fail(`trace IDs differ: ${missing.length} missing, ${extra.length} extra`);
  },

  async 'deployment-faulty'(ctx, state) {
    if (!state.newest) return notRun(2);
    const response = await requestWithDeadline(ctx, '/api/deployments?limit=50');
    if (response.status !== 200 || !Array.isArray(response.json?.deployments)) {
      return fail(`GET /api/deployments returned ${response.status}`);
    }
    const linked = response.json.deployments.find((item) => item.deployment_id === state.newest.deployment_id);
    if (!linked) return fail('the incident deployment is not on the deployment timeline');
    if (linked.class !== 'faulty') return fail(`the incident deployment is classed ${linked.class}, not faulty`);
    if (!linked.incident_ids.includes(state.newest.incident_id)) return fail('the deployment does not list the incident');
    return pass('the incident deployment is faulty and lists the incident');
  },

  async 'non-get-405'(ctx) {
    const outcome = await checkNonGetMethods(ctx);
    return outcome.ok ? pass(outcome.detail) : fail(outcome.detail);
  },

  async 'reader-readonly'(ctx, state, { readerProbe }) {
    const outcome = evaluateReaderProbe(await readerProbe(ctx.signal));
    return outcome.ok ? pass(outcome.detail) : fail(outcome.detail);
  },

  async 'page-renders'(ctx, state) {
    if (!state.newest) return notRun(2);
    const response = await requestWithDeadline(ctx, '/incidents');
    if (response.status !== 200) return fail(`GET /incidents returned ${response.status}`);
    return response.text.includes(state.newest.title)
      ? pass('GET /incidents returned 200 and shows the newest incident title')
      : fail('the incidents page does not show the newest incident title');
  },

  async 'no-leaks'(ctx) {
    for (const body of ctx.bodies) {
      const token = scanBody(body);
      if (token) return fail(`a response body contains "${token}"`);
    }
    return pass(`${ctx.bodies.length} response bodies contain no SQL or driver codes`);
  },
};

function describeFailure(error) {
  return error instanceof Error && ['deadline exceeded', 'request failed'].includes(error.message)
    ? error.message
    : 'unexpected error';
}

// Runs all nine steps in order. A step that cannot run because an earlier one failed is reported as a failure, not
// skipped. Only step 4, when no expected IDs were supplied, may be skipped.
export async function runAcceptance({
  baseUrl = process.env.DASHBOARD_BASE_URL ?? DEFAULT_BASE_URL,
  expectedTraceIds,
  readerProbe = dockerReaderProbe,
  requestTimeoutMs,
  overallDeadlineMs,
} = {}) {
  const ctx = createContext({ baseUrl, requestTimeoutMs, overallDeadlineMs });
  const state = {};
  const steps = [];
  for (const step of STEPS) {
    let outcome;
    if (ctx.signal.aborted && step.id !== 'no-leaks') {
      outcome = fail('deadline exceeded');
    } else {
      try {
        outcome = await IMPLEMENTATIONS[step.id](ctx, state, { expectedTraceIds, readerProbe });
      } catch (error) {
        outcome = fail(describeFailure(error));
      }
    }
    steps.push({ ...step, ...outcome });
  }
  return { ok: steps.every((step) => step.status !== 'fail'), steps };
}

// ---- Command line -----------------------------------------------------------------------------------------------

function formatStep(step) {
  return `${step.status.toUpperCase().padEnd(4)} ${step.n} ${step.name}: ${step.detail}`;
}

async function main() {
  const { values } = parseArgs({ options: { 'expected-traces': { type: 'string' } } });
  const expectedTraceIds = values['expected-traces']
    ? values['expected-traces'].split(',').map((id) => id.trim()).filter(Boolean)
    : undefined;
  const result = await runAcceptance({ expectedTraceIds });
  for (const step of result.steps) console.log(formatStep(step));
  console.log(result.ok ? 'PASS' : 'FAIL');
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log('FAIL unexpected error');
    process.exitCode = 1;
  });
}
