import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeployment,
  explainIncident,
  toDeploymentDetail,
  toDeploymentItem,
  toEvidenceItem,
  toDiagnosisSummary,
  toIncidentItem,
} from './model';
import type { DeploymentRow, EvidenceRow, IncidentRow, RecentDeploymentRow } from './clickhouse';

const INCIDENT_ID = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const DEPLOYMENT_ID = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';

// Rows as ClickHouse returns them in JSONEachRow: 64-bit integers are quoted, DateTime64 is text, Nullable is null.
const incidentRow: IncidentRow = {
  incident_id: INCIDENT_ID,
  revision: '2',
  title: `Payments 5xx burst after deployment ${DEPLOYMENT_ID}`,
  status: 'open',
  severity: 'high',
  service: 'demo-payments',
  environment: 'local',
  deployment_id: DEPLOYMENT_ID,
  trigger_rule: 'payments-5xx-burst-after-deployment',
  started_at: '2026-10-03 12:00:05.123000000',
  detected_at: '2026-10-03 12:00:12.456000000',
  publication_state: 'published',
  published_at: '2026-10-03 12:00:13.001000000',
};

const deploymentRow: DeploymentRow = {
  deployment_id: DEPLOYMENT_ID,
  timestamp: '2026-10-03 12:00:00.000000000',
  service: 'demo-payments',
  environment: 'local',
  new_version: '0.2.0-faulty',
  previous_version: '',
  initiated_by: 'deploy-payments-script',
  status: 'succeeded',
};

// ---- Classification ----

test('a succeeded deployment with no failures and no incident is healthy, labelled exactly "No failures observed"', () => {
  const result = classifyDeployment({ status: 'succeeded', failingTraces: 0, incidentCount: 0 });
  assert.equal(result.class, 'healthy');
  assert.equal(result.label, 'No failures observed');
});

test('a healthy label never claims traffic was observed', () => {
  // Zero failures does not prove that requests were served. The label must not say so.
  const { label } = classifyDeployment({ status: 'succeeded', failingTraces: 0, incidentCount: 0 });
  // Word boundaries matter: "served" is a substring of "observed", and the required label contains "observed".
  assert.ok(!/\b(traffic|served|requests|healthy)\b/i.test(label), `label overclaims: "${label}"`);
});

test('one or more failure traces make a deployment faulty, with the count in the label', () => {
  assert.deepEqual(classifyDeployment({ status: 'succeeded', failingTraces: 1, incidentCount: 0 }), {
    class: 'faulty',
    label: 'Faulty: 1 HTTP 500 traces',
  });
  assert.equal(classifyDeployment({ status: 'succeeded', failingTraces: 3, incidentCount: 0 }).label, 'Faulty: 3 HTTP 500 traces');
});

test('a linked incident makes a deployment faulty even when the failure count is zero', () => {
  const result = classifyDeployment({ status: 'succeeded', failingTraces: 0, incidentCount: 1 });
  assert.equal(result.class, 'faulty');
  assert.equal(result.label, 'Faulty: 0 HTTP 500 traces');
});

test('a linked incident with zero counted failures is faulty, labelled with the specified form', () => {
  // Spec 5.3 defines one label form for every faulty deployment: "Faulty: N HTTP 500 traces".
  assert.deepEqual(classifyDeployment({ status: 'succeeded', failingTraces: 0, incidentCount: 1 }), {
    class: 'faulty',
    label: 'Faulty: 0 HTTP 500 traces',
  });
});

test('a non-succeeded status is unknown and keeps its raw status as the label', () => {
  for (const status of ['started', 'failed', 'rolled_back']) {
    assert.deepEqual(classifyDeployment({ status, failingTraces: 0, incidentCount: 0 }), { class: 'unknown', label: status });
  }
});

test('a non-succeeded deployment is unknown even with failures or incidents, not faulty', () => {
  assert.equal(classifyDeployment({ status: 'failed', failingTraces: 4, incidentCount: 1 }).class, 'unknown');
});

test('a negative or fractional failure count is rejected', () => {
  assert.throws(() => classifyDeployment({ status: 'succeeded', failingTraces: -1, incidentCount: 0 }), RangeError);
  assert.throws(() => classifyDeployment({ status: 'succeeded', failingTraces: 1.5, incidentCount: 0 }), RangeError);
});

// ---- Explanation ----

test('the explanation uses the spec wording for payments-5xx-burst-after-deployment', () => {
  const text = explainIncident({
    trigger_rule: 'payments-5xx-burst-after-deployment',
    started_at: '2026-10-03T12:00:05.123000000Z',
    deployment_id: DEPLOYMENT_ID,
    deployment_version: '0.2.0-faulty',
  });
  assert.equal(
    text,
    `Three distinct Payments 5xx traces within 30 seconds after this deployment (${DEPLOYMENT_ID}, 0.2.0-faulty). The first trace was at 2026-10-03T12:00:05.123000000Z.`,
  );
});

