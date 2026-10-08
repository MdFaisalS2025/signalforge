// Tests for the evidence-cited diagnosis slice's ClickHouse accounts (docs/specs/2026-10-07-evidence-cited-diagnosis.md,
// sections 8.1 and 8.5).
//
// These check the Compose ClickHouse service. They start nothing: they wait, with a bound, for ClickHouse to answer.
// Every child process uses an argument array and no shell. The denied-insert probes insert zero rows (`WHERE 0`), so
// even an over-privileged account could not write data through them: privileges are checked before any row exists.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = 'infra/docker/docker-compose.yml';
const AGENT = 'agent_writer';
const READER = 'dashboard_reader';
const PASSWORD = 'changeme-local-only'; // the existing local-only convention
const ADMIN = 'default';
const READY_DEADLINE_MS = 120_000;
const READY_POLL_MS = 2_000;
const CALL_TIMEOUT_MS = 30_000;

const DENIED = /ACCESS_DENIED|Not enough privileges/;

// Runs clickhouse-client inside the running clickhouse service and returns its exit code and output.
async function clickhouse(user, password, queryArgs) {
  const args = ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'clickhouse', 'clickhouse-client',
    '--user', user, '--password', password, ...queryArgs];
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { cwd: REPO, timeout: CALL_TIMEOUT_MS, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  }
}

const asAgent = (sql) => clickhouse(AGENT, PASSWORD, ['--query', sql]);
const asReader = (sql) => clickhouse(READER, PASSWORD, ['--query', sql]);
const asAdmin = (sql) => clickhouse(ADMIN, PASSWORD, ['--query', sql]);

