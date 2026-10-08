import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDiagnosis, schemaViolations } from './diagnosis';
import type { DiagnosisRow } from './clickhouse';

const EVENTS = join(__dirname, '..', '..', '..', '..', 'contracts', 'events');
const load = (path: string): Record<string, any> => JSON.parse(readFileSync(join(EVENTS, path), 'utf-8'));
const SAMPLE = load('samples/diagnosis.sample.json');
const INCIDENT_ID: string = SAMPLE.incident_id;
const OTHER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const cited = (doc: Record<string, any>): string[] => [
  ...doc.supporting_claims.flatMap((c: any) => c.evidence_ids),
  ...doc.alternative_hypotheses.flatMap((a: any) => a.disconfirming_evidence_ids),
];
const EVIDENCE = [...new Set(cited(SAMPLE))];

const clone = (doc: unknown) => JSON.parse(JSON.stringify(doc)) as Record<string, any>;

function rowFor(doc: Record<string, any>, overrides: Partial<DiagnosisRow> = {}): DiagnosisRow {
  return {
    diagnosis_version: doc.diagnosis_version,
    status: doc.status,
    confidence: doc.confidence?.value ?? '',
    failure_code: '',
    document: JSON.stringify(doc),
    created_at: '2026-10-07 21:49:41.208',
    ...overrides,
  };
}

function abstained(): Record<string, any> {
  const doc = clone(SAMPLE);
  doc.status = 'abstained';
  doc.abstain = true;
  delete doc.primary_hypothesis;
  doc.supporting_claims = [];
  doc.alternative_hypotheses = [];
  doc.missing_evidence = ['Failing traces for the deployment window'];
  doc.confidence = { value: 'low', explanation: 'There is too little evidence for a conclusion.' };
  doc.remediation_recommendation = {
    ...doc.remediation_recommendation,
    action_type: 'investigate',
    parameters: {},
  };
  return doc;
}

const failedRow = (overrides: Partial<DiagnosisRow> = {}): DiagnosisRow => ({
  diagnosis_version: 3,
  status: 'failed',
  confidence: '',
  failure_code: 'validation_rejected',
  document: '',
  created_at: '2026-10-07 21:49:41.208',
  ...overrides,
});

const UNAVAILABLE = { state: 'unavailable' };

test('the valid v1.1 sample parses as completed, with its document intact', () => {
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE), INCIDENT_ID, EVIDENCE), { ...SAMPLE, state: 'completed' });
});

test('a valid abstained document parses as abstained', () => {
  const doc = abstained();
  assert.deepEqual(schemaViolations(doc), []);
  assert.deepEqual(parseDiagnosis(rowFor(doc), INCIDENT_ID, EVIDENCE), { ...doc, state: 'abstained' });
});

test('every invalid diagnosis fixture becomes exactly { state: "unavailable" }', () => {
  const names = readdirSync(join(EVENTS, 'samples', 'invalid')).filter((n) => n.startsWith('diagnosis.'));
  assert.equal(names.length, 9);
  for (const name of names) {
    const doc = load(`samples/invalid/${name}`);
    // The row is made consistent with the document, so only the document's own faults can reject it.
    const row = rowFor(doc, {
      status: doc.status === 'abstained' ? 'abstained' : 'completed',
      diagnosis_version: typeof doc.diagnosis_version === 'number' ? doc.diagnosis_version : 1,
    });
    assert.deepEqual(parseDiagnosis(row, doc.incident_id ?? INCIDENT_ID, EVIDENCE), UNAVAILABLE, name);
  }
});

// The same table as the Python contract tests: which schema keyword fails, and where.
const EXPECTED_VIOLATIONS: Array<[string, string, string]> = [
  ['diagnosis.executable-true', '/remediation_recommendation/executable', 'const'],
  ['diagnosis.claim-without-evidence', '/supporting_claims/0/evidence_ids', 'minItems'],
  ['diagnosis.unknown-claim-kind', '/supporting_claims/0/kind', 'enum'],
  ['diagnosis.abstain-with-hypothesis', '/primary_hypothesis', 'not'],
  ['diagnosis.completed-without-hypothesis', '', 'required'],
  ['diagnosis.overlong-reasoning', '/reasoning_summary', 'maxLength'],
  ['diagnosis.confidence-not-enum', '/confidence/value', 'enum'],
  ['diagnosis.bad-digest', '/input_digest', 'pattern'],
  ['diagnosis.extra-field', '', 'additionalProperties'],
];

test('the schema check reports the same keyword and location the Python validator does', () => {
  for (const [name, path, keyword] of EXPECTED_VIOLATIONS) {
    const found = schemaViolations(load(`samples/invalid/${name}.json`));
    assert.ok(
      found.some((v) => v.path === path && v.keyword === keyword),
      `${name}: expected ${keyword} at "${path}", got ${JSON.stringify(found)}`,
    );
  }
  assert.deepEqual(schemaViolations(SAMPLE), []);
});

