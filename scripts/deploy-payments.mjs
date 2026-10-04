// Deploys demo-payments with a chosen version and fault mode, waits until it is healthy, and publishes a
// succeeded deployment event to deployments.v1 keyed by the deployment ID.
//
// Usage: node scripts/deploy-payments.mjs --version <v> [--environment <name>] [--fault enabled|disabled]
//
// Child processes use spawn with argument arrays and windowsHide, never a shell.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'docker', 'docker-compose.yml');
const CONTAINER = 'signalforge-demo-payments-1';
const TOPIC = 'deployments.v1';
const BROKER = 'redpanda:9092';
const HEALTH_POLL_MS = 1000;
const HEALTH_DEADLINE_MS = 60_000;

const KNOWN_FLAGS = new Set(['version', 'environment', 'fault']);

// parseArgs validates the command line and applies the defaults. It has no side effects.
export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !KNOWN_FLAGS.has(flag.slice(2))) {
      throw new Error(`unknown argument ${flag}`);
    }
    values[flag.slice(2)] = argv[i + 1];
  }

  if (!('version' in values) || values.version === undefined) {
    throw new Error('--version is required');
  }
  if (values.version === '') {
    throw new Error('--version must not be empty');
  }

  if (values.environment === '') {
    throw new Error('--environment must not be empty');
  }
  const environment = values.environment ?? 'local';

  const fault = values.fault ?? 'disabled';
  if (fault !== 'enabled' && fault !== 'disabled') {
    throw new Error('--fault must be enabled or disabled');
  }

  return { version: values.version, environment, fault };
}

// buildDeploymentEvent returns the deployments.v1 payload (spec 8.4). Its fields are fixed by the
// contract, so the caller supplies the ID and timestamp.
export function buildDeploymentEvent({ deploymentId, timestamp, version, environment }) {
  return {
    schema_version: '1.0',
    deployment_id: deploymentId,
    timestamp,
    service: 'demo-payments',
    environment,
    new_version: version,
    initiated_by: 'deploy-payments-script',
    status: 'succeeded',
  };
}

// buildComposeEnv returns the parent environment with exactly the four deployment variables set.
export function buildComposeEnv(parentEnv, { version, environment, deploymentId, fault }) {
  return {
    ...parentEnv,
    PAYMENTS_VERSION: version,
    DEPLOYMENT_ENVIRONMENT: environment,
    DEPLOYMENT_ID: deploymentId,
    PAYMENTS_FAULT_MODE: fault,
  };
}

// utcNanosNow is the current UTC time as RFC 3339 with nine fractional digits. JavaScript measures
// milliseconds, so the sub-millisecond digits are zeros, not invented precision.
export function utcNanosNow() {
  const iso = new Date().toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000000Z`;
}

export function randomDeploymentId() {
  return randomUUID();
}

// run executes a command with an argument array and no shell. It resolves with the exit code and the
// captured output. A spawn error resolves with code -1 and the error text in stderr.
function run(command, args, { env = process.env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {}); // the process may exit before reading stdin; its exit code decides
    child.stdin.end(input ?? '');
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// diagnostics prints the child's own output. It never prints the environment.
function diagnostics(result) {
  const parts = [];
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  return parts.join('\n');
}

async function waitForHealthy(deadline) {
  while (Date.now() < deadline) {
    const result = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER]);
    if (result.code === 0 && result.stdout.trim() === 'healthy') return true;
    await delay(HEALTH_POLL_MS);
  }
  return false;
}

// deploy runs the four steps in order and returns the process exit code.
export async function deploy(options, { out = process.stdout, err = process.stderr } = {}) {
  const deploymentId = randomDeploymentId();

  const recreate = await run('docker', [
    'compose', '-f', COMPOSE_FILE, 'up', '-d', '--force-recreate', '--no-deps', 'demo-payments',
  ], { env: buildComposeEnv(process.env, { ...options, deploymentId }) });
  if (recreate.code !== 0) {
    err.write(`step compose-recreate failed\n${diagnostics(recreate)}\n`);
    return 1;
  }

  const healthy = await waitForHealthy(Date.now() + HEALTH_DEADLINE_MS);
  if (!healthy) {
    err.write('step health timed out\n');
    return 1;
  }

  const event = buildDeploymentEvent({
    deploymentId,
    timestamp: utcNanosNow(),
    version: options.version,
    environment: options.environment,
  });
  const publish = await run('docker', [
    'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'redpanda',
    'rpk', 'topic', 'produce', TOPIC, '--key', deploymentId, '--brokers', BROKER,
  ], { input: `${JSON.stringify(event)}\n` });
  if (publish.code !== 0) {
    err.write(`step publish failed\n${diagnostics(publish)}\n`);
    out.write(`deployment_id=${deploymentId}\n`);
    return 1;
  }

  out.write(`deployment_id=${deploymentId}\n`);
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  return deploy(options);
}

// Run only as the entry script, so tests can import the helpers without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