test('the explanation omits the version when no matching deployment exists, without inventing one', () => {
  const text = explainIncident({
    trigger_rule: 'payments-5xx-burst-after-deployment',
    started_at: '2026-10-03T12:00:05.123000000Z',
    deployment_id: DEPLOYMENT_ID,
    deployment_version: null,
  });
  assert.equal(
    text,
    `Three distinct Payments 5xx traces within 30 seconds after this deployment (${DEPLOYMENT_ID}). The first trace was at 2026-10-03T12:00:05.123000000Z.`,
  );
});

test('an unknown rule shows the raw rule name and the fixed fallback sentence', () => {
  const text = explainIncident({
    trigger_rule: 'slow-query-after-deployment',
    started_at: '2026-10-03T12:00:05.123000000Z',
    deployment_id: DEPLOYMENT_ID,
    deployment_version: '0.2.0',
  });
  assert.equal(text, 'slow-query-after-deployment. No explanation template for this rule.');
});

// ---- Mapping ----

test('toIncidentItem maps every field of the spec 5.4 incident shape', () => {
  const item = toIncidentItem(incidentRow, '0.2.0-faulty');
  assert.deepEqual(item, {
    incident_id: INCIDENT_ID,
    revision: 2,
    title: `Payments 5xx burst after deployment ${DEPLOYMENT_ID}`,
    status: 'open',
    severity: 'high',
    service: 'demo-payments',
    environment: 'local',
    deployment_id: DEPLOYMENT_ID,
    deployment_version: '0.2.0-faulty',
    trigger_rule: 'payments-5xx-burst-after-deployment',
    started_at: '2026-10-03T12:00:05.123000000Z',
    detected_at: '2026-10-03T12:00:12.456000000Z',
    publication_state: 'published',
    published_at: '2026-10-03T12:00:13.001000000Z',
  });
});

test('the quoted ClickHouse revision string becomes a numeric API revision', () => {
  assert.equal(toIncidentItem({ ...incidentRow, revision: '17' }, null).revision, 17);
});

test('deployment_version is null when no matching deployment was found', () => {
  assert.equal(toIncidentItem(incidentRow, null).deployment_version, null);
});

test('published_at is null unless the publication state is published', () => {
  const pending = toIncidentItem({ ...incidentRow, publication_state: 'pending', published_at: null }, null);
  assert.equal(pending.publication_state, 'pending');
  assert.equal(pending.published_at, null);

  // Even if a value were present, a pending revision reports no publish time.
  const stillPending = toIncidentItem({ ...incidentRow, publication_state: 'pending' }, null);
  assert.equal(stillPending.published_at, null);
});

test('a non-numeric revision is rejected rather than guessed', () => {
  assert.throws(() => toIncidentItem({ ...incidentRow, revision: 'two' }, null), TypeError);
});

test('toDeploymentItem maps the list shape with class, failing count, and incident IDs', () => {
  const row: RecentDeploymentRow = {
    deployment_id: DEPLOYMENT_ID,
    timestamp: '2026-10-03 12:00:00.000000000',
    environment: 'local',
    new_version: '0.2.0-faulty',
    previous_version: '',
    status: 'succeeded',
  };
  assert.deepEqual(toDeploymentItem(row, 3, [INCIDENT_ID]), {
    deployment_id: DEPLOYMENT_ID,
    timestamp: '2026-10-03T12:00:00.000000000Z',
    environment: 'local',
    new_version: '0.2.0-faulty',
    status: 'succeeded',
    class: 'faulty',
    failing_traces: 3,
    incident_ids: [INCIDENT_ID],
  });
});

test('toDeploymentItem reports a clean deployment as healthy with a zero count', () => {
  const row: RecentDeploymentRow = {
    deployment_id: DEPLOYMENT_ID,
    timestamp: '2026-10-03 12:00:00.000000000',
    environment: 'local',
    new_version: '0.1.0',
    previous_version: '',
    status: 'succeeded',
  };
  const item = toDeploymentItem(row, 0, []);
  assert.equal(item.class, 'healthy');
  assert.equal(item.failing_traces, 0);
  assert.deepEqual(item.incident_ids, []);
});

test('toDeploymentDetail maps the incident deployment object and nulls an empty previous_version', () => {
  assert.deepEqual(toDeploymentDetail(deploymentRow), {
    deployment_id: DEPLOYMENT_ID,
    timestamp: '2026-10-03T12:00:00.000000000Z',
    environment: 'local',
    new_version: '0.2.0-faulty',
    previous_version: null,
    initiated_by: 'deploy-payments-script',
    status: 'succeeded',
  });
  assert.equal(toDeploymentDetail({ ...deploymentRow, previous_version: '0.1.0' }).previous_version, '0.1.0');
});

