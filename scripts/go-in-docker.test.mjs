import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWrapperArgs, buildDockerArgs, GO_IMAGE } from './go-in-docker.mjs';

test('parses --network and --env into their argument arrays and keeps the Go command', () => {
  const parsed = parseWrapperArgs(['--env', 'A=1', '--network', 'n', 'go', 'test', './...']);
  assert.deepEqual(parsed.networkArgs, ['--network', 'n']);
  assert.deepEqual(parsed.envArgs, ['-e', 'A=1']);
  assert.deepEqual(parsed.goArgs, ['go', 'test', './...']);
});

test('keeps repeated --env flags in order', () => {
  const parsed = parseWrapperArgs(['--env', 'A=1', '--env', 'B=2', 'go', 'vet', './...']);
  assert.deepEqual(parsed.envArgs, ['-e', 'A=1', '-e', 'B=2']);
  assert.deepEqual(parsed.networkArgs, []);
  assert.deepEqual(parsed.goArgs, ['go', 'vet', './...']);
});

test('with no wrapper flags the Go command is passed through unchanged', () => {
  const parsed = parseWrapperArgs(['go', 'version']);
  assert.deepEqual(parsed, { networkArgs: [], envArgs: [], goArgs: ['go', 'version'] });
});

test('rejects an unknown leading wrapper flag', () => {
  assert.throws(() => parseWrapperArgs(['--bogus', 'go', 'version']), /unknown wrapper flag: --bogus/);
});

test('rejects --env without a KEY=VALUE value', () => {
  assert.throws(() => parseWrapperArgs(['--env', 'NOEQUALS', 'go', 'version']), /--env requires KEY=VALUE/);
});

test('rejects a wrapper call with no Go command', () => {
  assert.throws(() => parseWrapperArgs(['--network', 'n']), /a Go command is required/);
});

test('pins the builder image by tag and immutable digest', () => {
  assert.equal(
    GO_IMAGE,
    'golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414',
  );
});

test('builds the exact docker run argument array with CGO disabled and the pinned image', () => {
  const parsed = parseWrapperArgs(['--network', 'n', '--env', 'A=1', 'go', 'test', './...']);
  assert.deepEqual(buildDockerArgs('/repo/services/collector-go', parsed), [
    'run', '--rm',
    '--network', 'n',
    '-e', 'A=1',
    '-v', '/repo/services/collector-go:/src',
    '-w', '/src',
    '-e', 'CGO_ENABLED=0',
    GO_IMAGE,
    'go', 'test', './...',
  ]);
});
