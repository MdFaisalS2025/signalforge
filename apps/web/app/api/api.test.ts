import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDashboardService, createDashboardService } from '../../src/server/service';
import { ClickHouseUnavailable, type ClickHouseReader, type IncidentRow } from '../../src/server/clickhouse';
import * as incidentsRoute from './incidents/route';
import * as incidentDetailRoute from './incidents/[incidentId]/route';
import * as deploymentsRoute from './deployments/route';

const INCIDENT_ID = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const DEPLOYMENT_ID = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';
const FIXED_NOW = new Date('2026-10-06T14:05:00.000Z');
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

function fakeRepo(overrides: Partial<ClickHouseReader>): ClickHouseReader {
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

// Installs a service whose repository is the given fake, for the duration of one test.
function useRepo(overrides: Partial<ClickHouseReader>) {
  installDashboardService(createDashboardService({ repo: fakeRepo(overrides), now: () => FIXED_NOW }));
}

function detailContext(incidentId: string) {
  return { params: Promise.resolve({ incidentId }) };
}

type Probe = { status: number; headers: Headers; text: string; json: unknown };

async function probe(response: Response): Promise<Probe> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function listUrl(query = '') {
  return `http://localhost:3000/api/incidents${query}`;
}

function detailUrl(id: string) {
  return `http://localhost:3000/api/incidents/${id}`;
}

function deploymentsUrl(query = '') {
  return `http://localhost:3000/api/deployments${query}`;
}

beforeEach(() => {
  useRepo({});
});

// ---- Successful reads ----

test('GET /api/incidents returns 200 with the spec envelope and no-store caching', async () => {
  useRepo({
    listIncidents: async () => [incidentRow],
    getDeployment: async () => ({
      deployment_id: DEPLOYMENT_ID,
      timestamp: '2026-10-03 12:00:00.000000000',
      service: 'demo-payments',
      environment: 'local',
      new_version: '0.2.0-faulty',
      previous_version: '',
      initiated_by: 'deploy-payments-script',
      status: 'succeeded',
    }),
  });
  const result = await probe(await incidentsRoute.GET(new Request(listUrl('?limit=5'))));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(result.headers.get('content-type') ?? '', /application\/json/);
  const body = result.json as { generated_at: string; incidents: Array<{ deployment_version: string }> };
  assert.equal(body.generated_at, '2026-10-06T14:05:00.000Z');
  assert.equal(body.incidents[0].deployment_version, '0.2.0-faulty');
});

test('GET /api/incidents/{id} returns 200 with incident, explanation, deployment, and evidence', async () => {
  useRepo({
    getIncident: async () => incidentRow,
    getDeployment: async () => ({
      deployment_id: DEPLOYMENT_ID,
      timestamp: '2026-10-03 12:00:00.000000000',
      service: 'demo-payments',
      environment: 'local',
      new_version: '0.2.0-faulty',
      previous_version: '',
      initiated_by: 'deploy-payments-script',
      status: 'succeeded',
    }),
    listEvidence: async () => [],
  });
  const result = await probe(await incidentDetailRoute.GET(new Request(detailUrl(INCIDENT_ID)), detailContext(INCIDENT_ID)));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = result.json as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['deployment', 'evidence', 'explanation', 'generated_at', 'incident']);
});

test('GET /api/deployments returns 200 with class, failing_traces, and incident_ids', async () => {
  useRepo({
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
    incidentLinks: async () => [{ incident_id: INCIDENT_ID, deployment_id: DEPLOYMENT_ID, started_at: '2026-10-03 12:00:05.123000000' }],
  });
  const result = await probe(await deploymentsRoute.GET(new Request(deploymentsUrl('?limit=10'))));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = result.json as { deployments: Array<Record<string, unknown>> };
  assert.equal(body.deployments[0].class, 'faulty');
  assert.equal(body.deployments[0].failing_traces, 3);
  assert.deepEqual(body.deployments[0].incident_ids, [INCIDENT_ID]);
});

// ---- Client errors ----

