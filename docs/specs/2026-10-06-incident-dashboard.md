# Incident dashboard slice

Status: **Proposed for review.** Implementation must not begin until this status line is changed to
"Approved for implementation" with an approval date.
Implements: the operator dashboard milestone in `SignalForge_Project_Plan.docx` section 9.11 (Week 4).
Builds on: [2026-10-03-faulty-deployment-incident-correlation.md](2026-10-03-faulty-deployment-incident-correlation.md)
and [ADR 0004](../decisions/0004-faulty-deployment-correlation.md), which are merged to `master`.
The correlation pipeline, its schema, its topics, and its acceptance script are not changed by this slice.

## 1. Purpose

Make the existing faulty-deployment pipeline visible in one local page. An operator who runs the demo
flow in section 10 should be able to see, in a browser:

1. the incidents the correlator created, with their severity, status, service, deployment version,
   detection time, and publication state;
2. for one incident, the deployment it is linked to, the four evidence rows, and the rule that produced it;
3. a timeline of recent Payments deployments, showing which were faulty and which incident is tied to which;
4. the exact commands that create a faulty deployment and open the resulting incident.

The dashboard displays what ClickHouse already holds. It computes nothing that a rule does not define, and
it never writes.

## 2. Non-goals

- No authentication, sessions, roles, or any form of access control. The dashboard binds to the local host only.
- No mutation UI and no mutating API routes. Acknowledge, resolve, retry publication, and deploy buttons do not exist.
- No real-time streaming, WebSocket, or server-sent events. The page loads data on request. A manual refresh
  control is the only way to see new rows.
- No diagnosis, retrieval, citations, or agent output (Week 5). No Temporal or remediation views (Week 6).
- No cloud, Kubernetes, or production deployment. No TLS. No ingress.
- No changes to `demo-orders`, `demo-payments`, the OpenTelemetry Collector pipeline, the normalizer, the
  correlator, the publisher, the topics, or the ClickHouse tables and migrations.
- No new deployment fields. The dashboard does not ask the deploy script or the Payments service to record
  fault mode (section 5.3).
- No charting library. The timeline is a positioned SVG built by hand.

## 3. Current state the dashboard depends on

| Source | What exists today | What the dashboard uses |
|---|---|---|
| `incidents` (`ReplacingMergeTree(revision)`) | One row per revision. `publication_state` is `pending` or `published`. `published_at` is `Nullable`, set only in the published revision. `service`, `deployment_id`, `title`, `status`, `severity`, `started_at`, `detected_at`, `trigger_rule` are populated. | Read with `FINAL` for the latest revision. |
| `evidence_items` (`ReplacingMergeTree(ingested_at)`) | Four rows per incident: one `deployment` row and three `trace` rows, `reliability = high`. | Read with `FINAL` by `incident_id`. |
| `deployments` (`ReplacingMergeTree(ingested_at)`) | `deployment_id`, `timestamp`, `service`, `environment`, `new_version`, `previous_version` (usually empty), `initiated_by`, `status`. The deploy script publishes only `status = succeeded`. | Read with `FINAL`. |
| `telemetry_events` (`ReplacingMergeTree(ingested_at)`) | Canonical trace rows with `deployment_id`, `trace_id`, `service`, and `attributes` as a JSON string. | Failure counts per deployment, using the same filter the correlator uses (section 5.2). |

Facts the design relies on, checked against the migration and the correlator code:

- The detection rule is defined in the correlation spec, section 10.1: three distinct `demo-payments` server
  spans with HTTP 500 and a `deployment_id`, within 30 seconds, first failure at most five minutes after a
  succeeded deployment. The dashboard quotes this rule. It does not re-evaluate it.
- `incidents.deployment_id` is a `String`. `deployments.deployment_id` is a `UUID`. Joins compare strings.
- Incident and evidence IDs are deterministic UUIDv5 values. The same burst always has the same IDs.

## 4. Visual direction

**Clean operational console.** The page should read like a tool an on-call engineer keeps open, not like a
SaaS admin template. Concretely:

- **Density over decoration.** Tables with tight rows, a 13px base size, and no stat-card grid.
- **Dark graphite base** (`#0f1216` background, `#161b22` surface, `#222a33` hairline borders) with
  light-gray text (`#d6dde6`) and muted labels (`#8492a0`). Light mode is out of scope for this slice.