test('each v1.1 bound holds at its limit and fails one past it', () => {
  const violations = (fn: (d: Record<string, any>) => void) => {
    const doc = clone(SAMPLE);
    fn(doc);
    return schemaViolations(doc).length;
  };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
  assert.equal(violations((d) => (d.primary_hypothesis = 'x'.repeat(240))), 0);
  assert.ok(violations((d) => (d.primary_hypothesis = 'x'.repeat(241))) > 0);
  assert.ok(violations((d) => (d.primary_hypothesis = '')) > 0);
  // Length counts code points, as JSON Schema does: 240 astral characters are 480 UTF-16 units.
  assert.equal(violations((d) => (d.primary_hypothesis = '\u{1F600}'.repeat(240))), 0);
  assert.ok(violations((d) => (d.supporting_claims[0].claim = 'x'.repeat(281))) > 0);
  assert.ok(violations((d) => (d.reasoning_summary = 'x'.repeat(1201))) > 0);
  assert.ok(violations((d) => (d.confidence.explanation = 'x'.repeat(301))) > 0);
  assert.ok(violations((d) => (d.missing_evidence = Array(6).fill('x'))) > 0);
  assert.ok(violations((d) => (d.missing_evidence = ['x'.repeat(161)])) > 0);
  assert.equal(violations((d) => (d.supporting_claims = [...d.supporting_claims, d.supporting_claims[0]])), 0, 'six claims is the limit');
  assert.ok(violations((d) => (d.supporting_claims = Array(7).fill(d.supporting_claims[0]))) > 0);
  assert.ok(violations((d) => (d.alternative_hypotheses = Array(4).fill(d.alternative_hypotheses[0]))) > 0);
  assert.equal(violations((d) => (d.supporting_claims[0].evidence_ids = ids(8))), 0);
  assert.ok(violations((d) => (d.supporting_claims[0].evidence_ids = ids(9))) > 0);
  assert.ok(violations((d) => (d.supporting_claims[0].evidence_ids = [EVIDENCE[0], EVIDENCE[0]])) > 0);
  assert.ok(violations((d) => (d.supporting_claims[0].evidence_ids = [EVIDENCE[0].toUpperCase()])) > 0);
  assert.ok(violations((d) => (d.diagnosis_version = 0)) > 0);
  assert.ok(violations((d) => (d.diagnosis_version = 1.5)) > 0);
  assert.ok(violations((d) => (d.schema_version = '1.0')) > 0);
  assert.ok(violations((d) => (d.created_at = '2026-10-07T21:49:41Z')) > 0);
  assert.ok(violations((d) => (d.provider.fallback_from = 'other')) > 0);
  assert.ok(violations((d) => (d.provider.name = 'other')) > 0);
  assert.ok(violations((d) => delete d.provider.model) > 0);
  assert.ok(violations((d) => (d.remediation_recommendation.requires_approval = false)) > 0);
  assert.ok(violations((d) => (d.remediation_recommendation.action_type = 'restart')) > 0);
  assert.ok(violations((d) => (d.remediation_recommendation.parameters = { service: 'demo-payments' })) > 0);
  assert.ok(violations((d) => (d.remediation_recommendation.parameters.extra = 'x')) > 0);
  assert.ok(violations((d) => (d.remediation_recommendation.action_type = 'investigate')) > 0, 'investigate takes no parameters');
  assert.ok(violations((d) => (d.abstain = true)) > 0, 'abstain true needs status abstained');
  assert.ok(violations((d) => (d.supporting_claims = [])) > 0, 'completed needs a claim');
  assert.ok(violations((d) => (d.confidence = 'high')) > 0);
  assert.ok(violations((d) => (d.missing_evidence = 'none')) > 0);
});

test('an abstained document must carry the abstain rules', () => {
  const violations = (fn: (d: Record<string, any>) => void) => {
    const doc = abstained();
    fn(doc);
    return schemaViolations(doc).length;
  };
  assert.equal(violations(() => undefined), 0);
  assert.ok(violations((d) => (d.missing_evidence = [])) > 0);
  assert.ok(violations((d) => (d.confidence.value = 'high')) > 0);
  assert.ok(violations((d) => (d.remediation_recommendation.action_type = 'rollback_deployment')) > 0);
  assert.ok(violations((d) => (d.supporting_claims = SAMPLE.supporting_claims)) > 0);
  assert.ok(violations((d) => (d.status = 'completed')) > 0);
});

test('a document for another incident is unavailable', () => {
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE), '00000000-0000-4000-8000-000000000001', EVIDENCE), UNAVAILABLE);
});