// Waits until the default account answers SELECT 1. Bounded: fails with the last error if ClickHouse never answers.
// It does not wait for migration 2, so a missing account or table fails the tests with its own error.
async function waitForClickHouse() {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let last = { stderr: 'no attempt made' };
  while (Date.now() < deadline) {
    last = await asAdmin('SELECT 1');
    if (last.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  assert.fail(`ClickHouse did not answer within ${READY_DEADLINE_MS}ms. Last error: ${last.stderr.trim()}`);
}

describe('agent_writer account (needs ClickHouse)', () => {
  before(waitForClickHouse, { timeout: READY_DEADLINE_MS + 30_000 });

  // ---- Allowed ----

  test('agent_writer can read the incidents table', async () => {
    const result = await asAgent('SELECT count() FROM signalforge.incidents');
    assert.equal(result.code, 0, `SELECT as ${AGENT} failed: ${result.stderr.trim()}`);
    assert.match(result.stdout.trim(), /^\d+$/, `expected a count, got: ${result.stdout.trim()}`);
  });

  test('agent_writer can read telemetry_events', async () => {
    const result = await asAgent('SELECT count() FROM signalforge.telemetry_events');
    assert.equal(result.code, 0, `SELECT as ${AGENT} failed: ${result.stderr.trim()}`);
    assert.match(result.stdout.trim(), /^\d+$/);
  });

  test('agent_writer can read every table the agent needs: evidence_items, deployments, and diagnoses', async () => {
    for (const table of ['evidence_items', 'deployments', 'diagnoses']) {
      const result = await asAgent(`SELECT count() FROM signalforge.${table}`);
      assert.equal(result.code, 0, `SELECT from ${table} as ${AGENT} failed: ${result.stderr.trim()}`);
      assert.match(result.stdout.trim(), /^\d+$/, table);
    }
  });

  test('agent_writer can insert into diagnoses (a zero-row write is accepted)', async () => {
    const result = await asAgent('INSERT INTO signalforge.diagnoses (diagnosis_id) SELECT generateUUIDv4() WHERE 0');
    assert.equal(result.code, 0, `INSERT into diagnoses as ${AGENT} failed: ${result.stderr.trim()}`);
  });

  // ---- Denied: every other write, DDL, and system read ----

  for (const table of ['incidents', 'evidence_items', 'deployments']) {
    const column = table === 'incidents' ? 'incident_id' : table === 'evidence_items' ? 'evidence_id' : 'deployment_id';
    test(`agent_writer cannot insert into ${table}`, async () => {
      const result = await asAgent(`INSERT INTO signalforge.${table} (${column}) SELECT generateUUIDv4() WHERE 0`);
      assert.notEqual(result.code, 0, `INSERT into ${table} was accepted for ${AGENT}`);
      assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
    });
  }

  test('agent_writer cannot insert into telemetry_events or the migration table', async () => {
    for (const [table, column] of [['telemetry_events', 'event_id'], ['schema_migrations', 'version']]) {
      const value = column === 'version' ? 'toUInt32(99)' : 'generateUUIDv4()';
      const result = await asAgent(`INSERT INTO signalforge.${table} (${column}) SELECT ${value} WHERE 0`);
      assert.notEqual(result.code, 0, `INSERT into ${table} was accepted for ${AGENT}`);
      assert.match(result.stderr, DENIED, `${table}: ${result.stderr.trim()}`);
    }
  });

  test('agent_writer cannot alter diagnoses', async () => {
    const result = await asAgent('ALTER TABLE signalforge.diagnoses ADD COLUMN x String');
    assert.notEqual(result.code, 0, `ALTER was accepted for ${AGENT}`);
    assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  test('agent_writer cannot drop diagnoses', async () => {
    const result = await asAgent('DROP TABLE signalforge.diagnoses');
    assert.notEqual(result.code, 0, `DROP was accepted for ${AGENT}`);
    assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  test('agent_writer cannot truncate, create, delete from, or grant on anything', async () => {
    const statements = [
      'TRUNCATE TABLE signalforge.diagnoses',
      'CREATE TABLE signalforge.agent_probe (x UInt8) ENGINE = Memory',
      'ALTER TABLE signalforge.diagnoses DELETE WHERE 0',
      'GRANT SELECT ON signalforge.* TO agent_writer',
      'SYSTEM FLUSH LOGS',
    ];
    for (const sql of statements) {
      const result = await asAgent(sql);
      assert.notEqual(result.code, 0, `${sql} was accepted for ${AGENT}`);
      assert.match(result.stderr, DENIED, `${sql}: ${result.stderr.trim()}`);
    }
  });

  test('agent_writer is denied a read of system.query_log', async () => {
    const result = await asAgent('SELECT * FROM system.query_log LIMIT 1');
    assert.notEqual(result.code, 0, `read of system.query_log was allowed for ${AGENT}: ${result.stdout.trim()}`);
    assert.match(result.stderr, DENIED, `expected an access-denied rejection, got: ${result.stderr.trim()}`);
  });

  // ---- Exactly these grants and these limits, nothing broader ----

  // access_type is an enum, so ClickHouse's ORDER BY does not sort it alphabetically. Compare exact sorted sets instead.
  test('agent_writer holds exactly the five SELECT grants and the one INSERT grant', async () => {
    const result = await asAdmin(`SELECT access_type, database, table FROM system.grants WHERE user_name = '${AGENT}' FORMAT TSV`);
    assert.equal(result.code, 0, `could not read the grants: ${result.stderr.trim()}`);
    const rows = result.stdout.trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(rows, [
      'INSERT\tsignalforge\tdiagnoses',
      'SELECT\tsignalforge\tdeployments',
      'SELECT\tsignalforge\tdiagnoses',
      'SELECT\tsignalforge\tevidence_items',
      'SELECT\tsignalforge\tincidents',
      'SELECT\tsignalforge\ttelemetry_events',
    ].sort());
    assert.equal(rows.length, 6, 'no grant beyond the six named ones');
  });

  test('agent_writer runs under a non-readonly profile with the documented limits', async () => {
    const result = await asAgent("SELECT getSetting('readonly'), getSetting('max_execution_time'), getSetting('max_rows_to_read'), getSetting('max_result_rows') FORMAT TSV");
    assert.equal(result.code, 0, `could not read the settings: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), '0\t10\t5000000\t1000');
  });

  test('agent_writer is limited to the signalforge database', async () => {
    const result = await asAgent("SELECT count() FROM system.tables WHERE database != 'signalforge'");
    assert.equal(result.code, 0, `catalog read failed: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), '0', `catalog exposes ${result.stdout.trim()} entries outside signalforge`);
  });
});

describe('dashboard_reader and the diagnoses table (needs ClickHouse)', () => {
  before(waitForClickHouse, { timeout: READY_DEADLINE_MS + 30_000 });

  test('dashboard_reader can read the diagnoses table', async () => {
    const result = await asReader('SELECT count() FROM signalforge.diagnoses');
    assert.equal(result.code, 0, `SELECT as ${READER} failed: ${result.stderr.trim()}`);
    assert.match(result.stdout.trim(), /^\d+$/, `expected a count, got: ${result.stdout.trim()}`);
  });

  // The readonly profile must reject the write by name, so a missing account or table cannot pass.
  test('dashboard_reader cannot insert into diagnoses', async () => {
    const result = await asReader('INSERT INTO signalforge.diagnoses (diagnosis_id) SELECT generateUUIDv4() WHERE 0');
    assert.notEqual(result.code, 0, 'INSERT into diagnoses was accepted for the read-only account');
    assert.match(result.stderr, /READONLY|readonly/, `expected a read-only rejection, got: ${result.stderr.trim()}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The agent-python Compose service (docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 10).
// The resolved-configuration and file checks below need Docker's CLI but no running stack and no ClickHouse.

const COMPOSE_JSON_TIMEOUT_MS = 60_000;

// Resolves the Compose file the way `docker compose up` would. AGENT_* variables are removed from the environment unless
// a test supplies them, so the defaults are what is asserted, not whatever the developer's shell happens to export.
async function resolvedCompose(extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_')));
  const { stdout } = await execFileAsync('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
    cwd: REPO,
    env: { ...env, ...extraEnv },
    timeout: COMPOSE_JSON_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

// Compose prints durations either as nanoseconds or as text such as "5s".
function seconds(value) {
  if (typeof value === 'number') return value / 1e9;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(String(value));
  assert.ok(match, `unreadable duration: ${value}`);
  return Number(match[1]) * { ms: 0.001, s: 1, m: 60 }[match[2]];
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

describe('agent-python Compose service (resolved configuration)', () => {
  let config;
  let service;

  before(async () => {
    config = await resolvedCompose();
    service = config.services['agent-python'];
  }, { timeout: COMPOSE_JSON_TIMEOUT_MS + 5_000 });

  test('it is built from the repository root with exactly the agent Dockerfile, not a placeholder image', () => {
    assert.ok(service, 'the agent-python service must exist');
    assert.ok(service.build, 'agent-python needs a build configuration');
    assert.ok(samePath(service.build.context, REPO), `build context is ${service.build.context}, want ${REPO}`);
    assert.equal(service.build.dockerfile, 'services/agent-python/Dockerfile');
    assert.ok(!JSON.stringify(service).includes('alpine'), 'no alpine placeholder image');
    assert.ok(!service.command, 'no command override: the image entrypoint runs the agent');
    assert.ok(!service.entrypoint, 'no entrypoint override');
  });

  test('it publishes no port and exposes none', () => {
    assert.ok(service.ports === undefined || service.ports.length === 0, `ports: ${JSON.stringify(service.ports)}`);
    assert.ok(service.expose === undefined || service.expose.length === 0);
  });

  test('it waits for a healthy ClickHouse and a started collector-go, and never for Temporal', () => {
    assert.deepEqual(Object.keys(service.depends_on).sort(), ['clickhouse', 'collector-go']);
    assert.equal(service.depends_on.clickhouse.condition, 'service_healthy');
    assert.equal(service.depends_on['collector-go'].condition, 'service_started');
    assert.ok(!('temporal' in service.depends_on));
  });

  test('its filesystem is read-only with a writable /tmp tmpfs, and it holds no capabilities or privileges', () => {
    assert.equal(service.read_only, true);
    assert.deepEqual(service.tmpfs, ['/tmp']);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.ok(service.security_opt.includes('no-new-privileges:true'), JSON.stringify(service.security_opt));
    assert.ok(!service.cap_add || service.cap_add.length === 0, 'no capability may be added back');
    for (const field of ['privileged', 'network_mode', 'pid', 'ipc', 'devices', 'volumes', 'extra_hosts', 'sysctls', 'userns_mode']) {
      assert.ok(!service[field] || (Array.isArray(service[field]) && service[field].length === 0), `${field} must not be set`);
    }
  });

  test('it never restarts on its own, like every service in this repository', () => {
    assert.equal(service.restart, 'no');
  });

  test('its environment is exactly the approved set with local-only credentials and deterministic defaults', () => {
    assert.deepEqual(service.environment, {
      CLICKHOUSE_URL: 'http://clickhouse:8123',
      CLICKHOUSE_DATABASE: 'signalforge',
      CLICKHOUSE_USER: 'agent_writer',
      CLICKHOUSE_PASSWORD: 'changeme-local-only',
      AGENT_PROVIDER: 'deterministic',
      AGENT_POLL_INTERVAL_S: '2',
      AGENT_BATCH_SIZE: '5',
      AGENT_REVISION_POLICY: 'first-only',
      AGENT_PROVIDER_BASE_URL: '',
      AGENT_PROVIDER_MODEL: '',
      AGENT_PROVIDER_API_KEY: '',
      AGENT_PROVIDER_ALLOW_EXTERNAL: 'no',
    });
  });

  test('the provider API key resolves to the empty string by default and only a variable you set can fill it', async () => {
    assert.equal(service.environment.AGENT_PROVIDER_API_KEY, '');
    const supplied = (await resolvedCompose({ AGENT_PROVIDER_API_KEY: 'sentinel-supplied-by-the-caller' })).services['agent-python'];
    assert.equal(supplied.environment.AGENT_PROVIDER_API_KEY, 'sentinel-supplied-by-the-caller');
    assert.equal(supplied.environment.AGENT_PROVIDER, 'deterministic', 'a key alone does not switch the provider');
  });

  test('the health check runs the heartbeat command with the approved timing', () => {
    assert.deepEqual(service.healthcheck.test, ['CMD', 'python', '-m', 'signalforge_agent', 'healthcheck']);
    assert.equal(seconds(service.healthcheck.interval), 5);
    assert.equal(seconds(service.healthcheck.timeout), 3);
    assert.equal(service.healthcheck.retries, 5);
  });

  test('only the placeholder was replaced: every other service keeps its shape', () => {
    for (const name of ['remediation', 'api', 'demo-inventory']) {
      assert.equal(config.services[name].image, 'alpine:3.20', name);
      assert.deepEqual(config.services[name].command, ['sleep', 'infinity'], name);
    }
    assert.deepEqual(
      config.services.web.ports.map((port) => `${port.host_ip}:${port.published}->${port.target}`),
      ['127.0.0.1:3000->3000'],
    );
    const mounts = config.services.clickhouse.volumes.filter((volume) => volume.type === 'bind').map((volume) => path.basename(volume.source));
    assert.deepEqual(mounts.sort(), ['agent-writer.xml', 'dashboard-reader.xml']);
    assert.ok(samePath(config.services['collector-go'].build.context, path.join(REPO, 'services', 'collector-go')));
    for (const [name, other] of Object.entries(config.services)) {
      assert.ok(!('agent-python' in (other.depends_on ?? {})), `${name} must not depend on agent-python`);
    }
  });
});

describe('agent-python image definition (static file checks)', () => {
  let dockerfile;
  let stages;

  before(async () => {
    dockerfile = await readFile(path.join(REPO, 'services', 'agent-python', 'Dockerfile'), 'utf8');
    stages = Object.fromEntries(
      dockerfile.split(/^FROM /m).slice(1).map((block) => [/ AS (\w+)/.exec(block.split('\n')[0])[1], 'FROM ' + block]),
    );
  });

  const instructions = (stage) => stage.split('\n').filter((line) => /^[A-Z]+ /.test(line));

  test('the pinned Python image argument and the Docker-only test stage are kept', () => {
    assert.equal(dockerfile.match(/^ARG PYTHON_IMAGE=/gm).length, 1);
    assert.match(dockerfile, /^ARG PYTHON_IMAGE=python:3\.12-slim@sha256:[0-9a-f]{64}$/m);
    assert.deepEqual(Object.keys(stages), ['deps', 'runtime']);
    assert.match(stages.deps, /^FROM \$\{PYTHON_IMAGE\} AS deps$/m);
    assert.match(stages.deps, /COPY services\/agent-python\/requirements\.txt/);
    assert.ok(!/signalforge_agent|ENTRYPOINT|USER /.test(stages.deps), 'the test stage has no application behavior');
  });

  test('the runtime stage starts from the same pinned image and is the last stage, so Compose builds it', () => {
    assert.match(stages.runtime, /^FROM \$\{PYTHON_IMAGE\} AS runtime$/m);
    assert.equal(Object.keys(stages).at(-1), 'runtime');
  });

  test('the runtime stage copies only the requirements, the agent source, and the diagnosis schema', () => {
    const copies = instructions(stages.runtime).filter((line) => /^(COPY|ADD) /.test(line));
    assert.deepEqual(copies.sort(), [
      'COPY contracts/events/diagnosis.schema.json /app/contracts/events/diagnosis.schema.json',
      'COPY services/agent-python/requirements.txt /tmp/requirements.txt',
      'COPY services/agent-python/src /app/src',
    ]);
  });

  test('it installs the pinned requirements, imports from /app/src, and writes no bytecode', () => {
    assert.match(stages.runtime, /pip install -r \/tmp\/requirements\.txt/);
    assert.match(stages.runtime, /PYTHONPATH=\/app\/src/);
    assert.match(stages.runtime, /PYTHONDONTWRITEBYTECODE=1/);
    assert.match(stages.runtime, /PYTHONUNBUFFERED=1/);
  });

  test('it runs as a dedicated non-root user and starts the agent through the exact entrypoint', () => {
    assert.match(stages.runtime, /^USER 10001:10001$/m);
    assert.ok(!/^USER (root|0)\b/m.test(stages.runtime));
    assert.match(stages.runtime, /^ENTRYPOINT \["python", "-m", "signalforge_agent", "run"\]$/m);
    assert.ok(!/^CMD /m.test(stages.runtime), 'no default command to append');
  });

  test('it adds no shell tools, package managers, source-control clients, or debugging utilities', () => {
    // Every line of the stage, including lines continued after a backslash, apart from comments.
    const body = stages.runtime.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    for (const forbidden of ['apt-get', 'apt', 'apk', 'yum', 'dnf', 'curl', 'wget', 'git', 'ssh', 'gdb', 'strace', 'vim', 'nano', 'sudo', 'netcat', 'nc', 'bash', 'sh', 'busybox']) {
      assert.ok(!new RegExp(`(^|[\\s&;|"'/])${forbidden}($|[\\s&;|"'])`).test(body), `the runtime stage must not use ${forbidden}`);
    }
    assert.ok(!/chmod\s+(-R\s+)?[0-7]*7[0-7]*7\b/.test(body), 'no world-writable permissions');
  });

  test('the build context allowlist admits exactly the three paths the image copies', async () => {
    const ignore = await readFile(path.join(REPO, 'services', 'agent-python', 'Dockerfile.dockerignore'), 'utf8');
    const patterns = ignore.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    assert.equal(patterns[0], '*', 'everything is excluded first');
    assert.deepEqual(patterns.filter((line) => line.startsWith('!')).sort(), [
      '!contracts/events/diagnosis.schema.json',
      '!services/agent-python/requirements.txt',
      '!services/agent-python/src',
    ]);
    assert.ok(patterns.every((line) => line === '*' || line.startsWith('!') || /__pycache__|\.py[co]$/.test(line)), patterns.join(' | '));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The running container. These need the Compose stack with agent-python started and skip when it is not running.

const HEALTH_DEADLINE_MS = 60_000;
const HEALTH_POLL_MS = 2_000;
const ALLOWED_LOG_KEYS = new Set(['level', 'message', 'incident_id', 'attempt', 'error_class']);
const PROBE_INCIDENT_ID = '00000000-0000-4000-8000-0000000d1a60';

async function compose(args, timeout = 60_000) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: REPO, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  }
}

describe('agent-python container (needs the running stack)', () => {
  let containerId = '';

  before(async () => {
    containerId = (await compose(['ps', '-q', 'agent-python'])).stdout.trim();
  });

  const needsContainer = (t) => {
    if (!containerId) {
      t.skip('agent-python is not running; start it with `docker compose up -d --build agent-python`');
      return false;
    }
    return true;
  };

  async function inspect(format) {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', format, containerId], { timeout: 30_000, windowsHide: true });
    return stdout.trim();
  }

  test('it becomes healthy within 60 seconds', async (t) => {
    if (!needsContainer(t)) return;
    const deadline = Date.now() + HEALTH_DEADLINE_MS;
    let health = '';
    while (Date.now() < deadline) {
      health = await inspect('{{.State.Health.Status}}');
      if (health === 'healthy') break;
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    assert.equal(health, 'healthy', `agent-python was ${health} after ${HEALTH_DEADLINE_MS}ms`);
  }, { timeout: HEALTH_DEADLINE_MS + 15_000 });

  test('it publishes no host port', async (t) => {
    if (!needsContainer(t)) return;
    // No EXPOSE in the image and no ports in Compose, so both maps are empty.
    assert.ok(['{}', 'null'].includes(await inspect('{{json .NetworkSettings.Ports}}')), await inspect('{{json .NetworkSettings.Ports}}'));
    assert.ok(['{}', 'null'].includes(await inspect('{{json .HostConfig.PortBindings}}')), await inspect('{{json .HostConfig.PortBindings}}'));
  });

  test('it runs as a non-root user with a read-only filesystem, no capabilities, and no-new-privileges', async (t) => {
    if (!needsContainer(t)) return;
    assert.equal(await inspect('{{.Config.User}}'), '10001:10001');
    const { stdout } = await execFileAsync('docker', ['exec', containerId, 'python', '-c', 'import os; print(os.getuid(), os.getgid())'], { timeout: 30_000, windowsHide: true });
    assert.equal(stdout.trim(), '10001 10001');
    assert.equal(await inspect('{{.HostConfig.ReadonlyRootfs}}'), 'true');
    assert.equal(await inspect('{{json .HostConfig.CapDrop}}'), '["ALL"]');
    assert.match(await inspect('{{json .HostConfig.SecurityOpt}}'), /no-new-privileges:true/);
    assert.equal(await inspect('{{.Config.Entrypoint}}'), '[python -m signalforge_agent run]');
  });

  test('its logs are JSON objects only and leak no password, key, SQL, or Authorization text', async (t) => {
    if (!needsContainer(t)) return;
    const { stdout, stderr } = await compose(['logs', '--no-log-prefix', 'agent-python']);
    const lines = `${stdout}\n${stderr}`.split('\n').filter((line) => line.trim());
    assert.ok(lines.length > 0, 'the agent logged nothing');
    for (const line of lines) {
      const record = JSON.parse(line);
      assert.ok(record && typeof record === 'object' && !Array.isArray(record), line);
      for (const key of Object.keys(record)) assert.ok(ALLOWED_LOG_KEYS.has(key), `unexpected log key ${key}`);
    }
    const text = lines.join('\n');
    for (const forbidden of [PASSWORD, 'Authorization', 'X-ClickHouse-Key', 'SELECT', 'Code:', 'INSERT', 'FORMAT JSONEachRow']) {
      assert.ok(!text.includes(forbidden), `the logs contain ${forbidden}`);
    }
  });

  test('it never diagnoses the retained integration probe row or anything that is not a published incident', async (t) => {
    if (!needsContainer(t)) return;
    const probe = await asAdmin(`SELECT count(), max(diagnosis_version) FROM signalforge.diagnoses WHERE incident_id = '${PROBE_INCIDENT_ID}' FORMAT TSV`);
    assert.equal(probe.stdout.trim(), '1\t1', `the probe row changed: ${probe.stdout.trim()} ${probe.stderr.trim()}`);
    const orphans = await asAdmin(
      'SELECT count() FROM signalforge.diagnoses WHERE incident_id NOT IN (SELECT incident_id FROM signalforge.incidents) '
        + `AND incident_id != '${PROBE_INCIDENT_ID}'`,
    );
    assert.equal(orphans.stdout.trim(), '0', 'a diagnosis exists for something that is not an incident');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The acceptance script (docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 12.2).
// These need no Docker and no ClickHouse. In-process HTTP stubs stand in for the dashboard through the script's base
// URL (DASHBOARD_BASE_URL), and the Docker-backed probes are replaced by fakes passed in the context.

import http from 'node:http';
import {
  STEPS,
  DIAGNOSIS_DEADLINE_MS,
  diagnosisIdFor,
  parseIncidentIdArg,
  pollUntil,
  runAcceptance,
} from './verify-evidence-cited-diagnosis.mjs';

const SAMPLE = JSON.parse(await readFile(path.join(REPO, 'contracts', 'events', 'samples', 'diagnosis.sample.json'), 'utf8'));
const A_INCIDENT = SAMPLE.incident_id;
const A_DEPLOYMENT = '57d9bf44-46c0-46e9-8140-4a7b9f3694a8';
const CITED = [...new Set([
  ...SAMPLE.supporting_claims.flatMap((claim) => claim.evidence_ids),
  ...SAMPLE.alternative_hypotheses.flatMap((alt) => alt.disconfirming_evidence_ids),
])];
const NOT_EXECUTED = 'Recommendation only. Nothing was executed. Approval arrives in a later slice.';

// What React writes for a text node.
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const clone = (value) => JSON.parse(JSON.stringify(value));

function detailPage(state) {
  const doc = state.diagnosis;
  const chips = (ids) => ids.map((id) => `<a class="chip" href="#evidence-${id}" title="${id}">trace ${id.slice(0, 8)}</a>`).join('');
  const rows = state.evidence.map((row) => `<tr id="evidence-${row.evidence_id}"><td>${row.source_type}</td></tr>`).join('');
  return `<html><body><section class="diagnosis"><h2 id="diagnosis-heading">Diagnosis</h2>`
    + `<p class="cause-label">${state.pageCauseLabel ?? 'Likely cause'}</p><p class="cause">${esc(doc.primary_hypothesis)}</p>`
    + `<ol class="claims">${doc.supporting_claims.map((claim) => `<li>${esc(claim.claim)}${chips(state.pageChips ?? claim.evidence_ids)}</li>`).join('')}</ol>`
    + `<aside class="recommendation"><p>${state.pageNotice ?? NOT_EXECUTED}</p>${state.pageRecommendationExtra ?? ''}</aside>`
    + `</section>${state.pageExtra ?? ''}<table>${state.pageRows ?? rows}</table></body></html>`;
}

function listPage(state) {
  return `<html><body><table><tr><td><a class="mono" href="/incidents/${A_INCIDENT}">${A_INCIDENT}</a></td>`
    + `<td><span class="status" data-diagnosis="${state.listWord ?? 'high'}"><span class="dot" aria-hidden="true"></span>${state.listWord ?? 'high'}</span></td></tr></table></body></html>`;
}

function acceptanceState() {
  return {
    health: [200, { status: 'ok' }],
    evidence: CITED.map((id) => ({ evidence_id: id, source_type: 'trace', source_ref: `trace-${id.slice(0, 4)}`, reliability: 'high' })),
    deployment: { deployment_id: A_DEPLOYMENT, new_version: '0.2.0-faulty' },
    diagnosis: { ...clone(SAMPLE), state: 'completed' },
    deployments: [{ deployment_id: A_DEPLOYMENT }],
    detailCalls: 0,
    pendingPolls: 0,
  };
}

async function startAcceptanceStub(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (url.pathname === '/api/health') return json(...state.health);
    if (url.pathname === '/api/incidents') return json(200, { incidents: [{ incident_id: A_INCIDENT }] });
    if (url.pathname === `/api/incidents/${A_INCIDENT}`) {
      state.detailCalls += 1;
      const pending = state.pendingPolls > 0;
      if (pending) state.pendingPolls -= 1;
      if (state.leak) return json(200, state.leak);
      return json(200, {
        incident: { incident_id: A_INCIDENT },
        evidence: state.evidence,
        deployment: state.deployment,
        diagnosis: pending ? null : state.diagnosis,
      });
    }
    if (url.pathname === '/api/deployments') return json(200, { deployments: state.deployments });
    if (url.pathname === `/incidents/${A_INCIDENT}`) return html(detailPage(state));
    if (url.pathname === '/incidents') return html(listPage(state));
    return json(404, { error: 'nope' });
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

// Probes that touch Docker are fakes here. The default stored row is one row and one document, before and after.
function fakeProbes(state, overrides = {}) {
  const stored = { count: 1, document: JSON.stringify(SAMPLE) };
  return {
    accounts: async () => ({ ok: true, detail: 'fake account probes passed' }),
    storedDiagnosis: async () => ({ ...stored }),
    restartAgent: async () => {},
    agentHealthy: async () => true,
    agentLogs: async () => '{"level":"info","message":"cycle complete"}\n',
    ...overrides,
  };
}

async function runWith(state, { probes = {}, ...context } = {}) {
  const stub = await startAcceptanceStub(state);
  try {
    return await runAcceptance({
      baseUrl: stub.baseUrl,
      incidentId: A_INCIDENT,
      pollIntervalMs: 5,
      diagnosisDeadlineMs: 2_000,
      probes: fakeProbes(state, probes),
      ...context,
    });
  } finally {
    await stub.close();
  }
}

describe('verify-evidence-cited-diagnosis: steps and happy path', () => {
  test('the twelve steps are exported, numbered, and in the spec order', () => {
    assert.deepEqual(STEPS.map((step) => step.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(new Set(STEPS.map((step) => step.id)).size, 12);
    assert.ok(STEPS.every((step) => typeof step.name === 'string' && step.name.length > 0));
    assert.equal(DIAGNOSIS_DEADLINE_MS, 60_000);
  });

  test('a good dashboard passes all twelve steps, each reported as it completes', async () => {
    const seen = [];
    const result = await runWith(acceptanceState(), { onStep: (step) => seen.push(`${step.n} ${step.status}`) });
    assert.equal(result.ok, true, JSON.stringify(result.steps.filter((s) => s.status === 'fail')));
    assert.equal(result.steps.length, 12);
    assert.deepEqual(seen, STEPS.map((step) => `${step.n} pass`));
    assert.equal(result.failed, null);
  });

  test('the diagnosis ID check uses the documented UUIDv5', () => {
    assert.equal(diagnosisIdFor(SAMPLE.incident_id, SAMPLE.diagnosis_version), SAMPLE.diagnosis_id);
  });

  test('--incident-id is validated: only a UUID is accepted, and it is lower-cased', () => {
    assert.equal(parseIncidentIdArg(A_INCIDENT.toUpperCase()), A_INCIDENT);
    for (const bad of ['', 'x', `${A_INCIDENT}; rm -rf`, `../${A_INCIDENT}`, A_INCIDENT.slice(1), `${A_INCIDENT}\n`, 7]) {
      assert.throws(() => parseIncidentIdArg(bad), /incident-id/, String(bad));
    }
  });

  test('without --incident-id, the newest incident from the list is used', async () => {
    const result = await runWith(acceptanceState(), { incidentId: undefined });
    assert.equal(result.ok, true);
  });

  test('a diagnosis that appears after a few polls is waited for, not slept for', async () => {
    const state = acceptanceState();
    state.pendingPolls = 3;
    const result = await runWith(state);
    assert.equal(result.ok, true);
    assert.ok(state.detailCalls >= 4, `expected polling, got ${state.detailCalls} detail reads`);
  });

  test('a diagnosis that never appears fails step 3 at the deadline', async () => {
    const state = acceptanceState();
    state.pendingPolls = Number.MAX_SAFE_INTEGER;
    const started = Date.now();
    const result = await runWith(state, { diagnosisDeadlineMs: 300 });
    assert.equal(result.failed.n, 3);
    assert.match(result.failed.detail, /deadline|within/);
    assert.ok(Date.now() - started < 3_000);
  });

  test('an abstained, failed, or unavailable diagnosis fails step 3 by state', async () => {
    for (const diagnosis of [{ state: 'abstained' }, { state: 'failed' }, { state: 'unavailable' }]) {
      const state = acceptanceState();
      state.diagnosis = diagnosis;
      const result = await runWith(state);
      assert.equal(result.failed.n, 3, diagnosis.state);
    }
  });

  test('a dashboard that is down fails step 1 and stops there', async () => {
    const state = acceptanceState();
    state.health = [503, { error: 'clickhouse_unavailable' }];
    const result = await runWith(state);
    assert.equal(result.failed.n, 1);
    assert.equal(result.steps.length, 1, 'the run stops at the first failure');
  });
});

describe('verify-evidence-cited-diagnosis: each failure is attributed to its step', () => {
  async function failsAt(n, mutate, context) {
    const state = acceptanceState();
    mutate(state);
    const result = await runWith(state, context);
    assert.equal(result.ok, false);
    assert.equal(result.failed?.n, n, `expected step ${n}, got ${JSON.stringify(result.failed)}`);
    assert.equal(result.steps.at(-1).n, n, 'no step runs after the failure');
    return result;
  }

  test('a citation outside the incident evidence fails step 5', async () => {
    await failsAt(5, (state) => {
      state.diagnosis.supporting_claims[0].evidence_ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff'];
    });
    await failsAt(5, (state) => {
      state.diagnosis.alternative_hypotheses[0].disconfirming_evidence_ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff'];
    });
  });

  test('executable: true fails step 4', async () => {
    await failsAt(4, (state) => {
      state.diagnosis.remediation_recommendation.executable = true;
    });
  });

  test('a contract violation fails step 4: version, identity, enum, bound, and extra field', async () => {
    const mutations = [
      (d) => { d.schema_version = '1.0'; },
      (d) => { d.diagnosis_id = 'c03997a4-e1ef-5a94-8a2e-62d9694d7643'; },
      (d) => { d.incident_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; },
      (d) => { d.confidence.value = 'certain'; },
      (d) => { d.reasoning_summary = 'x'.repeat(1201); },
      (d) => { d.extra = 1; },
      (d) => { d.remediation_recommendation.requires_approval = false; },
      (d) => { d.supporting_claims = []; },
      (d) => { d.supporting_claims[0].kind = 'made_up'; },
      (d) => { delete d.primary_hypothesis; },
    ];
    for (const mutate of mutations) await failsAt(4, (state) => mutate(state.diagnosis));
  });

  test('a hypothesis without the deployment ID, without the version, or with low confidence fails step 6', async () => {
    await failsAt(6, (state) => {
      state.diagnosis.primary_hypothesis = state.diagnosis.primary_hypothesis.replaceAll(A_DEPLOYMENT, 'unknown');
    });
    await failsAt(6, (state) => {
      state.diagnosis.primary_hypothesis = state.diagnosis.primary_hypothesis.replaceAll('0.2.0-faulty', 'a version');
    });
    await failsAt(6, (state) => {
      state.diagnosis.confidence.value = 'medium';
    });
  });

  test('a detail page that lacks the likely cause, the notice, or its chip targets fails step 7', async () => {
    await failsAt(7, (state) => { state.pageCauseLabel = 'Probably'; });
    await failsAt(7, (state) => { state.pageNotice = 'It is safe.'; });
    await failsAt(7, (state) => { state.pageChips = []; });
    await failsAt(7, (state) => { state.pageRows = ''; });
    await failsAt(7, (state) => { state.pageChips = ['ffffffff-ffff-4fff-8fff-ffffffffffff']; });
  });

  test('a button in the Recommendation panel, or a POST form on the page, fails step 7', async () => {
    await failsAt(7, (state) => { state.pageRecommendationExtra = '<button type="submit">Apply</button>'; });
    await failsAt(7, (state) => { state.pageExtra = '<form method="post" action="/x"><input></form>'; });
    await failsAt(7, (state) => { state.pageExtra = '<form action="/x" method="POST"></form>'; });
  });

  test('a button outside the Recommendation panel, such as Refresh, is allowed', async () => {
    const state = acceptanceState();
    state.pageExtra = '<form method="get" action="/incidents/x"><button type="submit">Refresh</button></form>';
    const result = await runWith(state);
    assert.equal(result.ok, true);
  });

  test('a list page without the high diagnosis indicator fails step 8', async () => {
    for (const word of ['pending', 'medium', 'failed', 'unavailable']) {
      await failsAt(8, (state) => { state.listWord = word; });
    }
  });

  test('a failed account probe fails step 9', async () => {
    await failsAt(9, () => {}, { probes: { accounts: async () => ({ ok: false, detail: 'agent_writer could drop diagnoses' }) } });
  });

  test('a changed row count or document across the restart fails step 10', async () => {
    const calls = { n: 0 };
    await failsAt(10, () => {}, {
      probes: { storedDiagnosis: async () => ({ count: (calls.n += 1) === 1 ? 1 : 2, document: JSON.stringify(SAMPLE) }) },
    });
    const docs = { n: 0 };
    await failsAt(10, () => {}, {
      probes: { storedDiagnosis: async () => ({ count: 1, document: (docs.n += 1) === 1 ? '{"a":1}' : '{"a":2}' }) },
    });
    await failsAt(10, () => {}, { probes: { storedDiagnosis: async () => ({ count: 0, document: '' }) } });
  });

  test('an agent that never becomes healthy after the restart fails step 10 at a bound', async () => {
    const started = Date.now();
    await failsAt(10, () => {}, { probes: { agentHealthy: async () => false }, healthDeadlineMs: 250 });
    assert.ok(Date.now() - started < 3_000);
  });

  test('SELECT, Code:, the password, or Authorization in any body or log fails step 11', async () => {
    for (const marker of ['SELECT 1', 'Code: 62', 'changeme-local-only', 'Authorization: Basic']) {
      await failsAt(11, (state) => { state.pageExtra = `<p>${marker}</p>`; });
    }
    await failsAt(11, () => {}, { probes: { agentLogs: async () => '{"message":"Code: 210"}\n' } });
    await failsAt(11, () => {}, { probes: { agentLogs: async () => 'password changeme-local-only' } });
    await failsAt(11, () => {}, { probes: { agentLogs: async () => 'Authorization' } });
  });

  test('a leak detail names the marker class but never echoes the body', async () => {
    const result = await failsAt(11, () => {}, { probes: { agentLogs: async () => 'Authorization: Basic c2VjcmV0' } });
    assert.ok(!result.failed.detail.includes('c2VjcmV0'));
    assert.ok(!result.failed.detail.includes('Basic'));
  });
});

test('step 12: a deployment created during the restart window fails the run at step 12', async () => {
  const state = acceptanceState();
  const result = await runWith(state, {
    probes: {
      restartAgent: async () => {
        state.deployments = [{ deployment_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, ...state.deployments];
      },
    },
  });
  assert.equal(result.failed?.n, 12, JSON.stringify(result.failed));
  assert.equal(result.steps.filter((step) => step.status === 'pass').length, 11);
});

test('step 12: an unchanged deployment list passes', async () => {
  const result = await runWith(acceptanceState());
  assert.equal(result.steps.at(-1).n, 12);
  assert.equal(result.steps.at(-1).status, 'pass');
});

describe('pollUntil', () => {
  // A virtual clock: sleeping advances time instantly and records the requested delay.
  function fakeClock() {
    const clock = { time: 0, delays: [], now: () => clock.time };
    clock.setTimeout = (callback, ms) => {
      clock.delays.push(ms);
      clock.time += ms;
      queueMicrotask(callback);
      return clock.delays.length;
    };
    clock.clearTimeout = () => {};
    return clock;
  }

  test('it resolves on the first truthy value, without sleeping', async () => {
    const clock = fakeClock();
    const value = await pollUntil(async () => 'ready', { deadlineMs: 1_000, intervalMs: 100, clock });
    assert.equal(value, 'ready');
    assert.deepEqual(clock.delays, []);
  });

  test('it keeps polling through falsy values and resolves on the first truthy one', async () => {
    const clock = fakeClock();
    let calls = 0;
    const value = await pollUntil(async () => (++calls === 4 ? { done: true } : null), { deadlineMs: 10_000, intervalMs: 100, clock });
    assert.deepEqual(value, { done: true });
    assert.equal(calls, 4);
    assert.deepEqual(clock.delays, [100, 100, 100]);
  });

  test('it rejects at the deadline without running past it', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(() => pollUntil(async () => (calls += 1, false), { deadlineMs: 1_000, intervalMs: 300, clock }), /deadline/);
    assert.ok(clock.time <= 1_000, `the clock reached ${clock.time}`);
    assert.deepEqual(clock.delays, [300, 300, 300, 100]);
    assert.equal(calls, 5, 'one last look exactly at the deadline');
  });

  test('it never schedules a timeout longer than intervalMs, nor longer than the time left', async () => {
    const clock = fakeClock();
    await assert.rejects(() => pollUntil(async () => false, { deadlineMs: 250, intervalMs: 1_000, clock }), /deadline/);
    assert.ok(clock.delays.every((ms) => ms <= 1_000 && ms > 0), JSON.stringify(clock.delays));
    assert.deepEqual(clock.delays, [250]);
  });

  test('it stops when cancelled, before and during a wait', async () => {
    const before = new AbortController();
    before.abort();
    await assert.rejects(() => pollUntil(async () => false, { deadlineMs: 1_000, intervalMs: 10, signal: before.signal, clock: fakeClock() }), /cancel/);

    const during = new AbortController();
    let calls = 0;
    const clock = fakeClock();
    clock.setTimeout = (callback) => {
      during.abort();
      return 1;
    };
    await assert.rejects(
      () => pollUntil(async () => (calls += 1, false), { deadlineMs: 1_000, intervalMs: 10, signal: during.signal, clock }),
      /cancel/,
    );
    assert.equal(calls, 1);
  });

  test('a throwing check is an error, not a retry', async () => {
    await assert.rejects(
      () => pollUntil(async () => { throw new Error('boom'); }, { deadlineMs: 1_000, intervalMs: 10, clock: fakeClock() }),
      /boom/,
    );
  });

  test('with the real clock it polls at the interval and stops at the deadline', async () => {
    const started = Date.now();
    await assert.rejects(() => pollUntil(async () => false, { deadlineMs: 200, intervalMs: 50 }), /deadline/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 190 && elapsed < 1_000, `elapsed ${elapsed}ms`);
  });
});
