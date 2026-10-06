import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardService, IncidentNotFound } from './service';
import { ClickHouseUnavailable, type ClickHouseReader, type DeploymentRow, type IncidentRow } from './clickhouse';
import { InvalidInput } from './validate';

const FIXED_NOW = new Date('2026-10-06T14:05:00.000Z');
const INCIDENT_A = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const INCIDENT_B = '64d254ef-85a6-51ef-b4ab-80bc16c71baa';
const DEPLOYMENT_ID = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';
const OTHER_DEPLOYMENT_ID = '6144d723-a25b-407c-a50c-ae83e454a849';

// A repository whose every operation fails the test unless the test overrides it.
function fakeRepo(overrides: Partial<ClickHouseReader> = {}): ClickHouseReader {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected repository call');
  };
  return {
    listIncidents: unexpected,
    getIncident: unexpected,
    listEvidence: unexpected,
    getDeployment: unexpected,
    listDeployments: unexpected,
    failingTraces: unexpected,
    incidentLinks: unexpected,
    ...overrides,
  };
}

function incidentRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    incident_id: INCIDENT_A,
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
    ...overrides,
  };
}

function deploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    deployment_id: DEPLOYMENT_ID,
    timestamp: '2026-10-03 12:00:00.000000000',
    service: 'demo-payments',
    environment: 'local',
    new_version: '0.2.0-faulty',
    previous_version: '',
    initiated_by: 'deploy-payments-script',
    status: 'succeeded',
    ...overrides,
  };
}

function service(repo: ClickHouseReader) {
  return createDashboardService({ repo, now: () => FIXED_NOW });
}

// ---- GET /api/incidents ----

test('listIncidents returns the spec 5.4 envelope with a clock-based generated_at', async () => {
  const result = await service(
    fakeRepo({
      listIncidents: async () => [incidentRow()],
      getDeployment: async () => deploymentRow(),
    }),
  ).listIncidents(undefined);
  assert.equal(result.generated_at, '2026-10-06T14:05:00.000Z');
  assert.ok(Array.isArray(result.incidents));
  assert.deepEqual(Object.keys(result).sort(), ['generated_at', 'incidents']);
});

test('listIncidents sorts newest first by detected_at, whatever order the repository returns', async () => {
  const older = incidentRow({ incident_id: INCIDENT_B, detected_at: '2026-10-02 08:00:00.000000000' });
  const newer = incidentRow({ incident_id: INCIDENT_A, detected_at: '2026-10-03 12:00:12.456000000' });
  const result = await service(
    fakeRepo({ listIncidents: async () => [older, newer], getDeployment: async () => deploymentRow() }),
  ).listIncidents(undefined);
  assert.deepEqual(
    result.incidents.map((item) => item.incident_id),
    [INCIDENT_A, INCIDENT_B],
  );
});

test('listIncidents joins each incident to its deployment version', async () => {
  const result = await service(
    fakeRepo({
      listIncidents: async () => [incidentRow()],
      getDeployment: async () => deploymentRow({ new_version: '0.2.0-faulty' }),
    }),
  ).listIncidents(undefined);
  assert.equal(result.incidents[0].deployment_version, '0.2.0-faulty');
});

test('listIncidents maps a missing deployment to a null version', async () => {
  const result = await service(
    fakeRepo({ listIncidents: async () => [incidentRow()], getDeployment: async () => null }),
  ).listIncidents(undefined);
  assert.equal(result.incidents[0].deployment_version, null);
});

test('listIncidents looks up each distinct deployment once', async () => {
  let lookups = 0;
  await service(
    fakeRepo({
      listIncidents: async () => [incidentRow(), incidentRow({ incident_id: INCIDENT_B })],
      getDeployment: async () => {
        lookups += 1;
        return deploymentRow();
      },
    }),
  ).listIncidents(undefined);
  assert.equal(lookups, 1);
});

test('listIncidents defaults the limit to 20 and passes a validated limit to the repository', async () => {
  const seen: number[] = [];
  const repo = fakeRepo({
    listIncidents: async (limit) => {
      seen.push(limit);
      return [];
    },
  });
  await service(repo).listIncidents(undefined);
  await service(repo).listIncidents('5');
  assert.deepEqual(seen, [20, 5]);
});

test('listIncidents rejects an invalid limit with InvalidInput and never queries', async () => {
  let called = false;
  const repo = fakeRepo({
    listIncidents: async () => {
      called = true;
      return [];
    },
  });
  for (const bad of ['0', '101', 'abc', '1.5']) {
    await assert.rejects(
      () => service(repo).listIncidents(bad),
      (error: unknown) => error instanceof InvalidInput && error.field === 'limit',
    );
  }
  assert.equal(called, false);
});

// ---- GET /api/incidents/{incident_id} ----

