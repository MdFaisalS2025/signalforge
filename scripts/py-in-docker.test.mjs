import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseWrapperArgs, buildDockerArgs, buildImageArgs, DEPS_IMAGE } from './py-in-docker.mjs';

test('parses --network and --env into their argument arrays and keeps the Python command', () => {
  const parsed = parseWrapperArgs(['--env', 'A=1', '--network', 'n', 'python', '-m', 'unittest']);
  assert.deepEqual(parsed.networkArgs, ['--network', 'n']);
  assert.deepEqual(parsed.envArgs, ['-e', 'A=1']);
  assert.deepEqual(parsed.pyArgs, ['python', '-m', 'unittest']);
});

test('keeps repeated --env flags in order', () => {
  const parsed = parseWrapperArgs(['--env', 'A=1', '--env', 'B=2', '--env', 'C=3', 'python', '-V']);
  assert.deepEqual(parsed.envArgs, ['-e', 'A=1', '-e', 'B=2', '-e', 'C=3']);
  assert.deepEqual(parsed.networkArgs, []);
  assert.deepEqual(parsed.pyArgs, ['python', '-V']);
});

test('keeps an environment value that itself contains an equals sign', () => {
  const parsed = parseWrapperArgs(['--env', 'URL=http://h:8123/?a=b', 'python', '-V']);
  assert.deepEqual(parsed.envArgs, ['-e', 'URL=http://h:8123/?a=b']);
});

test('with no wrapper flags the Python command is passed through unchanged', () => {
  const parsed = parseWrapperArgs(['python', '-m', 'unittest', 'tests.test_config', '-v']);
  assert.deepEqual(parsed, {
    networkArgs: [],
    envArgs: [],
    pyArgs: ['python', '-m', 'unittest', 'tests.test_config', '-v'],
  });
});

test('a flag-like token after the Python command belongs to the command, not the wrapper', () => {
  const parsed = parseWrapperArgs(['python', '--version']);
  assert.deepEqual(parsed.pyArgs, ['python', '--version']);
  assert.deepEqual(parsed.envArgs, []);
});

test('rejects --network without a value', () => {
  assert.throws(() => parseWrapperArgs(['--network']), /--network requires a network name/);
  assert.throws(() => parseWrapperArgs(['--network', '--env', 'A=1', 'python', '-V']), /--network requires a network name/);
});

test('rejects --env without a KEY=VALUE value', () => {
  assert.throws(() => parseWrapperArgs(['--env', 'NOEQUALS', 'python', '-V']), /--env requires KEY=VALUE/);
  assert.throws(() => parseWrapperArgs(['--env']), /--env requires KEY=VALUE/);
});

test('rejects an unknown leading wrapper flag', () => {
  assert.throws(() => parseWrapperArgs(['--bogus', 'python', '-V']), /unknown wrapper flag: --bogus/);
});

test('rejects a wrapper call with no Python command', () => {
  assert.throws(() => parseWrapperArgs([]), /a Python command is required/);
  assert.throws(() => parseWrapperArgs(['--network', 'n']), /a Python command is required/);
  assert.throws(() => parseWrapperArgs(['--env', 'A=1', '--network', 'n']), /a Python command is required/);
});

test('names the dependency image signalforge-agent-deps', () => {
  assert.equal(DEPS_IMAGE, 'signalforge-agent-deps');
});

test('builds only the deps stage from the repository root', () => {
  const repo = path.join('/', 'repo-root');
  assert.deepEqual(buildImageArgs(repo), [
    'build',
    '--quiet',
    '-f', path.join(repo, 'services', 'agent-python', 'Dockerfile'),
    '--target', 'deps',
    '-t', 'signalforge-agent-deps',
    repo,
  ]);
});

test('builds the exact docker run argument array with a read-only repository mount', () => {
  const parsed = parseWrapperArgs(['--network', 'n', '--env', 'A=1', '--env', 'B=2', 'python', '-m', 'unittest', '-v']);
  assert.deepEqual(buildDockerArgs('/host/repo', parsed), [
    'run', '--rm',
    '--network', 'n',
    '-e', 'A=1',
    '-e', 'B=2',
    '-v', '/host/repo:/repo:ro',
    '-w', '/repo/services/agent-python',
    '-e', 'PYTHONPATH=src',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    'signalforge-agent-deps',
    'python', '-m', 'unittest', '-v',
  ]);
});

test('without wrapper flags the run arguments carry no network or caller environment', () => {
  const parsed = parseWrapperArgs(['python', '-V']);
  assert.deepEqual(buildDockerArgs('/host/repo', parsed), [
    'run', '--rm',
    '-v', '/host/repo:/repo:ro',
    '-w', '/repo/services/agent-python',
    '-e', 'PYTHONPATH=src',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    'signalforge-agent-deps',
    'python', '-V',
  ]);
});

test('never invokes a shell and mounts nothing writable', () => {
  const args = buildDockerArgs('/host/repo', parseWrapperArgs(['python', '-V']));
  assert.ok(!args.includes('sh'), 'no sh');
  assert.ok(!args.includes('-c'), 'no -c');
  assert.ok(!args.includes('bash'), 'no bash');
  const mounts = args.filter((_, i) => args[i - 1] === '-v');
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0].endsWith(':/repo:ro'), 'the only mount is the read-only repository');
});
