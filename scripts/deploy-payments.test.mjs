import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  buildDeploymentEvent,
  buildComposeEnv,
  utcNanosNow,
  randomDeploymentId,
} from './deploy-payments.mjs';

test('requires --version', () => {
  assert.throws(() => parseArgs(['--fault', 'enabled']), /--version is required/);
});

test('rejects an empty --version', () => {
  assert.throws(() => parseArgs(['--version', '']), /--version must not be empty/);
});

test('rejects an unknown fault value', () => {
  assert.throws(() => parseArgs(['--version', 'x', '--fault', 'on']), /--fault must be enabled or disabled/);
});

test('rejects an empty environment', () => {
  assert.throws(() => parseArgs(['--version', 'x', '--environment', '']), /--environment must not be empty/);
});

test('defaults environment to local and fault to disabled', () => {
  assert.deepEqual(parseArgs(['--version', '0.2.0']), { version: '0.2.0', environment: 'local', fault: 'disabled' });
});

test('accepts an explicit environment and fault', () => {
  assert.deepEqual(
    parseArgs(['--version', '0.2.0-faulty', '--environment', 'staging', '--fault', 'enabled']),
    { version: '0.2.0-faulty', environment: 'staging', fault: 'enabled' },
  );
});

test('builds the deployment event exactly per spec 8.4', () => {
  const event = buildDeploymentEvent({
    deploymentId: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f',
    timestamp: '2026-10-03T12:00:00.000000000Z',
    version: '0.2.0-faulty',
    environment: 'local',
  });
  assert.deepEqual(event, {
    schema_version: '1.0',
    deployment_id: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f',
    timestamp: '2026-10-03T12:00:00.000000000Z',
    service: 'demo-payments',
    environment: 'local',
    new_version: '0.2.0-faulty',
    initiated_by: 'deploy-payments-script',
    status: 'succeeded',
  });
});

test('compose env keeps the parent environment and sets exactly the four deployment variables', () => {
  const env = buildComposeEnv(
    { PATH: '/bin', HOME: '/home/u' },
    { version: '0.2.0', environment: 'local', deploymentId: 'D', fault: 'enabled' },
  );
  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/home/u',
    PAYMENTS_VERSION: '0.2.0',
    DEPLOYMENT_ENVIRONMENT: 'local',
    DEPLOYMENT_ID: 'D',
    PAYMENTS_FAULT_MODE: 'enabled',
  });
});

test('generated timestamps are UTC RFC 3339 with exactly nine fractional digits', () => {
  assert.match(utcNanosNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
});

test('a generated deployment ID is a UUIDv4', () => {
  assert.match(randomDeploymentId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
