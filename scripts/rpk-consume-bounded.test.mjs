import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsumeArgs, parseRecords, runBounded, consumeBounded } from './rpk-consume-bounded.mjs';

const NODE = process.execPath;

test('buildConsumeArgs returns the exact docker compose argument array with no shell string', () => {
  assert.deepEqual(
    buildConsumeArgs({ topic: 'telemetry.raw.v1', num: 2, offset: 'start' }),
    [
      'compose', '-f', 'infra/docker/docker-compose.yml',
      'exec', '-T', 'redpanda',
      'rpk', 'topic', 'consume', 'telemetry.raw.v1',
      '--brokers', 'redpanda:9092',
      '--offset', 'start',
      '--num', '2',
      '--format', 'json',
      '--pretty-print=false',
    ],
  );
});

test('parseRecords returns complete JSON lines and drops a trailing partial line', () => {
  const text = '{"a":1}\n{"b":2}\n{"c":';
  assert.deepEqual(parseRecords(text), [{ a: 1 }, { b: 2 }]);
});

test('parseRecords ignores blank lines', () => {
  assert.deepEqual(parseRecords('\n{"a":1}\n\n'), [{ a: 1 }]);
});

test('runBounded resolves with the child stdout when the child exits on its own', async () => {
  const out = await runBounded(
    ['-e', 'process.stdout.write(\'{"n":1}\\n{"n":2}\\n\')'],
    { command: NODE, timeoutMs: 10000 },
  );
  assert.deepEqual(parseRecords(out), [{ n: 1 }, { n: 2 }]);
});

test('runBounded kills a child that never exits and throws a named timeout error', async () => {
  const script = `
    process.stdout.write(String(process.pid) + '\\n');
    setInterval(() => {}, 1000);
  `;
  let caught;
  try {
    await runBounded(['-e', script], { command: NODE, timeoutMs: 3000 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected a timeout error');
  assert.equal(caught.name, 'BoundedConsumeTimeoutError');
  assert.match(caught.message, /bounded consume timed out after 3000ms/);

  const childPid = Number(caught.stdout.trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0, `child pid not reported: ${caught.stdout}`);
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `child ${childPid} is still running after the timeout`);
});

test('runBounded reports a non-zero exit as an error with the child stderr', async () => {
  await assert.rejects(
    runBounded(['-e', 'process.stderr.write("boom"); process.exit(3)'], { command: NODE, timeoutMs: 10000 }),
    /exited with code 3: boom/,
  );
});

test('consumeBounded passes the timeout through and returns parsed records', async () => {
  const records = await consumeBounded({
    topic: 'telemetry.raw.v1',
    num: 1,
    offset: 'start',
    timeoutMs: 10000,
    command: NODE,
    commandArgsPrefix: ['-e', 'process.stdout.write(\'{"resourceSpans":[]}\\n\')'],
  });
  assert.deepEqual(records, [{ resourceSpans: [] }]);
});