- **One signal color per meaning, nothing else colored:**
  - amber `#f0b429` for `high` severity and for the `pending` publication state;
  - red `#ff5c5c` for a faulty deployment and for failure counts;
  - green `#3ddc97` for `published` and for a healthy deployment;
  - blue `#6aa9ff` only for the selected row and the focus ring.
- **Monospace for identifiers and timestamps** (`ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`),
  because operators copy IDs. UTC timestamps are shown in ISO-8601 with a `Z` suffix, and the local time
  appears in a title attribute.
- **A left rail** with three entries: Incidents, Deployments, Demo. The rail is the only navigation.
- **Status is a dot plus a word**, never color alone, so the page remains readable for color-blind viewers.
- **Timeline** on the Deployments page: a horizontal axis in UTC, one marker per deployment, faulty markers in
  red, healthy markers in green, and a connector line from each incident-linked deployment to its incident
  marker. Hovering shows the exact timestamp.

The dashboard is desktop-first at 1280 px wide. Below 960 px the rail collapses to a top bar. It is not
designed for phones.

## 5. Data contract

### 5.1 Architecture

```
browser ──HTTP──▶ apps/web (Next.js)
                    ├─ pages (server components, read-only)
                    └─ /api/* route handlers (GET only) ──HTTP 8123──▶ ClickHouse
                                                       user: dashboard_reader (readonly=1)
```

- The browser never contacts ClickHouse. The only host it talks to is `localhost:3000`.
- All ClickHouse access goes through one server-side module, `apps/web/src/server/clickhouse.ts`. Nothing
  under `app/` imports the client directly except through that module.
- Queries use the ClickHouse HTTP interface with bound query parameters (`{name:Type}` syntax). No query
  text is built from request input. Route inputs are validated before they reach the module.
- The client library is `@clickhouse/client` (official). Its version is pinned in `apps/web/package-lock.json`.

### 5.2 ClickHouse queries

All queries read the latest revision with `FINAL`, as the correlator does.

**Q1 incident list**

```sql
SELECT incident_id, revision, title, status, severity, service, environment, deployment_id,
       trigger_rule, started_at, detected_at, publication_state, published_at
FROM incidents FINAL
ORDER BY detected_at DESC
LIMIT {limit:UInt32}
```

`limit` defaults to 20 and is capped at 100 by the route.

**Q2 one incident**

```sql
SELECT ... FROM incidents FINAL WHERE incident_id = {incident_id:UUID}
```

**Q3 evidence for one incident**

```sql
SELECT evidence_id, source_type, source_ref, timestamp, service, summary, reliability
FROM evidence_items FINAL
WHERE incident_id = {incident_id:UUID}
ORDER BY timestamp, source_type, source_ref
```

**Q4 deployment for one incident**

```sql
SELECT deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status
FROM deployments FINAL
WHERE toString(deployment_id) = {deployment_id:String}
```

**Q5 recent Payments deployments**

```sql
SELECT deployment_id, timestamp, environment, new_version, previous_version, status
FROM deployments FINAL
WHERE service = 'demo-payments'
ORDER BY timestamp DESC
LIMIT {limit:UInt32}
```

Status is not filtered here. The timeline shows every deployment row the deploy script wrote, which in
practice is `succeeded` only (section 3). A deployment with another status is shown with that status
label and is never classified as healthy.

**Q6 failing traces per deployment**

```sql
SELECT deployment_id, uniqExact(trace_id) AS failing_traces
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
GROUP BY deployment_id
```

This is the correlator's filter (`failureTracesSQL`, `clickhouse.go`), counted per deployment. It is applied
only to the deployment IDs Q5 returned, so the scan is bounded by the timeline limit.

**Q7 incident linkage for the timeline**

```sql
SELECT incident_id, deployment_id, started_at
FROM incidents FINAL
WHERE deployment_id IN {deployment_ids:Array(String)}
```

### 5.3 Classification of deployments

The `deployments` row does not record fault mode, and this slice does not add it (section 2). Classification
therefore uses only what telemetry and incidents show:

| Class | Rule | Label on the page |
|---|---|---|
| `faulty` | `failing_traces >= 1` **or** at least one incident row has this `deployment_id` | "Faulty: N HTTP 500 traces" |
| `healthy` | `status = 'succeeded'`, `failing_traces = 0`, no incident | "No failures observed" |
| `unknown` | any other status | the status value |

