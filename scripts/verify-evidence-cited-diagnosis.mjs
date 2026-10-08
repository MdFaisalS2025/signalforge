// Acceptance check for the evidence-cited diagnosis slice (docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 12.2).
// Run it against the running Compose stack after a faulty deployment has produced an incident:
//
//   node scripts/verify-evidence-cited-diagnosis.mjs [--incident-id <uuid>]
//
// It checks the newest incident (or the one given) in twelve steps and stops at the first failure. It creates no
// deployment and sends no order. Its only side effect is `docker compose restart agent-python` in step 10, which
// proves a restarted agent does not rewrite a diagnosis. The account probes in step 9 are attempts that the
// restricted accounts must reject, and the grants are inspected. No check runs DDL against a real table, and the one write is a zero-row insert.
//
// Every request has a deadline, every wait is a bounded poll, and no step sleeps for a fixed expected duration.
// Child processes use argument arrays and no shell. Output is one `PASS <n> <name>` line per step and a final PASS.
// It never prints a credential, SQL, a full document, or a header; failure details are fixed wording.
//
// DASHBOARD_BASE_URL overrides the default base URL. It exists so tests and local debugging can point the script at a
// stand-in server; the default is the Compose dashboard.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify, parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export const DEFAULT_BASE_URL = 'http://localhost:3000';
export const REQUEST_TIMEOUT_MS = 5_000;
export const DIAGNOSIS_DEADLINE_MS = 60_000;
export const HEALTH_DEADLINE_MS = 60_000;
export const OVERALL_DEADLINE_MS = 300_000;
export const POLL_INTERVAL_MS = 1_000;
const CHILD_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 60_000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'docker', 'docker-compose.yml');
// The local-only password from the Compose file and the established account tests. It is never printed.
const LOCAL_PASSWORD = 'changeme-local-only';
const AGENT = 'agent_writer';
const READER = 'dashboard_reader';
// The privileged local account, used only to read grants. It is never printed.
const ADMIN = 'default';

// The fixed namespace shared by every deterministic identity in the system.
const NAMESPACE = '8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_EXECUTED = 'Recommendation only. Nothing was executed. Approval arrives in a later slice.';
const FORBIDDEN = [
  ['SELECT', 'SQL text'],
  ['Code:', 'a ClickHouse error code'],
  [LOCAL_PASSWORD, 'a credential'],
  ['Authorization', 'an authorization header'],
];

export const STEPS = Object.freeze([
  { n: 1, id: 'health', name: 'API health is 200' },
  { n: 2, id: 'incident-found', name: 'incident found' },
  { n: 3, id: 'diagnosis-completed', name: 'completed diagnosis appears within the deadline' },
  { n: 4, id: 'contract', name: 'diagnosis satisfies the v1.1 contract and is non-executable' },
  { n: 5, id: 'citations', name: 'every citation is one of the incident evidence rows' },
  { n: 6, id: 'hypothesis', name: 'hypothesis names the deployment and confidence is high' },
  { n: 7, id: 'detail-page', name: 'incident page shows the cause, chips, and a non-interactive recommendation' },
  { n: 8, id: 'list-page', name: 'incident list shows a high diagnosis' },
  { n: 9, id: 'accounts', name: 'restricted accounts can do only what they should, and hold no DDL grant' },
  { n: 10, id: 'idempotent-restart', name: 'agent restart leaves the stored diagnosis unchanged' },
  { n: 11, id: 'no-leaks', name: 'no body or log leaks SQL, driver codes, credentials, or headers' },
  { n: 12, id: 'no-remediation', name: 'Payments deployment count is unchanged' },
]);

// ---- Identity ---------------------------------------------------------------------------------------------------

// UUIDv5(NAMESPACE, "diagnosis|<incident_id>|<version>"), as services/agent-python/src/signalforge_agent/ids.py.
export function diagnosisIdFor(incidentId, version) {
  const hash = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex'))
    .update(`diagnosis|${incidentId}|${version}`, 'utf8')
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// A user-supplied incident ID must be exactly one UUID. It is lower-cased, and nothing else is accepted.
export function parseIncidentIdArg(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new Error('--incident-id must be a UUID');
  }
  return value.toLowerCase();
}

// ---- Bounded polling --------------------------------------------------------------------------------------------

const realClock = { now: () => Date.now(), setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id) };