test('toEvidenceItem preserves type, reference, timestamp, service, summary, and reliability', () => {
  const row: EvidenceRow = {
    evidence_id: 'b8a09870-65f0-407a-baa2-ee772ecea58c',
    source_type: 'trace',
    source_ref: '70c13b1f8287d5205b842d532c6f09ea',
    timestamp: '2026-10-03 12:00:05.123456789',
    service: 'demo-payments',
    summary: 'demo-payments returned HTTP 500 for trace 70c13b1f8287d5205b842d532c6f09ea',
    reliability: 'high',
  };
  assert.deepEqual(toEvidenceItem(row), {
    evidence_id: 'b8a09870-65f0-407a-baa2-ee772ecea58c',
    source_type: 'trace',
    source_ref: '70c13b1f8287d5205b842d532c6f09ea',
    timestamp: '2026-10-03T12:00:05.123456789Z',
    service: 'demo-payments',
    summary: 'demo-payments returned HTTP 500 for trace 70c13b1f8287d5205b842d532c6f09ea',
    reliability: 'high',
  });
});

// ---- Nanosecond precision ----

test('all nine fractional digits survive conversion, including the last one', () => {
  const row: EvidenceRow = {
    evidence_id: 'b8a09870-65f0-407a-baa2-ee772ecea58c',
    source_type: 'deployment',
    source_ref: DEPLOYMENT_ID,
    timestamp: '2026-10-03 12:00:05.000000001',
    service: 'demo-payments',
    summary: 'x',
    reliability: 'high',
  };
  assert.equal(toEvidenceItem(row).timestamp, '2026-10-03T12:00:05.000000001Z');
  assert.equal(toEvidenceItem({ ...row, timestamp: '2026-10-03 12:00:05.999999999' }).timestamp, '2026-10-03T12:00:05.999999999Z');
});

test('a timestamp with a missing or short fraction is rejected instead of padded', () => {
  for (const bad of ['2026-10-03 12:00:05', '2026-10-03 12:00:05.123', '2026-10-03T12:00:05.123000000Z', '']) {
    assert.throws(() => toEvidenceItem({ ...evidenceFixture(), timestamp: bad }), TypeError, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a nullable timestamp that is null stays null', () => {
  assert.equal(toIncidentItem({ ...incidentRow, publication_state: 'published', published_at: null }, null).published_at, null);
});

function evidenceFixture(): EvidenceRow {
  return {
    evidence_id: 'b8a09870-65f0-407a-baa2-ee772ecea58c',
    source_type: 'trace',
    source_ref: '70c13b1f8287d5205b842d532c6f09ea',
    timestamp: '2026-10-03 12:00:05.123456789',
    service: 'demo-payments',
    summary: 'x',
    reliability: 'high',
  };
}

test('toDiagnosisSummary exposes only the version, the status, and the confidence', () => {
  assert.deepEqual(
    toDiagnosisSummary({ incident_id: INCIDENT_ID, diagnosis_version: 2, status: 'completed', confidence: 'high' }),
    { diagnosis_version: 2, status: 'completed', confidence: 'high' },
  );
  assert.deepEqual(
    toDiagnosisSummary({ incident_id: INCIDENT_ID, diagnosis_version: 1, status: 'abstained', confidence: 'low' }),
    { diagnosis_version: 1, status: 'abstained', confidence: 'low' },
  );
});

test('toDiagnosisSummary reports a failed diagnosis with a null confidence', () => {
  assert.deepEqual(
    toDiagnosisSummary({ incident_id: INCIDENT_ID, diagnosis_version: 3, status: 'failed', confidence: '' }),
    { diagnosis_version: 3, status: 'failed', confidence: null },
  );
});

test('toDiagnosisSummary returns null for any row that is not a valid summary', () => {
  const bad = [
    { diagnosis_version: 0, status: 'completed', confidence: 'high' },
    { diagnosis_version: 1.5, status: 'completed', confidence: 'high' },
    { diagnosis_version: '1', status: 'completed', confidence: 'high' },
    { diagnosis_version: 1, status: 'bogus', confidence: 'high' },
    { diagnosis_version: 1, status: 'completed', confidence: 'certain' },
    { diagnosis_version: 1, status: 'completed', confidence: '' },
    { diagnosis_version: 1, status: 'abstained', confidence: 'high' },
    { diagnosis_version: 1, status: 'failed', confidence: 'low' },
  ];
  for (const row of bad) {
    assert.equal(toDiagnosisSummary({ incident_id: INCIDENT_ID, ...row } as never), null, JSON.stringify(row));
  }
});