test('getIncidentDetail returns incident, explanation, deployment, and evidence', async () => {
  const result = await service(
    fakeRepo({
      getIncident: async () => incidentRow(),
      getDeployment: async () => deploymentRow(),
      listEvidence: async () => [
        {
          evidence_id: 'b8a09870-65f0-407a-baa2-ee772ecea58c',
          source_type: 'deployment',
          source_ref: DEPLOYMENT_ID,
          timestamp: '2026-10-03 12:00:00.000000000',
          service: 'demo-payments',
          summary: 'demo-payments version 0.2.0-faulty deployed',
          reliability: 'high',
        },
      ],
    }),
  ).getIncidentDetail(INCIDENT_A);

  assert.deepEqual(Object.keys(result).sort(), ['deployment', 'evidence', 'explanation', 'generated_at', 'incident']);
  assert.equal(result.incident.incident_id, INCIDENT_A);
  assert.equal(result.incident.deployment_version, '0.2.0-faulty');
  assert.equal(result.deployment?.new_version, '0.2.0-faulty');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].timestamp, '2026-10-03T12:00:00.000000000Z');
  assert.match(result.explanation, /^Three distinct Payments 5xx traces within 30 seconds after this deployment/);
});

test('getIncidentDetail throws IncidentNotFound when no incident has the ID', async () => {
  await assert.rejects(
    () => service(fakeRepo({ getIncident: async () => null })).getIncidentDetail(INCIDENT_A),
    IncidentNotFound,
  );
});

test('getIncidentDetail rejects a malformed ID with InvalidInput and never queries', async () => {
  let called = false;
  const repo = fakeRepo({
    getIncident: async () => {
      called = true;
      return null;
    },
  });
  await assert.rejects(
    () => service(repo).getIncidentDetail('not-a-uuid'),
    (error: unknown) => error instanceof InvalidInput && error.field === 'incident_id',
  );
  assert.equal(called, false);
});

test('getIncidentDetail reports a null deployment when the incident\'s deployment row is missing', async () => {
  const result = await service(
    fakeRepo({
      getIncident: async () => incidentRow(),
      getDeployment: async () => null,
      listEvidence: async () => [],
    }),
  ).getIncidentDetail(INCIDENT_A);
  assert.equal(result.deployment, null);
  assert.equal(result.incident.deployment_version, null);
});

// ---- GET /api/deployments ----

test('listDeployments returns the envelope with class, failing_traces, and incident_ids', async () => {
  const result = await service(
    fakeRepo({
      listDeployments: async () => [
        {
          deployment_id: DEPLOYMENT_ID,
          timestamp: '2026-10-03 12:00:00.000000000',
          environment: 'local',
          new_version: '0.2.0-faulty',
          previous_version: '',
          status: 'succeeded',
        },
      ],
      failingTraces: async () => [{ deployment_id: DEPLOYMENT_ID, failing_traces: '3' }],
      incidentLinks: async () => [{ incident_id: INCIDENT_A, deployment_id: DEPLOYMENT_ID, started_at: '2026-10-03 12:00:05.123000000' }],
    }),
  ).listDeployments(undefined);

  assert.equal(result.generated_at, '2026-10-06T14:05:00.000Z');
  assert.deepEqual(result.deployments, [
    {
      deployment_id: DEPLOYMENT_ID,
      timestamp: '2026-10-03T12:00:00.000000000Z',
      environment: 'local',
      new_version: '0.2.0-faulty',
      status: 'succeeded',
      class: 'faulty',
      failing_traces: 3,
      incident_ids: [INCIDENT_A],
    },
  ]);
});

test('listDeployments classifies a clean deployment as healthy with zero failures', async () => {
  const result = await service(
    fakeRepo({
      listDeployments: async () => [
        {
          deployment_id: DEPLOYMENT_ID,
          timestamp: '2026-10-03 12:00:00.000000000',
          environment: 'local',
          new_version: '0.1.0',
          previous_version: '',
          status: 'succeeded',
        },
      ],
      failingTraces: async () => [],
      incidentLinks: async () => [],
    }),
  ).listDeployments(undefined);
  assert.equal(result.deployments[0].class, 'healthy');
  assert.equal(result.deployments[0].failing_traces, 0);
  assert.deepEqual(result.deployments[0].incident_ids, []);
});

test('listDeployments skips the failure and link queries when there are no deployments', async () => {
  let secondaryCalls = 0;
  const result = await service(
    fakeRepo({
      listDeployments: async () => [],
      failingTraces: async () => {
        secondaryCalls += 1;
        return [];
      },
      incidentLinks: async () => {
        secondaryCalls += 1;
        return [];
      },
    }),
  ).listDeployments(undefined);
  assert.deepEqual(result.deployments, []);
  assert.equal(secondaryCalls, 0);
});

test('listDeployments defaults the limit to 10 and caps it at 50', async () => {
  const seen: number[] = [];
  const repo = fakeRepo({
    listDeployments: async (limit) => {
      seen.push(limit);
      return [];
    },
  });
  await service(repo).listDeployments(undefined);
  await service(repo).listDeployments('50');
  assert.deepEqual(seen, [10, 50]);
  await assert.rejects(() => service(repo).listDeployments('51'), InvalidInput);
});

test('an unavailable ClickHouse surfaces unchanged so the route can map it', async () => {
  await assert.rejects(
    () => service(fakeRepo({ listIncidents: async () => { throw new ClickHouseUnavailable(); } })).listIncidents(undefined),
    ClickHouseUnavailable,
  );
});
