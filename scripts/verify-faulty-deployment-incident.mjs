// End-to-end acceptance check for the faulty-deployment incident path. Run it against the running Compose
// stack. It deploys faulty payments versions, sends orders, and checks ClickHouse, Kafka, and collector-go
// logs. Every wait is bounded. Every child process uses an argument array with windowsHide, never a shell.
// Cleanup never removes volumes.

import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { consumeBounded } from './rpk-consume-bounded.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'docker', 'docker-compose.yml');
const COLLECTOR = 'collector-go';
const COLLECTOR_CONTAINER = 'signalforge-collector-go-1';
const ORDERS_URL = 'http://localhost:8081/orders';
const TRIGGER_RULE = 'payments-5xx-burst-after-deployment';
const INCIDENT_TOPIC = 'incidents.created.v1';
const DEAD_LETTER_TOPIC = 'telemetry.dead-letter.v1';
const RAW_TOPIC = 'telemetry.raw.v1';
const FIXTURE = path.join(REPO_ROOT, 'services', 'collector-go', 'internal', 'canonical', 'testdata', 'traces.json');
const DEPLOY_SCRIPT = path.join(SCRIPT_DIR, 'deploy-payments.mjs');
const DEAD_LETTER_REASON = 'trace_id and span_id are required for trace events';
const FAILURE_REASON = 'payment_unavailable';

const SHORT = { intervalMs: 500, timeoutMs: 30_000 };
const LONG = { intervalMs: 500, timeoutMs: 60_000 };
const CONTAINER_WAIT = { intervalMs: 1000, timeoutMs: 60_000 };

// ---- process helpers -------------------------------------------------------------------------------------

const DEFAULT_CHILD_TIMEOUT_MS = 120_000;

// pollContext carries the signal of the poll that is running a check. Any child process or HTTP request the
// check starts inherits that signal, so the deadline cancels it without threading a parameter through every call.
const pollContext = new AsyncLocalStorage();

// The time a cancelled child is given to exit after its whole process tree has been terminated.
const CLEANUP_DEADLINE_MS = 1500;

// A child that could not be confirmed as exited. It is reported, never silently abandoned.
export class ProcessCleanupError extends Error {
  constructor(command, pid, detail) {
    super(`process cleanup failed for ${command} (pid ${pid}): ${detail}`);
    this.name = 'ProcessCleanupError';
    this.pid = pid;
  }
}

// Runs one helper command (taskkill or ps) with an argument array and no shell. It is killed when deadline passes,
// so the helper's own time counts toward the cleanup budget. Resolves with code null when it was killed.
function captureWithin(command, args, deadline) {
  return new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return reject(new Error(`no cleanup time left to run ${command}`));
    const helper = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => helper.kill('SIGKILL'), remainingMs);
    helper.stdout.on('data', (chunk) => { stdout += chunk; });
    helper.stderr.on('data', (chunk) => { stderr += chunk; });
    helper.on('error', (err) => { clearTimeout(timer); reject(err); });
    helper.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Parses `ps -eo pid,ppid,stat` output. Every row must carry numeric pid and ppid, or the whole read fails.
export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    if (line.trim() === '') continue;
    const [pid, ppid, stat = ''] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(ppid ?? '')) throw new Error(`unparseable process table row: ${line.trim()}`);
    rows.push({ pid: Number(pid), ppid: Number(ppid), zombie: stat.startsWith('Z') });
  }
  return rows;
}

// Every process whose parent chain reaches root. This finds descendants that started their own process group or
// session, which a group signal misses.
export function descendantsOf(rows, root) {
  const children = new Map();
  for (const { pid, ppid } of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const pid of children.get(next) ?? []) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

async function readProcessTable(psCommand, deadline) {
  const { code, stdout, stderr } = await captureWithin(psCommand, ['-eo', 'pid,ppid,stat'], deadline);
  if (code !== 0) throw new Error(`${psCommand} exited ${code}: ${stderr.trim()}`);
  return parseProcessTable(stdout);
}

// Polls the process table until none of pids is alive (a zombie counts as gone), within deadline.
async function waitForGone(pids, psCommand, deadline) {
  for (;;) {
    const live = new Set((await readProcessTable(psCommand, deadline)).filter((row) => !row.zombie).map((row) => row.pid));
    const stillRunning = pids.find((pid) => live.has(pid));
    if (stillRunning === undefined) return;
    if (Date.now() >= deadline) throw new Error(`pid ${stillRunning} still running after kill`);
    await delay(Math.min(50, deadline - Date.now()));
  }
}

// Windows: taskkill /T ends the root and its whole parent-child tree. It must exit 0, or the root must already be
// gone. A failure, or a helper that does not finish by deadline, is an error.
async function terminateWindowsTree(child, deadline, killer) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const { code, stderr } = await captureWithin(killer.command, [...killer.args, '/PID', String(child.pid), '/T', '/F'], deadline);
  if (code !== 0) throw new Error(`taskkill exited ${code ?? 'after its deadline'}: ${stderr.trim()}`);
}