test('every cited ID must be evidence of this incident in the same response', () => {
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE), INCIDENT_ID, EVIDENCE.slice(1)), UNAVAILABLE);
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE), INCIDENT_ID, []), UNAVAILABLE);
  // An extra evidence ID that nothing cites is fine; only the cited ones must be present.
  const withExtra = parseDiagnosis(rowFor(SAMPLE), INCIDENT_ID, [...EVIDENCE, OTHER_ID]);
  assert.equal((withExtra as { state: string }).state, 'completed');

  // A supporting citation alone, and an alternative citation alone, are each enough to refuse.
  const onlyAlt = clone(SAMPLE);
  onlyAlt.alternative_hypotheses[0].disconfirming_evidence_ids = [OTHER_ID];
  assert.deepEqual(parseDiagnosis(rowFor(onlyAlt), INCIDENT_ID, EVIDENCE), UNAVAILABLE);
  const onlySupport = clone(SAMPLE);
  onlySupport.supporting_claims[0].evidence_ids = [OTHER_ID];
  assert.deepEqual(parseDiagnosis(rowFor(onlySupport), INCIDENT_ID, EVIDENCE), UNAVAILABLE);
});

test('the row and its document must agree on version, status, and confidence', () => {
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE, { diagnosis_version: 2 }), INCIDENT_ID, EVIDENCE), UNAVAILABLE);
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE, { status: 'abstained' }), INCIDENT_ID, EVIDENCE), UNAVAILABLE);
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE, { confidence: 'low' }), INCIDENT_ID, EVIDENCE), UNAVAILABLE);
  assert.deepEqual(parseDiagnosis(rowFor(SAMPLE, { failure_code: 'bundle_too_large' }), INCIDENT_ID, EVIDENCE), UNAVAILABLE);
});

test('a malformed row or document is unavailable and never throws', () => {
  const bad: unknown[] = [
    rowFor(SAMPLE, { document: '' }),
    rowFor(SAMPLE, { document: 'not json' }),
    rowFor(SAMPLE, { document: '[]' }),
    rowFor(SAMPLE, { document: 'null' }),
    rowFor(SAMPLE, { document: '"text"' }),
    rowFor(SAMPLE, { status: 'bogus' }),
    rowFor(SAMPLE, { diagnosis_version: 1.5 }),
    rowFor(SAMPLE, { diagnosis_version: '1' as unknown as number }),
    rowFor(SAMPLE, { document: JSON.stringify(SAMPLE).replace('"incident_id"', '"__proto__"') }),
    null,
    undefined,
    'row',
    42,
    {},
  ];
  for (const row of bad) assert.deepEqual(parseDiagnosis(row as DiagnosisRow, INCIDENT_ID, EVIDENCE), UNAVAILABLE);
});

test('a failed row exposes only the version, the code, and the time', () => {
  assert.deepEqual(parseDiagnosis(failedRow(), INCIDENT_ID, EVIDENCE), {
    state: 'failed',
    diagnosis_version: 3,
    failure_code: 'validation_rejected',
    created_at: '2026-10-07T21:49:41.208Z',
  });
  for (const code of ['validation_rejected', 'invalid_incident', 'bundle_too_large']) {
    const result = parseDiagnosis(failedRow({ failure_code: code }), INCIDENT_ID, EVIDENCE) as { failure_code: string };
    assert.equal(result.failure_code, code);
  }
});

test('a failed row with an unknown code, a document, a confidence, or a bad time is unavailable', () => {
  const cases: Array<Partial<DiagnosisRow>> = [
    { failure_code: '' },
    { failure_code: 'provider_down' },
    { failure_code: 'validation_rejected\n' },
    { document: JSON.stringify(SAMPLE) },
    { document: '{}' },
    { confidence: 'low' },
    { created_at: 'yesterday' },
    { created_at: '2026-10-07 21:49:41' },
    { created_at: '2026-10-07 21:49:41.208000000' },
    { diagnosis_version: 0 },
    { diagnosis_version: -1 },
  ];
  for (const overrides of cases) {
    assert.deepEqual(parseDiagnosis(failedRow(overrides), INCIDENT_ID, EVIDENCE), UNAVAILABLE, JSON.stringify(overrides));
  }
});

test('text fields pass through as plain data, unescaped and unrendered', () => {
  const doc = clone(SAMPLE);
  const payload = '<img src=x onerror=alert(1)> **bold** [link](javascript:alert(1)) {{template}} ${x}';
  doc.supporting_claims[0].claim = payload;
  const result = parseDiagnosis(rowFor(doc), INCIDENT_ID, EVIDENCE) as { state: string; supporting_claims: Array<{ claim: string }> };
  assert.equal(result.state, 'completed');
  assert.equal(result.supporting_claims[0].claim, payload);
});

test('the result of a parse never aliases the input row', () => {
  const row = rowFor(SAMPLE);
  const result = parseDiagnosis(row, INCIDENT_ID, EVIDENCE) as unknown as { primary_hypothesis: string };
  result.primary_hypothesis = 'changed';
  assert.equal(JSON.parse(row.document).primary_hypothesis, SAMPLE.primary_hypothesis);
});
