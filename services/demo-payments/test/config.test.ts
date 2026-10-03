import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resourceAttributes } from '../src/config.js';

test('defaults when no deployment variables are set', () => {
  assert.deepEqual(loadConfig({}), {
    faultMode: 'disabled',
    serviceVersion: '0.1.0',
    environment: 'local',
    deploymentId: '',
  });
});

test('reads every deployment variable', () => {
  const config = loadConfig({
    PAYMENTS_FAULT_MODE: 'enabled',
    PAYMENTS_VERSION: '0.2.0-faulty',
    DEPLOYMENT_ENVIRONMENT: 'staging',
    DEPLOYMENT_ID: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f',
  });
  assert.deepEqual(config, {
    faultMode: 'enabled',
    serviceVersion: '0.2.0-faulty',
    environment: 'staging',
    deploymentId: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f',
  });
});

test('accepts exactly enabled and disabled for the fault mode', () => {
  assert.equal(loadConfig({ PAYMENTS_FAULT_MODE: 'enabled' }).faultMode, 'enabled');
  assert.equal(loadConfig({ PAYMENTS_FAULT_MODE: 'disabled' }).faultMode, 'disabled');
});

for (const value of ['on', 'off', 'ENABLED', 'Enabled', 'true', '1', ' enabled', '']) {
  test(`rejects fault mode ${JSON.stringify(value)} with the exact message`, () => {
    assert.throws(() => loadConfig({ PAYMENTS_FAULT_MODE: value }), {
      message: 'PAYMENTS_FAULT_MODE must be enabled or disabled',
    });
  });
}

test('an empty PAYMENTS_VERSION or DEPLOYMENT_ENVIRONMENT falls back to its default', () => {
  const config = loadConfig({ PAYMENTS_VERSION: '', DEPLOYMENT_ENVIRONMENT: '' });
  assert.equal(config.serviceVersion, '0.1.0');
  assert.equal(config.environment, 'local');
});

test('omits deployment.id when DEPLOYMENT_ID is empty', () => {
  const attributes = resourceAttributes(loadConfig({ DEPLOYMENT_ID: '' }));
  assert.equal('deployment.id' in attributes, false);
  assert.equal(attributes['service.version'], '0.1.0');
  assert.equal(attributes['deployment.environment.name'], 'local');
});

test('includes deployment.id when DEPLOYMENT_ID is non-empty', () => {
  const attributes = resourceAttributes(loadConfig({ DEPLOYMENT_ID: 'x-1' }));
  assert.equal(attributes['deployment.id'], 'x-1');
});