"No failures observed" is deliberately not "healthy". A deployment with no traffic is not proven healthy.
The page's footnote states this.

The explanation sentence for an incident is a fixed template per `trigger_rule`, filled from the incident's
own fields. For `payments-5xx-burst-after-deployment` it reads:

> Three distinct Payments 5xx traces within 30 seconds after this deployment (`<deployment_id>`,
> `<new_version>`). The first trace was at `<started_at>`.

An unknown `trigger_rule` shows the raw rule name and the sentence "No explanation template for this rule."

### 5.4 Public API (BFF, read-only)

All routes are `GET`. Every other method returns `405` with `Allow: GET`. Responses are JSON with
`Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

**`GET /api/incidents?limit=20`**

```json
{
  "generated_at": "2026-10-06T14:05:00.000Z",
  "incidents": [
    {
      "incident_id": "uuid",
      "revision": 2,
      "title": "Payments 5xx burst after deployment <uuid>",
      "status": "open",
      "severity": "high",
      "service": "demo-payments",
      "environment": "local",
      "deployment_id": "uuid",
      "deployment_version": "0.2.0-faulty",
      "trigger_rule": "payments-5xx-burst-after-deployment",
      "started_at": "2026-10-06T14:02:10.123000000Z",
      "detected_at": "2026-10-06T14:02:12.456000000Z",
      "publication_state": "published",
      "published_at": "2026-10-06T14:02:13.001000000Z"
    }
  ]
}
```

`deployment_version` is joined from Q4 in the same request. It is `null` when no deployment row matches.
`published_at` is `null` unless `publication_state` is `published`.

**`GET /api/incidents/{incident_id}`**

```json
{
  "generated_at": "2026-10-06T14:05:00.000Z",
  "incident": { "...same fields as the list item...": "" },
  "explanation": "Three distinct demo-payments HTTP 500 traces occurred within 30 seconds, the first at 2026-10-06T14:02:10.123Z, after deployment 4f1e… (0.2.0-faulty) succeeded.",
  "deployment": {
    "deployment_id": "uuid",
    "timestamp": "2026-10-06T14:01:30.000000000Z",
    "environment": "local",
    "new_version": "0.2.0-faulty",
    "previous_version": null,
    "initiated_by": "deploy-payments-script",
    "status": "succeeded"
  },
  "evidence": [
    {
      "evidence_id": "uuid",
      "source_type": "deployment",
      "source_ref": "uuid",
      "timestamp": "2026-10-06T14:01:30.000000000Z",
      "service": "demo-payments",
      "summary": "demo-payments version 0.2.0-faulty deployed",
      "reliability": "high"
    }
  ]
}
```

Returns `404` with `{"error":"incident_not_found"}` when Q2 returns no row. The `evidence` array has exactly
four items for a complete incident. The page shows a warning, not an error, when it has fewer.

`previous_version` is `null` when the stored value is empty.

**`GET /api/deployments?limit=10`**

```json
{
  "generated_at": "2026-10-06T14:05:00.000Z",
  "deployments": [
    {
      "deployment_id": "uuid",
      "timestamp": "2026-10-06T14:01:30.000000000Z",
      "environment": "local",
      "new_version": "0.2.0-faulty",
      "status": "succeeded",
      "class": "faulty",
      "failing_traces": 3,
      "incident_ids": ["uuid"]
    }
  ]
}
```

`limit` defaults to 10 and is capped at 50. `failing_traces` is `0` when Q6 has no row for the deployment.

**Errors.** Any ClickHouse failure returns `503` with `{"error":"clickhouse_unavailable"}` and logs the
driver error server-side. Invalid input, such as a non-UUID `incident_id` or a `limit` that is not an
integer from 1 to the cap, returns `400` with `{"error":"invalid_input","field":"<name>"}`. Error bodies
never include SQL or stack traces.

### 5.5 Environment variables

| Variable | Used by | Default in Compose | Notes |
|---|---|---|---|
| `CLICKHOUSE_URL` | `web` | `http://clickhouse:8123` | HTTP interface, inside the Compose network. |
| `CLICKHOUSE_DATABASE` | `web` | `signalforge` | |
| `CLICKHOUSE_USER` | `web` | `dashboard_reader` | Read-only user (section 6.2). |
| `CLICKHOUSE_PASSWORD` | `web` | `changeme-local-only` | Local-only value, same convention as the existing services. |
| `PORT` | `web` | `3000` | Matches the Temporal UI's CORS origin `http://localhost:3000`. |