// pollUntil calls fn until it returns a truthy value, and resolves with that value. It looks once more exactly at the
// deadline, then rejects. No single wait exceeds intervalMs or the time left, so the run never overshoots the deadline
// by a sleep. An aborted signal rejects. An error thrown by fn is not retried.
export async function pollUntil(fn, { deadlineMs, intervalMs, signal, clock = realClock }) {
  const end = clock.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) throw new Error('cancelled');
    const value = await fn();
    if (value) return value;
    const remaining = end - clock.now();
    if (remaining <= 0) throw new Error('deadline exceeded');
    await wait(Math.min(intervalMs, remaining), signal, clock);
  }
}

function wait(ms, signal, clock) {
  return new Promise((resolve, reject) => {
    let id;
    const onAbort = () => {
      clock.clearTimeout(id);
      reject(new Error('cancelled'));
    };
    id = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('cancelled'));
      else resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- HTTP with deadlines ----------------------------------------------------------------------------------------

async function request(ctx, requestPath) {
  const signal = AbortSignal.any([AbortSignal.timeout(ctx.requestTimeoutMs), ctx.signal]);
  try {
    const response = await fetch(new URL(requestPath, ctx.baseUrl), { method: 'GET', signal, redirect: 'manual' });
    const text = await response.text();
    ctx.bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('deadline exceeded');
    throw new Error('request failed');
  }
}

// ---- Contract check (step 4) ------------------------------------------------------------------------------------

const length = (text) => [...text].length;
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value, min, max) => typeof value === 'string' && length(value) >= min && length(value) <= max;
const uuidList = (value, min, max) =>
  Array.isArray(value) && value.length >= min && value.length <= max && new Set(value).size === value.length
  && value.every((id) => typeof id === 'string' && UUID.test(id));
const sameKeys = (object, keys) => isObject(object) && Object.keys(object).sort().join() === [...keys].sort().join();

const DOCUMENT_KEYS = [
  'schema_version', 'diagnosis_id', 'incident_id', 'diagnosis_version', 'status', 'abstain', 'primary_hypothesis',
  'supporting_claims', 'alternative_hypotheses', 'confidence', 'missing_evidence', 'reasoning_summary',
  'remediation_recommendation', 'provider', 'model_version', 'prompt_version', 'input_digest', 'created_at',
];
const CLAIM_KINDS = ['deployment_succeeded', 'deployment_before_failure', 'failure_burst', 'http_500_in_payments', 'failures_share_deployment'];
const LEVELS = ['low', 'medium', 'high'];
const PROVIDERS = ['deterministic', 'openai-compatible'];
const ACTIONS = ['rollback_deployment', 'investigate', 'none'];

// Returns the name of the first field that breaks the v1.1 contract for a completed diagnosis, or null. The names are
// field names, never values, so a failure cannot echo document text.
export function contractViolation(doc, incidentId) {
  if (!isObject(doc)) return 'diagnosis';
  // The API adds `state` to the stored document. Everything else must be exactly the contract's keys.
  const { state, ...document } = doc;
  if (state !== 'completed') return 'state';
  if (!sameKeys(document, DOCUMENT_KEYS)) return 'keys';
  if (document.schema_version !== '1.1') return 'schema_version';
  if (document.incident_id !== incidentId) return 'incident_id';
  if (!Number.isInteger(document.diagnosis_version) || document.diagnosis_version < 1) return 'diagnosis_version';
  if (document.diagnosis_id !== diagnosisIdFor(document.incident_id, document.diagnosis_version)) return 'diagnosis_id';
  if (document.status !== 'completed' || document.abstain !== false) return 'status';
  if (!text(document.primary_hypothesis, 1, 240)) return 'primary_hypothesis';

  const claims = document.supporting_claims;
  if (!Array.isArray(claims) || claims.length < 1 || claims.length > 6) return 'supporting_claims';
  for (const claim of claims) {
    if (!sameKeys(claim, ['kind', 'claim', 'evidence_ids'])) return 'supporting_claims';
    if (!CLAIM_KINDS.includes(claim.kind) || !text(claim.claim, 1, 280) || !uuidList(claim.evidence_ids, 1, 8)) return 'supporting_claims';
  }
  const alternatives = document.alternative_hypotheses;
  if (!Array.isArray(alternatives) || alternatives.length > 3) return 'alternative_hypotheses';
  for (const alternative of alternatives) {
    if (!sameKeys(alternative, ['hypothesis', 'disconfirming_evidence_ids'])) return 'alternative_hypotheses';
    if (!text(alternative.hypothesis, 1, 240) || !uuidList(alternative.disconfirming_evidence_ids, 0, 8)) return 'alternative_hypotheses';
  }
  const confidence = document.confidence;
  if (!sameKeys(confidence, ['value', 'explanation']) || !LEVELS.includes(confidence.value) || !text(confidence.explanation, 1, 300)) {
    return 'confidence';
  }
  if (!Array.isArray(document.missing_evidence) || document.missing_evidence.length > 5
    || !document.missing_evidence.every((item) => text(item, 1, 160))) return 'missing_evidence';
  if (!text(document.reasoning_summary, 1, 1200)) return 'reasoning_summary';

  const recommendation = document.remediation_recommendation;
  if (!sameKeys(recommendation, ['action_type', 'summary', 'parameters', 'risk', 'expected_effect', 'rollback_note', 'executable', 'requires_approval'])) {
    return 'remediation_recommendation';
  }
  if (recommendation.executable !== false) return 'executable';
  if (recommendation.requires_approval !== true) return 'requires_approval';
  if (!ACTIONS.includes(recommendation.action_type) || !LEVELS.includes(recommendation.risk)) return 'remediation_recommendation';
  if (!text(recommendation.summary, 1, 300) || !text(recommendation.expected_effect, 1, 200) || !text(recommendation.rollback_note, 1, 200)) {
    return 'remediation_recommendation';
  }
  const parameters = recommendation.parameters;
  if (!isObject(parameters) || Object.keys(parameters).some((key) => !['service', 'deployment_id', 'from_version'].includes(key))) {
    return 'parameters';
  }
  if ('service' in parameters && !text(parameters.service, 1, 80)) return 'parameters';
  if ('from_version' in parameters && !text(parameters.from_version, 1, 80)) return 'parameters';
  if ('deployment_id' in parameters && !(typeof parameters.deployment_id === 'string' && UUID.test(parameters.deployment_id))) return 'parameters';
  if (recommendation.action_type === 'rollback_deployment' && Object.keys(parameters).length !== 3) return 'parameters';
  if (recommendation.action_type !== 'rollback_deployment' && Object.keys(parameters).length !== 0) return 'parameters';

  const provider = document.provider;
  if (!sameKeys(provider, ['name', 'model', 'fallback_from']) || !PROVIDERS.includes(provider.name) || !text(provider.model, 1, 80)
    || !(provider.fallback_from === null || PROVIDERS.includes(provider.fallback_from))) return 'provider';
  if (!text(document.model_version, 1, 80) || !text(document.prompt_version, 1, 80)) return 'versions';
  if (typeof document.input_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(document.input_digest)) return 'input_digest';
  if (typeof document.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(document.created_at)) return 'created_at';
  return null;
}

// ---- Page checks (steps 7 and 8) --------------------------------------------------------------------------------

// What React writes for a text node: the five HTML-significant characters become entities.
export function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

export function checkDetailPage(html, diagnosis) {
  if (!html.includes('Likely cause')) return 'the page lacks the Likely cause label';
  if (!html.includes(escapeHtml(diagnosis.primary_hypothesis))) return 'the page does not show the likely-cause text';
  if (!html.includes(NOT_EXECUTED)) return 'the page lacks the Recommendation-only text';
  const targets = [...html.matchAll(/<a [^>]*class="chip"[^>]*href="#(evidence-[0-9a-f-]{36})"/g)].map((match) => match[1]);
  if (targets.length < 3) return `the page has ${targets.length} citation chips, expected at least 3`;
  for (const target of targets) {
    if (!html.includes(`id="${target}"`)) return 'a citation chip points at an evidence row that is not on the page';
  }
  const start = html.indexOf('<aside class="recommendation"');
  const end = start < 0 ? -1 : html.indexOf('</aside>', start);
  if (start < 0 || end < 0) return 'the page lacks the Recommendation panel';
  const panel = html.slice(start, end);
  if (/<button|<form|<input|<a[\s>]/i.test(panel)) return 'the Recommendation panel contains an interactive element';
  if (/<form[^>]*method\s*=\s*["']?post/i.test(html)) return 'the page contains a POST form';
  return null;
}

export function checkListPage(html, incidentId) {
  const rows = html.split('<tr').filter((row) => row.includes(`href="/incidents/${incidentId}"`));
  if (rows.length === 0) return 'the incident is not on the list page';
  return /data-diagnosis="high"/.test(rows[0]) ? null : 'the list page does not show a high diagnosis for the incident';
}

// ---- Docker-backed probes ---------------------------------------------------------------------------------------

async function run(file, args, { signal, timeout = CHILD_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout, windowsHide: true, signal, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const compose = (args, options) => run('docker', ['compose', '-f', COMPOSE_FILE, ...args], options);

const clickhouse = (user, queryArgs, signal) =>
  compose(['exec', '-T', 'clickhouse', 'clickhouse-client', '--user', user, '--password', LOCAL_PASSWORD, ...queryArgs], { signal });

const DENIED = /ACCESS_DENIED|Not enough privileges/;

// Step 9. The privilege checks, as data so a test can read every statement before it runs. No runtime check issues
// destructive DDL against a real application table, and there is no DROP or TRUNCATE at all: ClickHouse checks that the
// table exists before it checks the privilege for those, so against a table that does not exist they prove nothing, and
// against one that does they would be dangerous. The absence of DROP, ALTER, DDL, access-management, and system authority
// is proved instead by inspecting the grants with the privileged local account (evaluateGrants). The ALTER probe below
// does return ACCESS_DENIED before the existence check, and it names a table that does not exist
// (diagnoses_acceptance_probe), so an over-privileged account still could not damage stored data through it.
const PROBE_TABLE = 'diagnoses_acceptance_probe';

export function accountProbeStatements() {
  const zeroRow = (table, column) => `INSERT INTO signalforge.${table} (${column}) SELECT generateUUIDv4() WHERE 0`;
  return [
    { what: 'read incidents', user: AGENT, expect: 'allowed', sql: 'SELECT count() FROM signalforge.incidents', rows: true },
    { what: 'read telemetry_events', user: AGENT, expect: 'allowed', sql: 'SELECT count() FROM signalforge.telemetry_events', rows: true },
    { what: 'insert into diagnoses', user: AGENT, expect: 'allowed', sql: zeroRow('diagnoses', 'diagnosis_id') },
    { what: 'insert into incidents', user: AGENT, expect: 'denied', sql: zeroRow('incidents', 'incident_id') },
    { what: 'insert into evidence_items', user: AGENT, expect: 'denied', sql: zeroRow('evidence_items', 'evidence_id') },
    { what: 'insert into deployments', user: AGENT, expect: 'denied', sql: zeroRow('deployments', 'deployment_id') },
    { what: 'alter a table', user: AGENT, expect: 'denied', sql: `ALTER TABLE signalforge.${PROBE_TABLE} ADD COLUMN acceptance_probe String` },
    { what: 'read system.query_log', user: AGENT, expect: 'denied', sql: 'SELECT * FROM system.query_log LIMIT 1' },
    { what: 'insert into diagnoses', user: READER, expect: 'readonly', sql: zeroRow('diagnoses', 'diagnosis_id') },
  ];
}

// More statements agent_writer must be denied, for the account tests. Every one targets the nonexistent probe table or
// names none, and ClickHouse answers each with ACCESS_DENIED before it looks for the table.
export function deniedAdminStatements() {
  const table = `signalforge.${PROBE_TABLE}`;
  return [
    `ALTER TABLE ${table} ADD COLUMN acceptance_probe String`,
    `ALTER TABLE ${table} DELETE WHERE 0`,
    `CREATE TABLE ${table} (x UInt8) ENGINE = Memory`,
    `RENAME TABLE ${table} TO signalforge.${PROBE_TABLE}_renamed`,
    `OPTIMIZE TABLE ${table}`,
    `GRANT SELECT ON ${table} TO agent_writer`,
    'SYSTEM FLUSH LOGS',
  ].map((sql) => ({ what: 'administer the schema', user: AGENT, expect: 'denied', sql }));
}

// Returns the statements that could harm a real application table. DROP, TRUNCATE, and UNDROP are never allowed. Any other
// destructive statement may reference only the nonexistent probe table (or a name derived from it), never a real table, a
// wildcard, or a system table. An empty result means every statement is safe to run.
export function findUnsafeStatements(statements) {
  // A statement is destructive by its leading verb (SYSTEM as a verb, not the system database). DROP, TRUNCATE, and
  // UNDROP are banned wherever they appear.
  const destructive = /^\s*(DROP|ALTER|TRUNCATE|CREATE|RENAME|DELETE|OPTIMIZE|DETACH|ATTACH|REVOKE|GRANT|SYSTEM|KILL|UNDROP|EXCHANGE|MOVE)\b/i;
  const banned = /\b(DROP|TRUNCATE|UNDROP)\b/i;
  const reference = /\b([a-z_][a-z0-9_]*)\.(\*|[a-z_][a-z0-9_]*)/gi;
  const probe = new RegExp(`^${PROBE_TABLE}(_[a-z0-9]+)?$`);
  const unsafe = [];
  for (const { sql } of statements) {
    for (const part of String(sql).split(';')) {
      if (banned.test(part)) {
        unsafe.push({ sql, reason: 'a DROP or TRUNCATE statement' });
        break;
      }
      if (!destructive.test(part)) continue;
      const offending = [...part.matchAll(reference)].filter(([, db, name]) => !(db.toLowerCase() === 'signalforge' && probe.test(name.toLowerCase())));
      if (offending.length > 0) {
        unsafe.push({ sql, reason: 'a destructive statement that names something other than the probe table' });
        break;
      }
    }
  }
  return unsafe;
}

const INTENDED_GRANTS = [
  'INSERT signalforge.diagnoses',
  'SELECT signalforge.deployments',
  'SELECT signalforge.diagnoses',
  'SELECT signalforge.evidence_items',
  'SELECT signalforge.incidents',
  'SELECT signalforge.telemetry_events',
];

// Judges the rows of system.grants for agent_writer, plus the number of roles it holds. Exactly the six intended
// table-qualified grants pass: SELECT on five tables and INSERT on diagnoses. A grant of any other access type (DROP, ALTER,
// CREATE, TRUNCATE, access management, SHOW, SYSTEM, ALL, ...), on another table or database or on the system database, at
// column level, with a grant option, as a partial revoke, or through a role fails. The detail names the access type and
// table, never a credential.
export function evaluateGrants(rows, roleCount) {
  if (!Array.isArray(rows)) return { ok: false, detail: 'the grants could not be read' };
  const seen = [];
  for (const row of rows) {
    if (!isObject(row)) return { ok: false, detail: 'a grant row was unreadable' };
    const type = typeof row.access_type === 'string' && /^[A-Za-z ]{1,40}$/.test(row.access_type) ? row.access_type : 'an unreadable type';
    if (row.access_type !== 'SELECT' && row.access_type !== 'INSERT') {
      return { ok: false, detail: `agent_writer holds a ${type} grant` };
    }
    if (row.database !== 'signalforge' || typeof row.table !== 'string' || row.table === '') {
      return { ok: false, detail: `agent_writer holds a ${type} grant that is not table-qualified in signalforge` };
    }
    if (row.column !== null && row.column !== undefined) return { ok: false, detail: `agent_writer holds a column-level ${type} grant` };
    if (Number(row.is_partial_revoke) !== 0) return { ok: false, detail: 'agent_writer has a partial revoke' };
    if (Number(row.grant_option) !== 0) return { ok: false, detail: `agent_writer can pass on its ${type} grant` };
    seen.push(`${row.access_type} signalforge.${row.table}`);
  }
  if (new Set(seen).size !== seen.length) return { ok: false, detail: 'agent_writer holds a duplicated grant' };
  const extra = seen.filter((grant) => !INTENDED_GRANTS.includes(grant));
  if (extra.length > 0) return { ok: false, detail: `agent_writer holds an unintended grant: ${extra[0]}` };
  const missing = INTENDED_GRANTS.filter((grant) => !seen.includes(grant));
  if (missing.length > 0) return { ok: false, detail: `agent_writer lacks the intended grant: ${missing[0]}` };
  if (roleCount !== 0) return { ok: false, detail: 'agent_writer holds a role, whose grants this inspection cannot see' };
  return { ok: true, detail: 'exactly SELECT on five tables and INSERT on diagnoses; no DROP, ALTER, DDL, access-management, or system grant' };
}

export async function dockerAccountProbes(signal) {
  for (const probe of accountProbeStatements()) {
    const result = await clickhouse(probe.user, ['--query', probe.sql], signal);
    const who = `${probe.user} ${probe.what}`;
    if (probe.expect === 'allowed') {
      if (result.code !== 0 || (probe.rows && !/^\d+$/.test(result.stdout.trim()))) return { ok: false, detail: `${who} was refused` };
    } else if (result.code === 0) {
      return { ok: false, detail: `${who} was accepted` };
    } else if (probe.expect === 'denied' && !DENIED.test(result.stderr)) {
      return { ok: false, detail: `${who} was not rejected for lack of privilege` };
    } else if (probe.expect === 'readonly' && !/READONLY|readonly/.test(result.stderr)) {
      return { ok: false, detail: `${who} was not rejected as read-only` };
    }
  }
  // The privileged local account reads the grants (SHOW GRANTS needs access management, which even that account lacks, so
  // system.grants is read instead). This is what proves there is no DROP, ALTER, DDL, or access-management authority.
  const grants = await clickhouse(ADMIN, ['--query',
    `SELECT access_type, database, table, column, is_partial_revoke, grant_option FROM system.grants WHERE user_name = '${AGENT}' FORMAT JSONEachRow`], signal);
  const roles = await clickhouse(ADMIN, ['--query', `SELECT count() FROM system.role_grants WHERE user_name = '${AGENT}' FORMAT TSV`], signal);
  if (grants.code !== 0 || roles.code !== 0 || !/^\d+$/.test(roles.stdout.trim())) return { ok: false, detail: 'the grants could not be read' };
  let rows;
  try {
    rows = grants.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return { ok: false, detail: 'the grants could not be read' };
  }
  return evaluateGrants(rows, Number(roles.stdout.trim()));
}

// The stored rows for (incident, version 1), counted without FINAL, and the first document's exact text.
export async function dockerStoredDiagnosis(incidentId, signal) {
  const param = `--param_incident=${incidentId}`;
  const count = await clickhouse(AGENT, [param, '--query', 'SELECT count() FROM signalforge.diagnoses WHERE incident_id = {incident:UUID} AND diagnosis_version = 1'], signal);
  const document = await clickhouse(AGENT, [param, '--format', 'TSVRaw', '--query',
    'SELECT document FROM signalforge.diagnoses WHERE incident_id = {incident:UUID} AND diagnosis_version = 1 ORDER BY created_at LIMIT 1'], signal);
  if (count.code !== 0 || document.code !== 0 || !/^\d+$/.test(count.stdout.trim())) throw new Error('stored diagnosis unreadable');
  return { count: Number(count.stdout.trim()), document: document.stdout.replace(/\n$/, '') };
}

export const dockerProbes = {
  accounts: dockerAccountProbes,
  storedDiagnosis: dockerStoredDiagnosis,
  async restartAgent(signal) {
    const result = await compose(['restart', 'agent-python'], { signal, timeout: RESTART_TIMEOUT_MS });
    if (result.code !== 0) throw new Error('restart failed');
  },
  async agentHealthy(signal) {
    const result = await compose(['ps', '--format', '{{.Health}}', 'agent-python'], { signal });
    return result.code === 0 && result.stdout.trim() === 'healthy';
  },
  async agentLogs(signal) {
    const result = await compose(['logs', '--no-log-prefix', 'agent-python'], { signal });
    if (result.code !== 0) throw new Error('logs unreadable');
    return `${result.stdout}\n${result.stderr}`;
  },
};

// ---- The twelve steps -------------------------------------------------------------------------------------------

const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });

async function readDetail(ctx) {
  const response = await request(ctx, `/api/incidents/${ctx.state.incidentId}`);
  if (response.status !== 200 || !isObject(response.json)) throw new Error(`incident detail returned ${response.status}`);
  return response.json;
}

const IMPLEMENTATIONS = {
  async health(ctx) {
    const response = await request(ctx, '/api/health');
    return response.status === 200 ? pass('GET /api/health returned 200') : fail(`GET /api/health returned ${response.status}`);
  },

  async 'incident-found'(ctx) {
    if (ctx.incidentId !== undefined) {
      ctx.state.incidentId = ctx.incidentId;
      const response = await request(ctx, `/api/incidents/${ctx.incidentId}`);
      return response.status === 200 ? pass('the requested incident exists') : fail(`the requested incident returned ${response.status}`);
    }
    const response = await request(ctx, '/api/incidents?limit=20');
    const newest = response.json?.incidents?.[0]?.incident_id;
    if (response.status !== 200 || typeof newest !== 'string' || !UUID.test(newest)) {
      return fail('no incident found; create one with the demo flow first');
    }
    ctx.state.incidentId = newest;
    return pass(`newest incident ${newest}`);
  },

  async 'diagnosis-completed'(ctx) {
    let detail;
    try {
      detail = await pollUntil(
        async () => {
          const body = await readDetail(ctx);
          return body.diagnosis === null || body.diagnosis === undefined ? null : body;
        },
        { deadlineMs: ctx.diagnosisDeadlineMs, intervalMs: ctx.pollIntervalMs, signal: ctx.signal },
      );
    } catch (error) {
      if (error.message === 'deadline exceeded') return fail(`no diagnosis appeared within ${ctx.diagnosisDeadlineMs}ms`);
      throw error;
    }
    const state = detail.diagnosis?.state;
    if (state !== 'completed') return fail(`the diagnosis state is ${typeof state === 'string' ? state : 'missing'}, not completed`);
    ctx.state.detail = detail;
    return pass('the diagnosis is completed');
  },

  async contract(ctx) {
    const violation = contractViolation(ctx.state.detail.diagnosis, ctx.state.incidentId);
    return violation === null
      ? pass('v1.1, deterministic ID, bounds and enums hold; executable false; requires_approval true')
      : fail(`the diagnosis breaks the contract at ${violation}`);
  },

  async citations(ctx) {
    const { detail } = ctx.state;
    const evidence = Array.isArray(detail.evidence) ? detail.evidence.map((row) => row.evidence_id) : [];
    if (evidence.length !== 4) return fail(`the incident has ${evidence.length} evidence rows, expected 4`);
    const known = new Set(evidence);
    const cited = [
      ...detail.diagnosis.supporting_claims.flatMap((claim) => claim.evidence_ids),
      ...detail.diagnosis.alternative_hypotheses.flatMap((alternative) => alternative.disconfirming_evidence_ids),
    ];
    const outside = cited.filter((id) => !known.has(id));
    return outside.length === 0
      ? pass(`${cited.length} citations, all among the 4 evidence rows`)
      : fail(`${outside.length} citations are not evidence of this incident`);
  },

  async hypothesis(ctx) {
    const { diagnosis, deployment } = ctx.state.detail;
    if (!isObject(deployment) || typeof deployment.deployment_id !== 'string' || typeof deployment.new_version !== 'string') {
      return fail('the response has no deployment to compare with');
    }
    if (!diagnosis.primary_hypothesis.includes(deployment.deployment_id)) return fail('the hypothesis does not name the deployment ID');
    if (!diagnosis.primary_hypothesis.includes(deployment.new_version)) return fail('the hypothesis does not name the deployment version');
    return diagnosis.confidence.value === 'high' ? pass('names the deployment ID and version; confidence is high') : fail(`confidence is ${diagnosis.confidence.value}, not high`);
  },

  async 'detail-page'(ctx) {
    const response = await request(ctx, `/incidents/${ctx.state.incidentId}`);
    if (response.status !== 200) return fail(`GET /incidents/<id> returned ${response.status}`);
    const problem = checkDetailPage(response.text, ctx.state.detail.diagnosis);
    return problem === null ? pass('likely cause, Recommendation-only text, valid chip targets, no button or POST form') : fail(problem);
  },

  async 'list-page'(ctx) {
    const response = await request(ctx, '/incidents');
    if (response.status !== 200) return fail(`GET /incidents returned ${response.status}`);
    const problem = checkListPage(response.text, ctx.state.incidentId);
    return problem === null ? pass('the list shows high for the incident') : fail(problem);
  },

  async accounts(ctx) {
    const outcome = await ctx.probes.accounts(ctx.signal);
    return outcome.ok ? pass(outcome.detail) : fail(outcome.detail);
  },

  async 'idempotent-restart'(ctx) {
    const incidentId = ctx.state.incidentId;
    const before = await ctx.probes.storedDiagnosis(incidentId, ctx.signal);
    if (before.count !== 1) return fail(`${before.count} stored rows for the first version before the restart, expected 1`);
    ctx.state.deployments = await deploymentFingerprint(ctx);
    await ctx.probes.restartAgent(ctx.signal);
    try {
      await pollUntil(() => ctx.probes.agentHealthy(ctx.signal), { deadlineMs: ctx.healthDeadlineMs, intervalMs: ctx.pollIntervalMs, signal: ctx.signal });
    } catch (error) {
      if (error.message === 'deadline exceeded') return fail(`agent-python was not healthy ${ctx.healthDeadlineMs}ms after the restart`);
      throw error;
    }
    const after = await ctx.probes.storedDiagnosis(incidentId, ctx.signal);
    if (after.count !== 1) return fail(`${after.count} stored rows after the restart, expected 1`);
    if (after.document !== before.document) return fail('the stored document changed across the restart');
    return pass('one stored row and a byte-identical document across the restart');
  },

  async 'no-leaks'(ctx) {
    const logs = await ctx.probes.agentLogs(ctx.signal);
    for (const [source, body] of [...ctx.bodies.map((b) => ['a response body', b]), ['the agent log', logs]]) {
      for (const [token, label] of FORBIDDEN) {
        if (body.includes(token)) return fail(`${source} contains ${label}`);
      }
    }
    return pass(`${ctx.bodies.length} response bodies and the agent log are clean`);
  },

  async 'no-remediation'(ctx) {
    const after = await deploymentFingerprint(ctx);
    return after === ctx.state.deployments
      ? pass('the Payments deployment list is unchanged across the restart')
      : fail('the Payments deployment list changed across the restart');
  },
};

// The deployment count and IDs, newest first. The IDs matter because the API caps the list, so a count alone could
// hide a new deployment.
async function deploymentFingerprint(ctx) {
  const response = await request(ctx, '/api/deployments?limit=50');
  const list = response.json?.deployments;
  if (response.status !== 200 || !Array.isArray(list)) throw new Error(`deployments returned ${response.status}`);
  return `${list.length}:${list.map((item) => item.deployment_id).join(',')}`;
}

function describeFailure(error) {
  const known = ['deadline exceeded', 'request failed', 'cancelled'];
  if (error instanceof Error && known.includes(error.message)) return error.message;
  if (error instanceof Error && /^(incident detail|deployments) returned \d+$/.test(error.message)) return error.message;
  return 'unexpected error';
}

// Runs the steps in order and stops at the first failure. `onStep` sees each completed step as it finishes.
export async function runAcceptance({
  baseUrl = process.env.DASHBOARD_BASE_URL ?? DEFAULT_BASE_URL,
  incidentId,
  probes = dockerProbes,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  overallDeadlineMs = OVERALL_DEADLINE_MS,
  diagnosisDeadlineMs = DIAGNOSIS_DEADLINE_MS,
  healthDeadlineMs = HEALTH_DEADLINE_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  onStep = () => {},
} = {}) {
  const ctx = {
    baseUrl, incidentId, probes, requestTimeoutMs, diagnosisDeadlineMs, healthDeadlineMs, pollIntervalMs,
    signal: AbortSignal.timeout(overallDeadlineMs), bodies: [], state: {},
  };
  const steps = [];
  for (const step of STEPS) {
    let outcome;
    try {
      outcome = await IMPLEMENTATIONS[step.id](ctx);
    } catch (error) {
      outcome = fail(describeFailure(error));
    }
    const done = { ...step, ...outcome };
    steps.push(done);
    onStep(done);
    if (done.status === 'fail') return { ok: false, steps, failed: done };
  }
  return { ok: true, steps, failed: null };
}

// ---- Command line -----------------------------------------------------------------------------------------------

async function main() {
  let incidentId;
  try {
    const { values } = parseArgs({ options: { 'incident-id': { type: 'string' } } });
    if (values['incident-id'] !== undefined) incidentId = parseIncidentIdArg(values['incident-id']);
  } catch (error) {
    console.log(`FAIL usage: ${error.message.includes('--incident-id') ? error.message : 'unknown argument'}`);
    process.exitCode = 1;
    return;
  }
  const result = await runAcceptance({
    incidentId,
    onStep: (step) => {
      if (step.status === 'pass') console.log(`PASS ${step.n} ${step.name}`);
    },
  });
  if (!result.ok) {
    console.log(`FAIL ${result.failed.n} ${result.failed.name}: ${result.failed.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log('FAIL unexpected error');
    process.exitCode = 1;
  });
}
