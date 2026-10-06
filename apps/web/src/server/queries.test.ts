import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUERIES, INCIDENT_COLUMNS } from './queries';

// The seven queries from docs/specs/2026-10-06-incident-dashboard.md, section 5.2. Whitespace is normalized
// before comparison, so line breaks in the spec do not matter. Every other character must match.
const EXPECTED = {
  Q1: `SELECT incident_id, revision, title, status, severity, service, environment, deployment_id,
trigger_rule, started_at, detected_at, publication_state, published_at
FROM incidents FINAL
ORDER BY detected_at DESC
LIMIT {limit:UInt32}`,
  Q2: `SELECT incident_id, revision, title, status, severity, service, environment, deployment_id,
trigger_rule, started_at, detected_at, publication_state, published_at
FROM incidents FINAL
WHERE incident_id = {incident_id:UUID}`,
  Q3: `SELECT evidence_id, source_type, source_ref, timestamp, service, summary, reliability
FROM evidence_items FINAL
WHERE incident_id = {incident_id:UUID}
ORDER BY timestamp, source_type, source_ref`,
  Q4: `SELECT deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status
FROM deployments FINAL
WHERE toString(deployment_id) = {deployment_id:String}`,
  Q5: `SELECT deployment_id, timestamp, environment, new_version, previous_version, status
FROM deployments FINAL
WHERE service = 'demo-payments'
ORDER BY timestamp DESC
LIMIT {limit:UInt32}`,
  Q6: `SELECT deployment_id, uniqExact(trace_id) AS failing_traces
FROM (
SELECT trace_id, deployment_id
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments'
AND JSONExtractString(attributes, 'span.kind') = 'server'
AND deployment_id != ''
AND JSONExtractInt(attributes, 'http.response.status_code') = 500
GROUP BY trace_id, deployment_id
)
WHERE deployment_id IN {deployment_ids:Array(String)}
GROUP BY deployment_id`,
  Q7: `SELECT incident_id, deployment_id, started_at
FROM incidents FINAL
WHERE deployment_id IN {deployment_ids:Array(String)}`,
} as const;

// Typed placeholders each query must declare, by name and ClickHouse type. A query with any other placeholder fails.
const PLACEHOLDERS = {
  Q1: { limit: 'UInt32' },
  Q2: { incident_id: 'UUID' },
  Q3: { incident_id: 'UUID' },
  Q4: { deployment_id: 'String' },
  Q5: { limit: 'UInt32' },
  Q6: { deployment_ids: 'Array(String)' },
  Q7: { deployment_ids: 'Array(String)' },
} as const;

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// Collects every {name:Type} placeholder and every other brace group, so untyped or extra placeholders show up.
function placeholders(sql: string) {
  const typed: Record<string, string> = {};
  const other: string[] = [];
  for (const [group] of sql.matchAll(/\{[^{}]*\}/g)) {
    const match = /^\{([a-z_]+):([A-Za-z0-9()]+)\}$/.exec(group);
    if (match) typed[match[1]] = match[2];
    else other.push(group);
  }
  return { typed, other };
}

test('each query matches its spec text exactly, ignoring whitespace layout', () => {
  for (const name of Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>) {
    assert.equal(normalize(QUERIES[name]), normalize(EXPECTED[name]), `${name} differs from the spec`);
  }
});

test('the seven queries are exported, and no others', () => {
  assert.deepEqual(Object.keys(QUERIES).sort(), ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']);
});

test('the query map and every query string are immutable', () => {
  assert.ok(Object.isFrozen(QUERIES), 'QUERIES must be frozen');
  for (const sql of Object.values(QUERIES)) assert.equal(typeof sql, 'string');
});

test('each query declares exactly its typed named placeholders', () => {
  for (const name of Object.keys(PLACEHOLDERS) as Array<keyof typeof PLACEHOLDERS>) {
    const { typed, other } = placeholders(QUERIES[name]);
    assert.deepEqual(other, [], `${name} has an untyped brace group: ${other.join(', ')}`);
    assert.deepEqual(typed, PLACEHOLDERS[name], `${name} placeholders differ from the contract`);
  }
});

test('no query contains JavaScript interpolation or string-building syntax', () => {
  for (const [name, sql] of Object.entries(QUERIES)) {
    assert.ok(!sql.includes('${'), `${name} contains a template interpolation`);
    assert.ok(!/['"]\s*\+/.test(sql) && !/\+\s*['"]/.test(sql), `${name} concatenates strings`);
    assert.ok(!sql.includes('\\'), `${name} contains a backslash escape`);
  }
});

test('no query contains a bare external-looking literal in place of a parameter', () => {
  // Literals are allowed only where the spec fixes them: the service name and the status and span constants.
  for (const [name, sql] of Object.entries(QUERIES)) {
    const literals = [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    for (const literal of literals) {
      assert.ok(
        ['demo-payments', 'trace', 'server', 'span.kind', 'http.response.status_code', ''].includes(literal),
        `${name} contains an unexpected literal '${literal}'`,
      );
    }
  }
});

test('Q2 selects exactly the same incident columns as Q1', () => {
  const columns = (sql: string) => sql.match(/^SELECT ([\s\S]*?)\nFROM/)?.[1].replace(/\s+/g, ' ').trim();
  assert.equal(columns(QUERIES.Q2), columns(QUERIES.Q1));
  assert.equal(columns(QUERIES.Q2), normalize(INCIDENT_COLUMNS));
});

test('the incident column list is the spec list, in order', () => {
  assert.equal(
    normalize(INCIDENT_COLUMNS),
    'incident_id, revision, title, status, severity, service, environment, deployment_id, trigger_rule, started_at, detected_at, publication_state, published_at',
  );
});

test('the incident and evidence queries read the latest revision with FINAL', () => {
  for (const name of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const) {
    assert.match(QUERIES[name], /FINAL/, `${name} must read with FINAL`);
  }
});

test('the failure query keeps the correlator filter: server spans, status 500, deployment ID present', () => {
  const q6 = normalize(QUERIES.Q6);
  assert.ok(q6.includes("type = 'trace' AND service = 'demo-payments'"));
  assert.ok(q6.includes("JSONExtractString(attributes, 'span.kind') = 'server'"));
  assert.ok(q6.includes("deployment_id != ''"));
  assert.ok(q6.includes("JSONExtractInt(attributes, 'http.response.status_code') = 500"));
});