### 5.6 Ports

| Port | Service | Status |
|---|---|---|
| `3000` | `web` (dashboard) | New. Replaces the placeholder `web` service. |
| `8123` | `clickhouse` HTTP | Existing, already published. |
| `8081`, `8082`, `8084`, `9090`, `3001`, `4317`, `4318`, `9092` | unchanged | Unchanged. |

## 6. Compose and infrastructure changes

The smallest set of changes is listed. Nothing else in Compose changes.

### 6.1 `web` service

The placeholder `web` service (`alpine:3.20`, `sleep infinity`, depends on `api`) becomes:

```yaml
web:
  build: ../../apps/web
  environment:
    PORT: "3000"
    CLICKHOUSE_URL: http://clickhouse:8123
    CLICKHOUSE_DATABASE: signalforge
    CLICKHOUSE_USER: dashboard_reader
    CLICKHOUSE_PASSWORD: changeme-local-only
  ports:
    - "3000:3000"
  depends_on:
    clickhouse:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    interval: 5s
    timeout: 3s
    retries: 5
  restart: "no"
```

The `api` placeholder is left as it is. `web` no longer depends on `api`, because the BFF lives in `web`.

`/api/health` returns `200 {"status":"ok"}` without querying ClickHouse. It reports only that the process is up.

### 6.2 Read-only ClickHouse user

A ClickHouse users file is mounted into the `clickhouse` service:

```yaml
clickhouse:
  volumes:
    - clickhouse-data:/var/lib/clickhouse
    - ../clickhouse/users.d/dashboard-reader.xml:/etc/clickhouse-server/users.d/dashboard-reader.xml:ro
```

Only the dashboard reader file is mounted, and it is mounted read-only. The whole `users.d` directory is not.
The ClickHouse image's entrypoint writes `default-user.xml` into `users.d` at every start, so a read-only
directory mount stops the server at startup. The directory must stay writable; the single file is the only
read-only part.

`infra/clickhouse/users.d/dashboard-reader.xml` defines:

- user `dashboard_reader` with password `changeme-local-only` (local only);
- profile `dashboard_readonly` with `readonly = 1`;
- `allow_databases` limited to `signalforge`, set in the `dashboard_reader` user definition (not in the profile,
  which ClickHouse 24.8 rejects);
- no network restriction beyond the default Compose network.

The default user and its existing behavior are unchanged. The collector keeps using `default`.

Acceptance requires that `dashboard_reader` can `SELECT` from `signalforge.incidents` and that
`INSERT INTO signalforge.incidents ...` fails with a read-only error. This is the proof that the BFF cannot
write, and it is checked by the acceptance script (section 8.3).

Mounting a users file changes the ClickHouse container's configuration. It does not change the data volume,
so `clickhouse-data` persists across `down` and `up`.

### 6.3 Dockerfile

`apps/web/Dockerfile` follows the existing service pattern: `node:24-alpine`, `npm ci`, `npm run build`,
then a runtime stage with production dependencies and `next start`. `EXPOSE 3000`.

### 6.4 Not changed

`redpanda`, `redpanda-init`, `otel-collector`, `prometheus`, `grafana`, `temporal`, `temporal-ui`,
`demo-orders`, `demo-payments`, `demo-inventory`, `collector-go`, `agent-python`, `remediation`, and `api`.

## 7. Views

### 7.1 Incidents (`/incidents`)

- **Table** sorted by `detected_at` descending. Columns: severity (dot and word), status, service,
  deployment version, detected time (UTC), publication state (`pending` amber, `published` green, with
  `published_at` in a tooltip).
- **Row click** opens `/incidents/{incident_id}`.
- **Header** shows the number of incidents loaded and a "Refresh" button.
- **Loading state:** skeleton rows (five, same height as real rows), announced with `aria-busy="true"`.
- **Empty state:** "No incidents yet." followed by one line: "Run the demo flow (section 10) to create one."
  with a link to `/demo`.
- **Error state:** "ClickHouse is unavailable." with the Refresh button. No stack trace.

### 7.2 Incident detail (`/incidents/{incident_id}`)

1. **Title** and a one-line summary: severity, status, publication state, and detected time.
2. **Explanation** (section 5.3), in one paragraph.
3. **Deployment** panel: version, environment, deployment ID, deployment time, status, and the
   `initiated_by` value. Links back to the Deployments page, anchored to this deployment.
