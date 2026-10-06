import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSinglePartitionHighWatermark, compareExactTraceSets, parseConsumerGroupSummary, run, postOrder, pollUntil, prepareFirstDeployment } from './verify-faulty-deployment-incident.mjs';

test('a child process that outlives its timeout is killed and reports the timeout', async () => {
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /timed out after 300ms/);
});

test('an order POST that gets no response is aborted at its deadline', async () => {
  const server = http.createServer(() => {}); // accepts the request and never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      postOrder(`http://127.0.0.1:${port}/orders`, { order_id: 'x' }, { timeoutMs: 300 }),
      /timed out after 300ms/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the initial scenario waits for a stable normalizer group before the first deployment', async () => {
  const calls = [];
  const id = await prepareFirstDeployment({
    setHooks: async (hooks) => { calls.push(`hooks ${hooks.failAttempts}/${hooks.crash}`); },
    waitForGroup: async () => { calls.push('group stable'); },
    deploy: async () => { calls.push('deploy'); return 'D-initial'; },
  });
  assert.deepEqual(calls, ['hooks 0/0', 'group stable', 'deploy']);
  assert.equal(id, 'D-initial');
});

// A check that launches a long-lived child must have that child terminated when the poll deadline expires.
test('a long-lived child under a polling deadline is terminated before pollUntil rejects', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poll-child-'));
  const pidFile = join(dir, 'pid');
  const started = Date.now();
  try {
    await assert.rejects(
      pollUntil(({ signal }) => run(process.execPath,
        ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)", pidFile],
        { signal, timeoutMs: 60000 }),
      { timeoutMs: 1000, what: 'long child' }),
      /Timed out after 1000ms waiting for: long child/,
    );
    assert.ok(Date.now() - started < 5000, 'the poll must fail by its own bound');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an order POST stops when its poll signal aborts', { timeout: 5000 }, async () => {
  const server = http.createServer(() => {}); // never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(
      postOrder(`http://127.0.0.1:${port}/orders`, { order_id: 'x' }, { timeoutMs: 10000, signal: controller.signal }),
      /aborted/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a hung check cannot bypass the overall polling deadline', { timeout: 5000 }, async () => {
  await assert.rejects(
    pollUntil(() => new Promise(() => {}), { timeoutMs: 300, what: 'hung check' }),
    /Timed out after 300ms waiting for: hung check/,
  );
});

test('identical trace sets match regardless of order', () => {
  assert.equal(compareExactTraceSets(['b', 'a', 'c'], ['a', 'c', 'b']).equal, true);
});

test('the six-trace union matches the cumulative deployment result', () => {
  const trigger = ['t1', 't2', 't3'];
  const dedup = ['d1', 'd2', 'd3'];
  const cumulative = ['d3', 't1', 'd1', 't3', 'd2', 't2'];
  assert.equal(compareExactTraceSets(cumulative, [...trigger, ...dedup]).equal, true);
});

test('comparing only the second batch against the cumulative six traces fails', () => {
  const cumulative = ['t1', 't2', 't3', 'd1', 'd2', 'd3'];
  const result = compareExactTraceSets(cumulative, ['d1', 'd2', 'd3']);
  assert.equal(result.equal, false);
  assert.deepEqual(result.onlyActual, ['t1', 't2', 't3']);
  assert.deepEqual(result.onlyExpected, []);
});

test('duplicate IDs do not make unequal sets pass', () => {
  assert.equal(compareExactTraceSets(['a', 'a', 'b'], ['a', 'b']).equal, false);
  assert.equal(compareExactTraceSets(['a', 'b'], ['a', 'b', 'b']).equal, false);
});

// Captured from: rpk topic describe incidents.created.v1 -p (RPK v24.2.7).
const CAPTURED = [
  'PARTITION  LEADER  EPOCH  REPLICAS  LOG-START-OFFSET  HIGH-WATERMARK',
  '0          0       12     [0]       0                 3',
  '',
].join('\n');

test('returns the exact numeric high-watermark for the single partition', () => {
  assert.equal(parseSinglePartitionHighWatermark(CAPTURED), 3);
});

test('rejects output without a HIGH-WATERMARK column', () => {
  const text = CAPTURED.replace('HIGH-WATERMARK', 'HIGH-MARK');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /HIGH-WATERMARK/);
});

test('rejects a non-numeric high-watermark', () => {
  const text = CAPTURED.replace(/0\s+0\s+12\s+\[0\]\s+0\s+3/, '0          0       12     [0]       0                 three');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /not numeric/);
});

test('rejects output with zero partition rows', () => {
  const text = CAPTURED.split('\n')[0];
  assert.throws(() => parseSinglePartitionHighWatermark(text), /expected exactly one partition row, got 0/);
});

test('rejects output with multiple partition rows', () => {
  const text = [CAPTURED.split('\n')[0], '0 0 12 [0] 0 3', '1 0 12 [0] 0 5', ''].join('\n');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /expected exactly one partition row, got 2/);
});

test('rejects a nonzero partition', () => {
  const text = CAPTURED.replace(/^0 /m, '1 ');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /expected partition 0/);
});

// Captured from: rpk group describe collector-go-normalizer -s (RPK v24.2.7). The BALANCER value is empty.
const SUMMARY_EMPTY = [
  'GROUP        collector-go-normalizer',
  'COORDINATOR  0',
  'STATE        Empty',
  'BALANCER     ',
  'MEMBERS      0',
  'TOTAL-LAG    0',
  '',
].join('\n');

test('a Stable group with one member parses to its state and count', () => {
  const text = SUMMARY_EMPTY.replace('Empty', 'Stable').replace('MEMBERS      0', 'MEMBERS      1');
  assert.deepEqual(parseConsumerGroupSummary(text), { state: 'Stable', members: 1 });
});

test('a PreparingRebalance group with several members parses but reports its own state', () => {
  const text = SUMMARY_EMPTY.replace('Empty', 'PreparingRebalance').replace('MEMBERS      0', 'MEMBERS      2');
  assert.deepEqual(parseConsumerGroupSummary(text), { state: 'PreparingRebalance', members: 2 });
});

test('output without a STATE line is rejected with a clear error', () => {
  const text = SUMMARY_EMPTY.replace(/STATE.*\n/, '');
  assert.throws(() => parseConsumerGroupSummary(text), /no STATE line/);
});

test('output without a MEMBERS line is rejected with a clear error', () => {
  const text = SUMMARY_EMPTY.replace(/MEMBERS.*\n/, '');
  assert.throws(() => parseConsumerGroupSummary(text), /no MEMBERS line/);
});

test('a non-numeric member count is rejected', () => {
  const text = SUMMARY_EMPTY.replace('MEMBERS      0', 'MEMBERS      many');
  assert.throws(() => parseConsumerGroupSummary(text), /MEMBERS is not numeric/);
});
