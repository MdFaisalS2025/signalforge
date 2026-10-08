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