4. **Evidence timeline:** the four evidence items placed on a UTC axis, from the deployment time to the last
   failure. The deployment marker is green; the three trace markers are red. Each marker is labeled with its
   trace ID (monospace, truncated to 12 characters with the full value in the title attribute).
5. **Evidence table** below the timeline with all four rows: source type, source reference, timestamp,
   summary, reliability.

If the response has fewer than four evidence items, a warning banner states how many are present. The page
does not fabricate missing rows.

### 7.3 Deployments (`/deployments`)

- **Timeline** of the last 10 `demo-payments` deployments on a UTC axis, oldest on the left. Markers are
  colored by class (section 5.3). An incident-linked deployment has a connector to the incident marker,
  which links to `/incidents/{incident_id}`.
- **Table** under the timeline with the same rows: deployment time, version, class label, failing trace
  count, and linked incident (ID, truncated).
- **Footnote:** the sentence from section 5.3 explaining that "No failures observed" is not proof of health.
- **Loading, empty, and error states** follow section 7.1. The empty state says "No Payments deployments
  recorded yet." and links to `/demo`.

### 7.4 Demo (`/demo`)

A static page with the commands in section 10, each in a copy-ready block. It renders no live data, so it
works when ClickHouse is down.

## 8. Tests and acceptance

### 8.1 Unit and contract checks (`apps/web`, `tsx --test`)

Matching the existing demo services, tests run with `tsx --test` and typecheck with `tsc --noEmit`.

- Classification (section 5.3): a table test covering every combination of status, failing count, and
  incident linkage, including "no traffic is not healthy".
- Explanation template: exact text for the known rule; the fallback text for an unknown rule.
- Input validation: UUID checks for `incident_id`; `limit` accepts 1 to the cap and rejects 0, negatives,
  non-integers, and values above the cap.
- Query builders: each query string contains its bound parameters and no interpolated input (a test
  asserts the only dynamic values are the named parameters).
- Route handlers with a fake ClickHouse module: correct JSON shape, `405` for `POST`, `PUT`, `PATCH`,
  `DELETE`, `400` for invalid input, `404` for a missing incident, `503` with no SQL text when the module throws.
- Mapping: `deployment_version` is `null` when no deployment row matches; `published_at` is `null` unless
  published; `previous_version` is `null` for an empty string.

### 8.2 Read-only proof (Compose integration)

Run against the Compose stack with `dashboard_reader`:

- `SELECT count() FROM signalforge.incidents` succeeds.
- `INSERT INTO signalforge.incidents (incident_id) VALUES (generateUUIDv4())` fails with a read-only error.
- `INSERT INTO signalforge.deployments (deployment_id) VALUES (generateUUIDv4())` fails with a read-only error.

Both writes are rejected by the `readonly` profile, not by the absence of a row. The acceptance script asserts
the error text, so a silently accepted write fails the check.

These run in the acceptance script, not in unit tests, because they need the real ClickHouse configuration.

### 8.3 Acceptance script (`scripts/verify-incident-dashboard.mjs`)

Runs against the running stack after a faulty deployment has produced at least one incident. Each step is
bounded by a deadline, as in the correlation acceptance script.

1. `GET http://localhost:3000/api/health` returns `200`.
2. `GET /api/incidents` returns at least one incident, sorted by `detected_at` descending.
3. For the newest incident, `GET /api/incidents/{id}` returns exactly four evidence items: one `deployment`
   and three `trace`, all with `reliability = high`.
4. The evidence trace IDs equal the trace IDs in the correlation acceptance output for the same incident,
   when that output is supplied. Without it, step 3 is the check.
5. `GET /api/deployments` marks the incident-linked deployment `faulty` and lists its `incident_ids`.
6. `POST`, `PUT`, `PATCH`, and `DELETE` to `/api/incidents` each return `405`.
7. The read-only proof in section 8.2 passes.
8. The page `GET /incidents` returns `200` and contains the rendered incident title.
9. No response body contains the substring `SELECT` or the ClickHouse error prefix `Code:`.

The script exits 0 only if every step passes, prints one line per step, and never mutates any data.

### 8.4 Visual acceptance

The screenshot scenario in section 9 is captured once manually and reviewed against section 4. Automated
visual regression is out of scope.

## 9. Screenshot-friendly demo scenario