// POSIX: the tree is discovered before anything is killed, because killing a parent reparents its children and
// hides them from a parent-link walk. The root's process group is signalled as a fast path, and every discovered
// process is signalled too, so a descendant that left the group is still terminated. Closure is then confirmed.
async function terminatePosixTree(child, deadline, psCommand) {
  const table = await readProcessTable(psCommand, deadline);
  const targets = [child.pid, ...descendantsOf(table, child.pid)];
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }
  await waitForGone(targets, psCommand, deadline);
}

// terminateTree ends a cancelled child and every descendant before deadline. The cleanup options name the helper
// commands; the defaults are the platform's own (taskkill, ps).
function terminateTree(child, deadline, cleanup) {
  if (process.platform === 'win32') {
    const { taskkill = { command: 'taskkill', args: [] } } = cleanup;
    return terminateWindowsTree(child, deadline, { args: [], ...taskkill });
  }
  return terminatePosixTree(child, deadline, cleanup.ps ?? 'ps');
}

// Resolves true if exited is settled before deadline, false otherwise.
function exitedWithin(exited, deadline) {
  return Promise.race([exited.then(() => true), delay(Math.max(0, deadline - Date.now())).then(() => false)]);
}

// Runs a command with an argument array, no shell, and a hidden window. A child that outlives timeoutMs, or whose
// signal (or the enclosing poll's signal) aborts, has its whole process tree terminated. The call resolves only
// after the direct child has exited. If it cannot be confirmed within CLEANUP_DEADLINE_MS, the call rejects with a
// ProcessCleanupError.
export function run(command, args, { env = process.env, input, timeoutMs = DEFAULT_CHILD_TIMEOUT_MS, signal, cleanup = {} } = {}) {
  const abortSignal = signal ?? pollContext.getStore();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let timer;
    const exited = new Promise((done) => child.once('exit', done));
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    const stop = async (reason) => {
      if (stopping) return;
      stopping = true;
      // One deadline covers discovery, kill, the helper commands, and the wait for exit.
      const deadline = Date.now() + CLEANUP_DEADLINE_MS;
      try {
        await terminateTree(child, deadline, cleanup);
        if (!(await exitedWithin(exited, deadline))) {
          throw new Error(`not exited within ${CLEANUP_DEADLINE_MS}ms`);
        }
      } catch (err) {
        const detail = `${reason}: ${err.message}`;
        finish(reject, err instanceof ProcessCleanupError ? err : new ProcessCleanupError(command, child.pid, detail));
        return;
      }
      finish(resolve, { code: -1, stdout, stderr: `${stderr}${reason}: ${command} ${args.join(' ')}` });
    };
    const onAbort = () => { stop('aborted by poll deadline'); };
    timer = setTimeout(() => { stop(`timed out after ${timeoutMs}ms`); }, timeoutMs);
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { if (!stopping) finish(resolve, { code: -1, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { if (!stopping) finish(resolve, { code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// compose runs a Docker Compose command for the stack and returns { code, stdout, stderr }.
export function compose(args, { env, input, timeoutMs } = {}) {
  return run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { env, input, timeoutMs });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TIMED_OUT = Symbol('timed out');
// The most time a poll adds beyond its requested timeout, to cancel and clean up its check. A rejection at the
// deadline therefore arrives within timeoutMs + POLL_CLEANUP_ALLOWANCE_MS.
export const POLL_CLEANUP_ALLOWANCE_MS = 2000;

// pollUntil repeatedly calls check({ remainingMs, signal }) until it returns a truthy value, and rejects at timeoutMs.
// The signal aborts at the deadline and when an enclosing poll aborts. Work started inside the check inherits it.
// A cleanup failure from a cancelled check is rethrown as a ProcessCleanupError instead of a timeout.
export async function pollUntil(check, { intervalMs = 500, timeoutMs, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
  const outer = pollContext.getStore();
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    const controller = new AbortController();
    const cancelFromOuter = () => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', cancelFromOuter, { once: true });
    }
    try {
      const attempt = Promise.resolve()
        .then(() => pollContext.run(controller.signal, () => check({ remainingMs, signal: controller.signal })))
        .then((value) => ({ value }), (error) => ({ error }));
      let deadlineTimer;
      const expired = new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(TIMED_OUT), remainingMs); });
      const outcome = await Promise.race([attempt, expired]);
      clearTimeout(deadlineTimer);
      if (outcome === TIMED_OUT) {
        // Cancel the check and wait, within the allowance, for it to finish cleaning up its processes.
        controller.abort();
        const settled = await Promise.race([attempt, delay(POLL_CLEANUP_ALLOWANCE_MS).then(() => null)]);
        if (settled?.error instanceof ProcessCleanupError) throw settled.error;
        throw timeoutError();
      }
      if (outcome.error) throw outcome.error;
      if (outcome.value) return outcome.value;
      if (controller.signal.aborted) throw new Error(`poll cancelled by its outer deadline waiting for: ${what}`);
      if (Date.now() >= deadline) throw timeoutError();
      await delay(Math.min(intervalMs, deadline - Date.now()));
    } finally {
      outer?.removeEventListener('abort', cancelFromOuter);
    }
  }
}

// ---- ClickHouse ------------------------------------------------------------------------------------------

// clickhouseRows runs a query and parses its JSONEachRow output. Callers must qualify every table as
// signalforge.<table>; the client's default database is not the application database.
export async function clickhouseRows(sql) {
  const result = await compose([
    'exec', '-T', 'clickhouse', 'clickhouse-client', '--format', 'JSONEachRow', '--query', sql,
  ]);
  if (result.code !== 0) {
    throw new Error(`clickhouse query failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// ---- Kafka ----------------------------------------------------------------------------------------------

// parseSinglePartitionHighWatermark reads the output of `rpk topic describe <topic> -p` for a topic with
// exactly one partition, and returns that partition's high-watermark as a number. It rejects any other shape.
export function parseSinglePartitionHighWatermark(describeOutput) {
  const lines = describeOutput.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) throw new Error('describe output is empty');
  const columns = lines[0].split(/\s+/);
  const partitionIndex = columns.indexOf('PARTITION');
  const highWatermarkIndex = columns.indexOf('HIGH-WATERMARK');
  if (partitionIndex < 0) throw new Error('describe output has no PARTITION column');
  if (highWatermarkIndex < 0) throw new Error('describe output has no HIGH-WATERMARK column');
  const rows = lines.slice(1);
  if (rows.length !== 1) throw new Error(`expected exactly one partition row, got ${rows.length}`);
  const fields = rows[0].split(/\s+/);
  if (fields[partitionIndex] !== '0') throw new Error(`expected partition 0, got ${fields[partitionIndex]}`);
  const value = fields[highWatermarkIndex];
  if (!/^\d+$/.test(value ?? '')) throw new Error(`HIGH-WATERMARK is not numeric: ${value}`);
  return Number(value);
}

// compareExactTraceSets compares trace IDs as multisets. Order does not matter, but a duplicate counts, so
// two lists match only when they contain the same IDs the same number of times.
export function compareExactTraceSets(actual, expected) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  const equal = sortedActual.length === sortedExpected.length
    && sortedActual.every((id, index) => id === sortedExpected[index]);
  return {
    equal,
    onlyActual: sortedActual.filter((id) => !sortedExpected.includes(id)),
    onlyExpected: sortedExpected.filter((id) => !sortedActual.includes(id)),
    actualCount: sortedActual.length,
    expectedCount: sortedExpected.length,
  };
}

// highWatermark captures a single-partition topic's high-watermark immediately before an action.
export async function highWatermark(topic) {
  const result = await compose(['exec', '-T', 'redpanda', 'rpk', 'topic', 'describe', topic, '-p', '--brokers', 'redpanda:9092']);
  if (result.code !== 0) throw new Error(`describe ${topic} failed: ${result.stderr.trim()}`);
  return parseSinglePartitionHighWatermark(result.stdout);
}

// parseConsumerGroupSummary reads `rpk group describe <group> -s` output and returns the group state and
// member count. It rejects output that lacks either line, or whose member count is not a number.
export function parseConsumerGroupSummary(summaryOutput) {
  const lines = summaryOutput.split('\n').map((line) => line.trim());
  const stateLine = lines.find((line) => /^STATE\s+\S+$/.test(line));
  if (!stateLine) throw new Error('group summary has no STATE line');
  const membersLine = lines.find((line) => /^MEMBERS\s+\S+$/.test(line));
  if (!membersLine) throw new Error('group summary has no MEMBERS line');
  const members = membersLine.split(/\s+/)[1];
  if (!/^\d+$/.test(members)) throw new Error(`MEMBERS is not numeric: ${members}`);
  return { state: stateLine.split(/\s+/)[1], members: Number(members) };
}

// describeNormalizerGroupSummary runs the read-only summary command. A command failure throws, so a failed
// read is never mistaken for an empty or stable group.
async function describeNormalizerGroupSummary() {
  const result = await compose([
    'exec', '-T', 'redpanda', 'rpk', 'group', 'describe', 'collector-go-normalizer', '-s', '--brokers', 'redpanda:9092',
  ]);
  if (result.code !== 0) throw new Error(`rpk group describe failed: ${result.stderr.trim()}`);
  return parseConsumerGroupSummary(result.stdout);
}

// waitForNormalizerGroupStable polls once a second for at most 120 seconds until collector-go-normalizer is
// Stable with exactly one member. It deletes and alters nothing.
export async function waitForNormalizerGroupStable() {
  return pollUntil(async () => {
    const summary = await describeNormalizerGroupSummary();
    return summary.state === 'Stable' && summary.members === 1 ? summary : null;
  }, { intervalMs: 1000, timeoutMs: 120_000, what: 'collector-go-normalizer stable with one member' });
}

// consumeFromOffset reads one record from an exact numeric offset, bounded by timeoutMs. It does not
// depend on consumer attachment timing, because the record is retained at that offset.
export function consumeFromOffset(topic, offset, timeoutMs) {
  return consumeBounded({ topic, num: 1, offset: String(offset), timeoutMs });
}

// publishToTopic produces one JSON value with a terminating newline, then closes stdin.
export async function publishToTopic(topic, key, value) {
  const result = await compose([
    'exec', '-T', 'redpanda', 'rpk', 'topic', 'produce', topic, '--key', key, '--brokers', 'redpanda:9092',
  ], { input: `${JSON.stringify(value)}\n` });
  if (result.code !== 0) {
    throw new Error(`publish to ${topic} failed: ${result.stderr.trim()}`);
  }
}

// ---- collector-go and deployments ----------------------------------------------------------------------

async function containerState(name) {
  const result = await run('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name]);
  return result.code === 0 ? result.stdout.trim() : '';
}

// setCollectorHooks recreates only collector-go with the two acceptance hooks and waits until it runs.
export async function setCollectorHooks({ failAttempts, crash }) {
  const result = await compose(['up', '-d', '--force-recreate', '--no-deps', COLLECTOR], {
    env: {
      ...process.env,
      INCIDENT_PUBLISH_FAIL_ATTEMPTS: String(failAttempts),
      INCIDENT_CRASH_AFTER_PRODUCE: String(crash),
    },
  });
  if (result.code !== 0) {
    throw new Error(`recreate collector-go failed: ${result.stderr.trim()}`);
  }
  await pollUntil(async () => (await containerState(COLLECTOR_CONTAINER)).startsWith('running'), {
    ...CONTAINER_WAIT, what: 'collector-go running',
  });
  await waitForNormalizerGroupStable();
}

// deployFaulty deploys demo-payments with fault mode enabled and returns the printed deployment ID.
export async function deployFaulty(version) {
  return deployWith(version, 'enabled');
}

async function deployWith(version, fault) {
  const result = await run(process.execPath, [DEPLOY_SCRIPT, '--version', version, '--fault', fault], { timeoutMs: 300_000 });
  if (result.code !== 0) {
    throw new Error(`deploy ${version} (${fault}) exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const ids = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('deployment_id='));
  if (ids.length !== 1) {
    throw new Error(`expected exactly one deployment_id line, got ${ids.length}`);
  }
  const match = ids[0].match(/^deployment_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  if (!match) throw new Error(`malformed deployment_id line: ${ids[0]}`);
  return match[1];
}

// ---- UUIDv5 (matches internal/canonical EventID) --------------------------------------------------------

const NAMESPACE_HEX = '8f3c2a9e5d1b4f6ab7c82e9d0a1b3c4d';

// eventIdV5 is RFC 4122 UUIDv5 in the project namespace: SHA-1 over the namespace bytes and the key.
export function eventIdV5(key) {
  const hash = createHash('sha1').update(Buffer.from(NAMESPACE_HEX, 'hex')).update(key).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The Go identity test fixes this value. The check runs before any scenario, so an encoding error stops
// the run before it reads the wrong event IDs.
const GO_REFERENCE_KEY = 'trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331';
const GO_REFERENCE_ID = 'f9167183-9a1e-5218-82bc-4df30ad543e6';

export function verifyEventIdV5() {
  const got = eventIdV5(GO_REFERENCE_KEY);
  if (got !== GO_REFERENCE_ID) {
    throw new Error(`eventIdV5 mismatch: got ${got}, Go canonical value is ${GO_REFERENCE_ID}`);
  }
}

// ---- orders -----------------------------------------------------------------------------------------------

const ORDER_TIMEOUT_MS = 10_000;

// postOrder sends one order with a deadline. A request that gets no response is aborted and reported.
export async function postOrder(url, order, { timeoutMs = ORDER_TIMEOUT_MS, signal } = {}) {
  const pollSignal = signal ?? pollContext.getStore();
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(order),
      signal: pollSignal ? AbortSignal.any([deadline, pollSignal]) : deadline,
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (pollSignal?.aborted) throw new Error('order POST aborted by poll deadline');
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`order POST timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

// sendOrders posts count fresh orders while Payments is faulted. Each must return HTTP 502 with the body
// the Orders service actually produces (see the Task 11 decision: order_id, status failed, reason).
export async function sendOrders(count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const orderId = randomUUID();
    const { status, text } = await postOrder(ORDERS_URL, { order_id: orderId, item: 'acceptance-widget', amount_cents: 1000 });
    if (status !== 502) {
      throw new Error(`order ${orderId}: expected HTTP 502, got ${status} ${text}`);
    }
    const expected = { order_id: orderId, status: 'failed', reason: FAILURE_REASON };
    if (text !== JSON.stringify(expected) && JSON.stringify(JSON.parse(text)) !== JSON.stringify(expected)) {
      throw new Error(`order ${orderId}: unexpected body ${text}`);
    }
    ids.push(orderId);
  }
  return ids;
}

// resolveOrderTrace returns the trace ID of the single Orders error log row for one order ID.
export async function resolveOrderTrace(orderId) {
  return pollUntil(async () => {
    const rows = await clickhouseRows(
      `SELECT trace_id FROM signalforge.telemetry_events FINAL
       WHERE type = 'log' AND service = 'demo-orders' AND severity = 'error'
         AND JSONExtractString(attributes, 'order_id') = '${orderId}'`,
    );
    if (rows.length > 1) throw new Error(`order ${orderId} has ${rows.length} error log rows, expected 1`);
    return rows.length === 1 ? rows[0].trace_id : null;
  }, { ...SHORT, what: `Orders error log for order ${orderId}` });
}

// paymentsFailures returns the distinct Payments 5xx trace IDs for one deployment with the earliest
// timestamp of each, as nanosecond strings, ordered by time.
export async function paymentsFailures(deploymentId) {
  return clickhouseRows(
    `SELECT trace_id, toString(toUnixTimestamp64Nano(min(timestamp))) AS ts_nanos
     FROM signalforge.telemetry_events FINAL
     WHERE type = 'trace' AND service = 'demo-payments' AND deployment_id = '${deploymentId}'
       AND JSONExtractString(attributes, 'span.kind') = 'server'
       AND JSONExtractInt(attributes, 'http.response.status_code') = 500
     GROUP BY trace_id
     ORDER BY min(timestamp)`,
  );
}

// sendBurst sends count orders and resolves only this batch's trace IDs from the Orders error logs.
async function sendBurst(deploymentId, count) {
  const orderIds = await sendOrders(count);
  const traceIds = [];
  for (const orderId of orderIds) traceIds.push(await resolveOrderTrace(orderId));
  return { orderIds, traceIds, deploymentId };
}

// waitForExactPaymentsTraceSet polls until the deployment's Payments failure set equals expectedTraceIds exactly.
async function waitForExactPaymentsTraceSet(deploymentId, expectedTraceIds) {
  return pollUntil(async () => {
    const failures = await paymentsFailures(deploymentId);
    const result = compareExactTraceSets(failures.map((r) => r.trace_id), expectedTraceIds);
    return result.equal ? result : null;
  }, { ...SHORT, what: `Payments failure traces for ${deploymentId} to equal ${expectedTraceIds.join(',')}` });
}

// ---- incidents and evidence -------------------------------------------------------------------------------

function dedupKey(deploymentId) {
  return `local|demo-payments|${deploymentId}|${TRIGGER_RULE}`;
}

async function latestIncidents(deploymentId) {
  return clickhouseRows(
    `SELECT incident_id, revision, severity, status, services,
            toString(toUnixTimestamp64Nano(started_at)) AS started_nanos,
            toString(toUnixTimestamp64Nano(detected_at)) AS detected_nanos,
            publication_state, published_at
     FROM signalforge.incidents FINAL WHERE dedup_key = '${dedupKey(deploymentId)}'`,
  );
}

async function evidenceRows(incidentId) {
  return clickhouseRows(
    `SELECT source_type, source_ref FROM signalforge.evidence_items FINAL WHERE incident_id = '${incidentId}'`,
  );
}

async function waitForIncidentPublished(deploymentId) {
  return pollUntil(async () => {
    const rows = await latestIncidents(deploymentId);
    return rows.length === 1 && rows[0].publication_state === 'published' && rows[0].published_at !== null
      ? rows[0] : null;
  }, { ...LONG, what: `published incident for ${deploymentId}` });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- scenarios -----------------------------------------------------------------------------------------

async function waitDeploymentSucceeded(deploymentId) {
  await pollUntil(async () => {
    const rows = await clickhouseRows(
      `SELECT count() AS n FROM signalforge.deployments FINAL
       WHERE deployment_id = '${deploymentId}' AND service = 'demo-payments' AND status = 'succeeded'`,
    );
    return Number(rows[0].n) === 1;
  }, { ...SHORT, what: `succeeded deployment ${deploymentId}` });
}

// Scenario A: the main path, deduplication, dead letter, and telemetry idempotency.
// prepareFirstDeployment restores the hooks, waits for the normalizer group to be Stable with one member, and
// only then publishes the first deployment. The collaborators are injected so the order can be tested.
export async function prepareFirstDeployment({ setHooks, waitForGroup, deploy }) {
  await setHooks({ failAttempts: 0, crash: 0 });
  await waitForGroup();
  return deploy();
}

async function scenarioA(state) {
  state.D1 = await prepareFirstDeployment({
    setHooks: setCollectorHooks,
    waitForGroup: waitForNormalizerGroupStable,
    deploy: () => deployFaulty('0.2.0-faulty'),
  });
  await waitDeploymentSucceeded(state.D1);

  const incidentHwBeforeTrigger = await highWatermark(INCIDENT_TOPIC);
  const burst = await sendBurst(state.D1, 3);
  state.trigger1 = burst.traceIds;
  await waitForExactPaymentsTraceSet(state.D1, state.trigger1);

  const failures = await paymentsFailures(state.D1);
  const earliest = failures.map((r) => BigInt(r.ts_nanos)).reduce((a, b) => (a < b ? a : b));

  const rows = await pollUntil(async () => {
    const found = await latestIncidents(state.D1);
    return found.length === 1 ? found : null;
  }, { ...LONG, what: `one incident for ${dedupKey(state.D1)}` });
  const inc = rows[0];
  state.I1 = inc.incident_id;
  assert(inc.severity === 'high', `I1 severity ${inc.severity}`);
  assert(inc.status === 'open', `I1 status ${inc.status}`);
  assert(JSON.stringify(inc.services) === JSON.stringify(['demo-payments']), `I1 services ${JSON.stringify(inc.services)}`);
  assert(BigInt(inc.started_nanos) === earliest, `I1 started_at ${inc.started_nanos} != earliest failure ${earliest}`);
  assert(BigInt(inc.detected_nanos) >= BigInt(inc.started_nanos), 'I1 detected_at before started_at');

  const evidence = await evidenceRows(state.I1);
  assert(evidence.length === 4, `I1 has ${evidence.length} evidence rows, expected 4`);
  const deploymentRefs = evidence.filter((e) => e.source_type === 'deployment').map((e) => e.source_ref);
  assert(JSON.stringify(deploymentRefs) === JSON.stringify([state.D1]), `I1 deployment evidence ${deploymentRefs}`);
  const traceRefs = evidence.filter((e) => e.source_type === 'trace').map((e) => e.source_ref).sort();
  assert(JSON.stringify(traceRefs) === JSON.stringify([...state.trigger1].sort()), 'I1 trace evidence mismatch');

  await waitForIncidentPublished(state.D1);
  const first = await consumeFromOffset(INCIDENT_TOPIC, incidentHwBeforeTrigger, 60_000);
  assert(first.length === 1 && first[0].key === state.I1, `first Kafka record key ${first[0] && first[0].key} != ${state.I1}`);
  assert(JSON.parse(first[0].value).incident_id === state.I1, 'first Kafka payload incident_id mismatch');

  // Healthy-path invariant: after the verified I1 record at H, the topic high-watermark is exactly H + 1.
  const afterPublish = await highWatermark(INCIDENT_TOPIC);
  assert(afterPublish === incidentHwBeforeTrigger + 1,
    `incident topic high-watermark ${afterPublish}, expected exactly ${incidentHwBeforeTrigger + 1}`);

  // Deduplication: three more orders under the same deployment must not create or extend an incident.
  const later = await sendBurst(state.D1, 3);
  state.laterTraces = later.traceIds;
  await waitForExactPaymentsTraceSet(state.D1, [...state.trigger1, ...later.traceIds]);
  const newest = (await paymentsFailures(state.D1)).map((r) => BigInt(r.ts_nanos)).reduce((a, b) => (a > b ? a : b));
  await pollUntil(async () => {
    const runs = await clickhouseRows(
      'SELECT toString(toUnixTimestamp64Nano(max(evaluated_until))) AS nanos FROM signalforge.correlation_runs',
    );
    return runs[0].nanos !== '' && BigInt(runs[0].nanos) >= newest;
  }, { ...LONG, what: 'correlator progress past the newest D1 failure' });
  const afterDedup = await latestIncidents(state.D1);
  assert(afterDedup.length === 1 && afterDedup[0].incident_id === state.I1, 'dedup created or changed an incident');
  const afterEvidence = await evidenceRows(state.I1);
  assert(afterEvidence.length === 4, `dedup changed evidence count to ${afterEvidence.length}`);
  assert(!afterEvidence.some((e) => later.traceIds.includes(e.source_ref)), 'later trace became evidence');

  // Dead letter: a malformed trace (the fixture with only traceId removed) is rejected with its exact reason.
  const deadLetterHw = await highWatermark(DEAD_LETTER_TOPIC);
  const malformed = JSON.parse(await readFile(FIXTURE, 'utf8'));
  delete malformed.resourceSpans[0].scopeSpans[0].spans[0].traceId;
  await publishToTopic(RAW_TOPIC, 'acceptance-malformed-trace', malformed);
  const dl = await consumeBounded({ topic: DEAD_LETTER_TOPIC, num: 1, offset: String(deadLetterHw), timeoutMs: 60_000 });
  assert(dl.length === 1, 'no dead letter produced for the malformed trace');
  assert(JSON.parse(dl[0].value).reason === DEAD_LETTER_REASON, `dead-letter reason ${JSON.parse(dl[0].value).reason}`);
  const malformedRows = await clickhouseRows(
    "SELECT count() AS n FROM signalforge.telemetry_events FINAL WHERE span_id = 'b7ad6b7169203331' AND trace_id = ''",
  );
  assert(Number(malformedRows[0].n) === 0, 'a canonical row exists for the malformed record');

  const [validOrder] = await sendOrders(1);
  const validTrace = await resolveOrderTrace(validOrder);
  await pollUntil(async () => {
    const rows = await clickhouseRows(
      `SELECT count() AS n FROM signalforge.telemetry_events FINAL WHERE type = 'trace' AND trace_id = '${validTrace}'`,
    );
    return Number(rows[0].n) > 0;
  }, { ...SHORT, what: `canonical trace ${validTrace}` });

  // Telemetry idempotency: the same demo-orders trace twice, then a sentinel with distinct IDs.
  const duplicate = demoOrdersTrace('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331');
  await publishToTopic(RAW_TOPIC, 'acceptance-duplicate-trace', duplicate);
  await publishToTopic(RAW_TOPIC, 'acceptance-duplicate-trace', duplicate);
  const sentinelKey = 'trace|11111111111111111111111111111111|2222222222222222';
  await publishToTopic(RAW_TOPIC, 'acceptance-sentinel', demoOrdersTrace('11111111111111111111111111111111', '2222222222222222'));
  await pollUntil(async () => {
    const rows = await clickhouseRows(
      `SELECT count() AS n FROM signalforge.telemetry_events FINAL WHERE event_id = '${eventIdV5(sentinelKey)}'`,
    );
    return Number(rows[0].n) === 1;
  }, { ...SHORT, what: 'sentinel trace in telemetry_events' });
  const dupCount = await clickhouseRows(
    `SELECT count() AS n FROM signalforge.telemetry_events FINAL
     WHERE event_id = '${eventIdV5('trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331')}'`,
  );
  assert(Number(dupCount[0].n) === 1, `duplicate telemetry event count ${dupCount[0].n}, expected 1`);
}

// A valid OTLP/JSON trace from the canonical fixture, with only the service name and IDs changed.
function demoOrdersTrace(traceId, spanId) {
  return fixtureTrace(traceId, spanId, 'demo-orders');
}

const fixtureCache = {};
function fixtureTrace(traceId, spanId, service) {
  const copy = JSON.parse(JSON.stringify(fixtureCache.traces));
  const resource = copy.resourceSpans[0].resource.attributes;
  const serviceAttr = resource.find((a) => a.key === 'service.name');
  serviceAttr.value = { stringValue: service };
  const span = copy.resourceSpans[0].scopeSpans[0].spans[0];
  span.traceId = traceId;
  span.spanId = spanId;
  return copy;
}

// Scenario B: publication fails twice before succeeding; the incident is still persisted once.
async function scenarioB(state) {
  await setCollectorHooks({ failAttempts: 2, crash: 0 });
  state.D2 = await deployFaulty('0.3.0-faulty');
  await waitDeploymentSucceeded(state.D2);
  const incidentHwBeforeTrigger = await highWatermark(INCIDENT_TOPIC);
  const burst = await sendBurst(state.D2, 3);
  state.trigger2 = burst.traceIds;
  await waitForExactPaymentsTraceSet(state.D2, state.trigger2);

  const published = await waitForIncidentPublished(state.D2);
  state.I2 = published.incident_id;
  const logs = await collectorLogs();
  const failed = logs.split('\n').filter((l) => l.includes('"msg":"publish failed"') && l.includes(`"incident_id":"${state.I2}"`));
  assert(failed.length >= 2, `expected at least 2 publish failed for ${state.I2}, got ${failed.length}`);

  const latest = await latestIncidents(state.D2);
  assert(latest.length === 1, `D2 has ${latest.length} incidents`);
  assert((await evidenceRows(state.I2)).length === 4, 'D2 evidence is not four rows');
  const records = await consumeFromOffset(INCIDENT_TOPIC, incidentHwBeforeTrigger, 60_000);
  assert(records.length === 1 && records[0].key === state.I2, `B Kafka key ${records[0] && records[0].key} != ${state.I2}`);
  assert(JSON.parse(records[0].value).incident_id === state.I2, 'B Kafka payload incident_id mismatch');
  await setCollectorHooks({ failAttempts: 0, crash: 0 });
}

// Scenario C: collector-go crashes after a successful produce; the restarted process publishes the same
// incident again, and persistence still holds one incident with four evidence rows.
async function scenarioC(state) {
  await setCollectorHooks({ failAttempts: 0, crash: 1 });
  state.D3 = await deployFaulty('0.4.0-faulty');
  await waitDeploymentSucceeded(state.D3);
  const firstHwBeforeCrash = await highWatermark(INCIDENT_TOPIC);
  const burst = await sendBurst(state.D3, 3);
  state.trigger3 = burst.traceIds;
  await waitForExactPaymentsTraceSet(state.D3, state.trigger3);

  await pollUntil(async () => (await containerState(COLLECTOR_CONTAINER)) === 'exited 1',
    { ...CONTAINER_WAIT, what: 'collector-go exited with status 1' });
  const first = await consumeFromOffset(INCIDENT_TOPIC, firstHwBeforeCrash, 60_000);
  assert(first.length === 1, 'no first I3 record');
  state.I3 = first[0].key;
  assert(JSON.parse(first[0].value).incident_id === state.I3, 'first C payload incident_id mismatch');

  // Capture a new high-watermark immediately before the restart that publishes the same incident again.
  const secondHwBeforeRestart = await highWatermark(INCIDENT_TOPIC);
  await setCollectorHooks({ failAttempts: 0, crash: 0 });
  await waitForIncidentPublished(state.D3);
  const second = await consumeFromOffset(INCIDENT_TOPIC, secondHwBeforeRestart, 60_000);
  assert(second.length === 1 && second[0].key === state.I3, `second I3 record key ${second[0] && second[0].key}`);
  assert(JSON.parse(second[0].value).incident_id === state.I3, 'second C payload incident_id mismatch');

  const latest = await latestIncidents(state.D3);
  assert(latest.length === 1 && latest[0].incident_id === state.I3, 'D3 does not have exactly one incident');
  assert((await evidenceRows(state.I3)).length === 4, 'D3 evidence is not four rows');
}

// collectorLogs returns the current collector-go container's log text.
async function collectorLogs(tail) {
  const args = ['logs', '--no-color'];
  if (tail) args.push('--tail', String(tail));
  args.push(COLLECTOR);
  const result = await compose(args);
  return result.stdout + result.stderr;
}

// ---- preconditions, restore, and reporting ------------------------------------------------------------

class PreconditionError extends Error {}

async function checkPreconditions() {
  if (!(await containerState(COLLECTOR_CONTAINER)).startsWith('running')) {
    throw new PreconditionError('service collector-go is not running');
  }
}

async function main() {
  try {
    await checkPreconditions();
  } catch (error) {
    if (error instanceof PreconditionError) {
      process.stdout.write(`precondition failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  process.chdir(REPO_ROOT);
  const state = {};
  let step = 'startup';
  let failure = null;
  const restore = {};

  try {
    verifyEventIdV5();
    fixtureCache.traces = JSON.parse(await readFile(FIXTURE, 'utf8'));

    step = 'scenario A';
    await scenarioA(state);
    step = 'scenario B';
    await scenarioB(state);
    step = 'scenario C';
    await scenarioC(state);
  } catch (error) {
    failure = { step, message: error.message };
  } finally {
    try {
      await setCollectorHooks({ failAttempts: 0, crash: 0 });
      restore.hooks = 'ok';
    } catch (error) {
      restore.hooks = `failed: ${error.message}`;
    }
    try {
      await deployWith('0.1.0', 'disabled');
      restore.deploy = 'ok';
    } catch (error) {
      restore.deploy = `failed: ${error.message}`;
    }
  }

  const restoreFailed = restore.hooks !== 'ok' || restore.deploy !== 'ok';
  if (restoreFailed && !failure) {
    failure = { step: 'restore', message: `hooks ${restore.hooks}; deploy ${restore.deploy}` };
  }

  if (failure) {
    process.stdout.write(`FAIL ${failure.step}: ${failure.message}\n`);
    process.stdout.write(`restore: hooks ${restore.hooks ?? 'not run'}; deploy ${restore.deploy ?? 'not run'}\n`);
    process.stdout.write('--- last 200 collector-go log lines ---\n');
    process.stdout.write(`${await collectorLogs(200)}\n`);
    return 1;
  }

  process.stdout.write(`I1=${state.I1}\nI2=${state.I2}\nI3=${state.I3}\n`);
  process.stdout.write(`D1=${state.D1}\nD2=${state.D2}\nD3=${state.D3}\n`);
  process.stdout.write(`trigger traces D1=${state.trigger1.join(',')} D2=${state.trigger2.join(',')} D3=${state.trigger3.join(',')}\n`);
  const evidence = await evidenceRows(state.I1);
  process.stdout.write(`I1 evidence: ${evidence.map((e) => `${e.source_type}:${e.source_ref}`).join(' ')}\n`);
  process.stdout.write('PASS\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