test('an invalid list limit returns 400 invalid_input naming limit', async () => {
  const result = await probe(await incidentsRoute.GET(new Request(listUrl('?limit=0'))));
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { error: 'invalid_input', field: 'limit' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('a malformed incident ID returns 400 invalid_input naming incident_id', async () => {
  const result = await probe(await incidentDetailRoute.GET(new Request(detailUrl('not-a-uuid')), detailContext('not-a-uuid')));
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { error: 'invalid_input', field: 'incident_id' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('an unknown valid incident ID returns 404 incident_not_found', async () => {
  useRepo({ getIncident: async () => null });
  const result = await probe(await incidentDetailRoute.GET(new Request(detailUrl(INCIDENT_ID)), detailContext(INCIDENT_ID)));
  assert.equal(result.status, 404);
  assert.deepEqual(result.json, { error: 'incident_not_found' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('an invalid deployment limit returns 400 invalid_input naming limit', async () => {
  const result = await probe(await deploymentsRoute.GET(new Request(deploymentsUrl('?limit=51'))));
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { error: 'invalid_input', field: 'limit' });
});

// ---- Server errors ----

test('an unavailable ClickHouse returns exactly 503 clickhouse_unavailable on every read route', async () => {
  const unavailable = async () => {
    throw new ClickHouseUnavailable();
  };
  useRepo({ listIncidents: unavailable, getIncident: unavailable, listDeployments: unavailable });
  const responses = [
    await incidentsRoute.GET(new Request(listUrl())),
    await incidentDetailRoute.GET(new Request(detailUrl(INCIDENT_ID)), detailContext(INCIDENT_ID)),
    await deploymentsRoute.GET(new Request(deploymentsUrl())),
  ];
  for (const response of responses) {
    const result = await probe(response);
    assert.equal(result.status, 503);
    assert.equal(result.text, '{"error":"clickhouse_unavailable"}');
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
});

test('an unexpected failure returns a generic 500 whose body carries no SQL, driver text, or stack', async () => {
  useRepo({
    listIncidents: async () => {
      throw new Error('Code: 62. DB::Exception: Syntax error near SELECT count() FROM incidents\n    at fake (file.ts:1:1)');
    },
  });
  const result = await probe(await incidentsRoute.GET(new Request(listUrl())));
  assert.equal(result.status, 500);
  assert.deepEqual(result.json, { error: 'internal_error' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

// ---- Method restrictions ----

test('every non-GET method returns 405 with Allow: GET on every route', async () => {
  const routes: Array<{ name: string; handlers: Record<string, unknown>; context: unknown; url: string }> = [
    { name: '/api/incidents', handlers: incidentsRoute, context: undefined, url: listUrl() },
    { name: '/api/incidents/{id}', handlers: incidentDetailRoute, context: detailContext(INCIDENT_ID), url: detailUrl(INCIDENT_ID) },
    { name: '/api/deployments', handlers: deploymentsRoute, context: undefined, url: deploymentsUrl() },
  ];
  for (const route of routes) {
    for (const method of METHODS) {
      const handler = route.handlers[method] as (request: Request, context?: unknown) => Response | Promise<Response>;
      assert.equal(typeof handler, 'function', `${route.name} must export ${method} explicitly`);
      const result = await probe(await handler(new Request(route.url, { method }), route.context));
      assert.equal(result.status, 405, `${method} ${route.name}`);
      assert.equal(result.headers.get('allow'), 'GET', `${method} ${route.name} Allow header`);
      assert.equal(result.headers.get('cache-control'), 'no-store', `${method} ${route.name} caching`);
    }
  }
});

test('the GET handler is the only exported method on each route besides the explicit 405 handlers', () => {
  for (const module of [incidentsRoute, incidentDetailRoute, deploymentsRoute]) {
    assert.equal(typeof module.GET, 'function');
  }
});

// ---- Response hygiene across every outcome ----

test('no error body contains SELECT, Code:, or a stack frame', async () => {
  useRepo({
    getIncident: async () => {
      throw new Error('Code: 47. DB::Exception: Unknown identifier SELECT id FROM incidents\n    at Object.run (db.ts:9:3)');
    },
  });
  const bodies = [
    await probe(await incidentsRoute.GET(new Request(listUrl('?limit=bad')))),
    await probe(await incidentDetailRoute.GET(new Request(detailUrl('nope')), detailContext('nope'))),
    await probe(await incidentDetailRoute.GET(new Request(detailUrl(INCIDENT_ID)), detailContext(INCIDENT_ID))),
    await probe(incidentsRoute.POST()),
  ];
  for (const body of bodies) {
    assert.ok(!body.text.includes('SELECT'), `body leaks SQL: ${body.text}`);
    assert.ok(!body.text.includes('Code:'), `body leaks a driver code: ${body.text}`);
    assert.ok(!/\n\s+at /.test(body.text), `body leaks a stack frame: ${body.text}`);
    assert.equal(body.headers.get('cache-control'), 'no-store');
  }
});

// ---- Exact content type ----
// The contract (spec 5.4) requires exactly "application/json; charset=utf-8", not just any JSON type.

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

test('every JSON success response carries exactly "application/json; charset=utf-8" and no-store', async () => {
  useRepo({
    listIncidents: async () => [],
    getIncident: async () => incidentRow,
    getDeployment: async () => null,
    listEvidence: async () => [],
    listDeployments: async () => [],
  });
  const responses = [
    await incidentsRoute.GET(new Request(listUrl())),
    await incidentDetailRoute.GET(new Request(detailUrl(INCIDENT_ID)), detailContext(INCIDENT_ID)),
    await deploymentsRoute.GET(new Request(deploymentsUrl())),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), JSON_CONTENT_TYPE);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('every JSON error response (400, 404, 500, 503, 405) carries exactly "application/json; charset=utf-8"', async () => {
  const unavailable = async () => {
    throw new ClickHouseUnavailable();
  };
  const responses: Response[] = [];
  responses.push(await incidentsRoute.GET(new Request(listUrl('?limit=0'))));
  useRepo({ getIncident: async () => null });
  responses.push(await incidentDetailRoute.GET(new Request(detailUrl(INCIDENT_ID)), detailContext(INCIDENT_ID)));
  useRepo({ listIncidents: unavailable });
  responses.push(await incidentsRoute.GET(new Request(listUrl())));
  useRepo({
    listIncidents: async () => {
      throw new Error('Code: 62. DB::Exception: SELECT leak');
    },
  });
  responses.push(await incidentsRoute.GET(new Request(listUrl())));
  responses.push(await incidentsRoute.POST());
  assert.deepEqual(responses.map((r) => r.status), [400, 404, 503, 500, 405]);
  for (const response of responses) {
    assert.equal(response.headers.get('content-type'), JSON_CONTENT_TYPE);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /SELECT|Code:/);
  }
});