One deployment, one incident, one healthy baseline. The scenario is deterministic in shape:

1. Deployment `0.1.0` (healthy, from the stack start) is already in `deployments`, with no failures.
2. Deployment `0.2.0-faulty` is created by the demo flow. Its three failing Payments traces produce one
   incident, which is published.

The screenshots, at 1280 × 800:

- **A. Incidents list:** one row, severity `high` amber, status `open`, service `demo-payments`, version
  `0.2.0-faulty` in red, publication state `published` in green.
- **B. Incident detail:** the explanation paragraph, the deployment panel, and the four-marker evidence
  timeline with the green deployment marker to the left of three red trace markers within 30 seconds.
- **C. Deployments timeline:** two markers, green `0.1.0` and red `0.2.0-faulty`, with a connector from the
  red marker to the incident marker.

Screenshot B is the headline image. The timeline there should be visibly under 30 seconds wide for the
three traces, which the design guarantees because the rule fixes that window.

## 10. Demo flow

These are the exact commands, run from the repository root in this order. Each step prints what to expect.

**1. Start the slice, including the dashboard.**

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build redpanda redpanda-init clickhouse otel-collector collector-go demo-orders demo-payments web
```

Expect `web` to start after ClickHouse is healthy. Open `http://localhost:3000/demo` to confirm.

**2. Create a faulty Payments deployment.**

```bash
node scripts/deploy-payments.mjs --version 0.2.0-faulty --fault enabled
```

Expect `deployment_id=<uuid>` in the output. Note the value.

**3. Send three orders.** The fixed order IDs make the demo repeatable on a fresh stack.

```bash
curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\"order_id\":\"11111111-1111-4111-8111-111111111111\",\"item\":\"demo-keyboard\",\"amount_cents\":4999}"
curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\"order_id\":\"22222222-2222-4222-8222-222222222222\",\"item\":\"demo-mouse\",\"amount_cents\":1999}"
curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\"order_id\":\"33333333-3333-4333-8333-333333333333\",\"item\":\"demo-monitor\",\"amount_cents\":19999}"
```

Each returns HTTP 502 with a `payment_unavailable` reason. That is the expected faulty behavior.

**4. Wait for the incident, then open it.** The correlator runs every second and the publisher follows. Open
`http://localhost:3000/incidents`. The new row appears after Refresh. Click it to open the detail page.

**5. Restore the healthy version.**

```bash
node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled
```

The incident remains, because it is historical. The Deployments page then shows `0.2.0-faulty` as faulty and
the restored `0.1.0` as the latest deployment.

**Teardown** keeps volumes:

```bash
docker compose -f infra/docker/docker-compose.yml down
```

Note: the demo orders carry fixed IDs. Running the demo twice on the same stack creates a second deployment
and a second incident, because the dedup window is keyed by deployment (section 11 of the correlation spec).
The new incident has the same shape as the first.

## 11. Known limits this slice does not close

- **Single operator, no identity.** Anyone who can reach port 3000 can read everything.
- **Fault mode is not recorded in data.** Faulty classification is inferred from observed failures and
  incidents. A faulty deployment with no traffic would show as "No failures observed."
- **Refresh is manual.** A new incident appears after the operator presses Refresh.
- **Timestamps assume one clock** (correlation spec section 14), so the timeline's relative positions are
  only as good as the containers' shared clock.
- **Publication state is shown, not acted on.** A `pending` incident stays pending in the UI until the
  publisher runs; the dashboard does not retry.
- **Local only.** No TLS, no backup, no monitoring of the dashboard itself.

## 12. Self-review

Checked against the existing contracts before approval:

- Field names and types match the `incidents`, `evidence_items`, and `deployments` columns in
  `services/collector-go/internal/store/migrations/0001_correlation_schema.sql`.
- Q6 reuses the correlator's failure filter (`failureTracesSQL`) and changes only the grouping, so the
  dashboard and the detector agree on what a failure is.
- The publication states `pending` and `published` match `store.go` and `clickhouse.go`.
- The port `3000` matches `temporal-ui`'s `TEMPORAL_CORS_ORIGINS`, so no Compose change is needed for that.
- The placeholder `web` service is the only existing service whose definition changes.
- The demo commands match `README.md` and `scripts/deploy-payments.mjs`, with `web` added to the start list.
- No section requires a deployment field that does not exist. Classification uses only stored data.
