# Faulty-deployment incident correlation slice

Status: **Proposed for review.** Implementation must not begin until this status
line is changed to "Approved for implementation" with an approval date.
Implements: Week 3 of `SignalForge_Project_Plan.docx` (section 17), First Ten Tasks #7–#9
(section 24), and gate G2 "Detectable incident" (section 17.1).
Builds on: [2026-10-01-orders-payments-observability-slice.md](2026-10-01-orders-payments-observability-slice.md),
which is completed and merged to `master`.

## 1. Purpose

Show that one deliberately faulty `demo-payments` deployment produces **one persisted,
deduplicated, high-severity incident** in ClickHouse, with `started_at` taken from the
first failing request, and with the deployment event and the three triggering traces
linked as evidence. The pipeline is deterministic, so the same script produces the same
incident shape every time.

Approved pipeline:

```
demo-orders ─┐
             ├─ OTLP/HTTP ─▶ otel-collector ─ kafka exporter ─▶ telemetry.raw.v1 (Redpanda)
demo-payments┘                                                        │
deploy script ── publishes ─▶ deployments.v1 (Redpanda)               │
                                                                      ▼
                                                    collector-go normalizer (Go)
                                                      │ valid      │ invalid
                                                      ▼            ▼
                                           ClickHouse canonical   telemetry.dead-letter.v1
                                           tables                 (Redpanda)
                                                      │
                                                      ▼
                                           collector-go correlator (Go)
                                                      │
                                                      ▼
                                           ClickHouse incidents + evidence_items
                                           + incidents.created.v1 (Redpanda)
```

## 2. User-visible outcome

An operator runs one command:

```
node scripts/verify-faulty-deployment-incident.mjs
```

The script deploys a faulty Payments version, sends three orders, waits for the pipeline,
and prints the one incident it found, its evidence, and the incident ID. It then sends
three more failing orders inside the five-minute window and shows that no second incident
appears. It exits 0 only if every assertion in section 13 holds.

The plan defines no UI for this milestone (the dashboard is Week 4), so the outcome is
the printed incident record plus the queryable ClickHouse rows.

## 3. Success criteria

- A deployment of `demo-payments` with fault mode enabled makes every
  `POST /payments/charge` return HTTP 500, while `GET /health` stays HTTP 200.
- Three distinct failing Payments traces in 30 seconds, linked to a succeeded Payments
  deployment no older than five minutes, produce exactly one incident.
- Repeated triggers within five minutes of that incident produce no new incident and no
  new evidence.
- Every triggering trace and the deployment event are retrievable from ClickHouse by ID.
- Malformed telemetry is routed to the dead-letter topic and does not stop the pipeline.
- The acceptance script passes on two consecutive runs with fresh IDs.

## 4. Non-goals

- No dashboard, incident timeline, or operator UI (Week 4).
- No diagnosis, retrieval, citations, or LLM/agent behavior (Week 5).
- No Temporal workflows, approval, or remediation actions (Week 6).
- No replay or evaluation scoring (Week 7).
- No detection rule for `demo-orders`, `demo-inventory`, or any scenario other than
  the Payments faulty deployment. The slow-query, downstream-timeout, and
  resource-exhaustion scenarios are not implemented.
- No `started` or `failed` deployment events. The deployment script publishes only
  `succeeded`.
- No `telemetry.normalized.v1` topic. Canonical records go to ClickHouse only, and the
  correlator reads ClickHouse (section 7).
- No retention enforcement, redaction of telemetry fields, authentication, or RBAC.
  These remain Week 2 and later gaps (section 14).
- No retries or circuit breaker in `demo-orders` or `demo-payments`. The Orders→Payments
  behavior from the completed slice is unchanged.
- No Kubernetes, Helm, Terraform, or cloud deployment.
- No Collector processors for enrichment. Enrichment happens in the services (section 6.4).
- Go is not installed on the host. All Go builds, tests, and runs happen in Docker.

## 5. Overrides of earlier specifications

This spec explicitly supersedes one statement in the completed Orders/Payments spec:
its section 4 said `demo-payments` has no failure branch. Fault mode (section 6.3) adds
one: while fault mode is enabled, `POST /payments/charge` returns HTTP 500. The
completed spec's five environment variables are unchanged. This slice adds the
variables in section 6.4 on top of them.

## 6. Components and boundaries

### 6.1 Responsibilities

| Component | Responsibility | Does not do |
|---|---|---|
| `demo-orders` | Unchanged from the completed slice. Emits traces, metrics, and logs. | Know about deployments or faults. |
| `demo-payments` | Adds fault mode (section 6.3). Emits resource attributes (section 6.4). | Publish deployment events, correlate, or write to storage. |
| `otel-collector` | Receives OTLP/HTTP from both services. Exports each signal to the debug exporter (unchanged) and to `telemetry.raw.v1` with the Kafka exporter in `otlp_json` encoding (section 8.1). | Parse, enrich, or filter records. |
| Deploy script `scripts/deploy-payments.mjs` | Generates a deployment UUID, recreates `demo-payments` with deployment environment variables through Compose, waits for health, then publishes a succeeded event to `deployments.v1`. | Send traffic, read storage, or change any other service. |
| Redpanda | Holds `telemetry.raw.v1`, `deployments.v1`, `telemetry.dead-letter.v1`, and `incidents.created.v1` (section 8.2). Topics are created by the `redpanda-init` one-shot service. | Interpret payloads. |
| Normalizer (Go, in `collector-go`) | Consumes `telemetry.raw.v1` and `deployments.v1`. Validates, maps to canonical records, writes ClickHouse. Routes invalid input to the dead-letter topic. | Detect incidents. |
| ClickHouse | Stores canonical telemetry, deployments, incidents, evidence, correlation runs, and migration state (section 9). | Decide what an incident is. |
| Correlator (Go, in `collector-go`) | Reads ClickHouse on a fixed cycle, applies the detection rule (section 10), enforces deduplication (section 11), writes incidents and evidence, and publishes `incidents.created.v1`. | Consume telemetry from Redpanda. |
| Acceptance script `scripts/verify-faulty-deployment-incident.mjs` | Drives the scenario, polls ClickHouse and Redpanda with bounded deadlines, asserts section 13, and always restores the non-faulty deployment. | Modify any service. |

### 6.2 Deployment identity

The deploy script generates `deployment_id` as a random UUIDv4 for each run. Every
telemetry record from the deployed `demo-payments` container carries that ID as the
resource attribute `deployment.id`. Two runs therefore never share a deployment,
and the deployment ID is the join key between telemetry, the deployment event, and the
incident.

### 6.3 Fault mode

- Enabled by the environment variable `PAYMENTS_FAULT_MODE`. Accepted values:
  `enabled` and `disabled`. Default: `disabled`. Any other value makes the process
  exit at startup with the message `PAYMENTS_FAULT_MODE must be enabled or disabled`.
- Fault mode is set only at container start. It cannot be toggled at runtime, and no
  endpoint exists for it.
- When enabled, the `POST /payments/charge` handler checks fault mode **before** body
  validation. Every request to that route returns:
  - HTTP status `500`
  - body `{"error":"injected_fault"}`
  - no order-specific fields and no stack trace
- The fault branch records the request in the `http_requests_total` metric and emits a
  `charge failed` error log with `status_code: 500` and `order_id` (the body's
  `order_id` if it is a string, else `unknown`). It does not attempt any internal
  dependency call.
- `GET /health` is unaffected.
- Fault mode does not change `demo-orders`. An Orders request that reaches the faulty
  Payments returns Orders' existing documented HTTP 502.

### 6.4 Resource attributes and environment variables

`demo-payments` sets these OpenTelemetry resource attributes in
`src/instrument.ts`, read from the environment at process start:

| Environment variable | Resource attribute | Rule |
|---|---|---|
| `PAYMENTS_VERSION` | `service.version` | Required. Default in Compose: `0.1.0`. |
| `DEPLOYMENT_ENVIRONMENT` | `deployment.environment.name` | Required. Default: `local`. |
| `DEPLOYMENT_ID` | `deployment.id` | Attribute is set only when non-empty. Default: empty. |
| `PAYMENTS_FAULT_MODE` | (none) | Read by `src/server.ts` (section 6.3). |

The Compose service `demo-payments` passes each variable with interpolation
(`PAYMENTS_VERSION: ${PAYMENTS_VERSION:-0.1.0}`, and the same pattern for the others).
The deploy script supplies the values through the `env` option of `child_process.spawn`.
No `.env` file is required, and no shell syntax is used.

`demo-orders` is unchanged. Its telemetry has no `deployment.id` and is not used for
detection.

The Collector does not enrich records. The environment-driven attributes above are the
only enrichment, which keeps the Collector configuration to exporter changes only.

## 7. Normalization and canonical storage

### 7.1 Why the correlator reads ClickHouse, not Redpanda

The approved pipeline sends canonical records to ClickHouse and has the correlator
produce `incidents.created.v1`. The plan's topic list (section 10.3) also named
`telemetry.normalized.v1`. That topic is intentionally omitted. Canonical records live
only in ClickHouse, so there is one authoritative copy to deduplicate and query. A
second Kafka copy would need its own deduplication. Consequence: the correlator's input
is ClickHouse queries (section 10.2).

### 7.2 Trace identifiers

`trace_id` is the join key for evidence. Every trace and log event must carry a real
trace ID taken from the telemetry itself. The normalizer never generates a trace ID,
and it never copies one from a different record.

- Trace and log events **require** `trace_id`. A trace or log record without one is
  invalid and goes to the dead-letter topic.
- Metric events **do not have** `trace_id`. A metric data point aggregates many
  requests, so it belongs to no single trace. Its `trace_id` is absent, not empty
  and not fabricated.

Fabricated trace IDs are prohibited because they would attach unrelated values to a
trace. The correlator would then cite evidence that never happened in that request, and
the incident record would be wrong.

### 7.3 Canonical event schema correction

`contracts/events/telemetry_event.schema.json` changes as follows. Nothing else in the
file changes:

- `trace_id` is removed from the top-level `required` array.
- Two conditional rules are added to the top-level schema using `allOf`:
  - when `type` is `trace` or `log`, `trace_id` is required;
  - when `type` is `metric`, `trace_id` is not permitted.
- `business_event` does not require `trace_id` and is not restricted by a conditional
  rule. Its requirement changes from "required" (current schema) to "optional" (new
  schema), because no business-event producer exists in this slice and the rule above
  defines trace and log requirements only.

Exact conditional form, which the implementation must use verbatim:

```json
"allOf": [
  {
    "if": { "properties": { "type": { "enum": ["trace", "log"] } }, "required": ["type"] },
    "then": { "required": ["trace_id"] }
  },
  {
    "if": { "properties": { "type": { "const": "metric" } }, "required": ["type"] },
    "then": { "not": { "required": ["trace_id"] } }
  }
]
```

The sample set is extended (section 13.1): a valid metric sample without `trace_id`, and
two invalid samples, a trace without `trace_id` and a log without `trace_id`.

### 7.4 Canonical record mapping

The Collector sends OTLP/HTTP JSON encoded by the Kafka exporter (`otlp_json`). Each
message on `telemetry.raw.v1` contains exactly one top-level key:
`resourceSpans`, `resourceLogs`, or `resourceMetrics`. The normalizer maps each
message to zero or more canonical `telemetry_event` records. The OTLP JSON format is
external and is pinned to the Collector image version (`0.108.0`), so changes to it
require a deliberate update.

Common fields for every record:

- `service` = resource attribute `service.name`. Required. Missing: invalid.
- `service_version` = `service.version`, if present.
- `environment` = `deployment.environment.name`, if present.
- `deployment_id` = `deployment.id`, if present. Absent means empty in ClickHouse.
- `schema_version` = `"1.0"`.
- `timestamp` = event time as UTC RFC 3339 with nanoseconds.

Per signal:

- **Trace (type `trace`):** one record per span. `trace_id` and `span_id` are the span's
  lower-case hex IDs. `timestamp` is the span start time. `attributes` contains the
  span's own attributes flattened to scalars, plus `span.name`, `span.kind` (`server`
  or `client`), `status.code` (`unset`, `ok`, or `error`), and `parent_span_id` (empty
  for a root span). Event identity: section 7.5.
- **Log (type `log`):** one record per log record. `trace_id` and `span_id` come from the
  log record; both must be present (trace ID required; span ID optional). `severity`
  maps `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL` to `debug`, `info`, `warn`, `error`,
  `fatal`. `timestamp` is `timeUnixNano`, or `observedTimeUnixNano` if the first is zero.
  `attributes` contains the record's attributes plus `log.body`.
- **Metric (type `metric`):** one record per data point of sums, gauges, and histograms.
  No `trace_id`. `attributes` contains the data point attributes plus `metric.name`,
  `metric.kind` (`sum`, `gauge`, or `histogram`), and `metric.value` (sum and gauge), or
  `metric.count` and `metric.sum` (histogram). `timestamp` is the data point's
  `timeUnixNano`.

Unsupported top-level keys, empty `resource` blocks, and metric types other than sum,
gauge, or histogram are invalid and go to the dead-letter topic.

### 7.5 Deterministic event identity

Every canonical record gets `event_id = UUIDv5(NAMESPACE, key)`, where
`NAMESPACE = 8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d` (fixed) and `key` is:

- trace: `trace|<trace_id>|<span_id>`
- log: `log|<trace_id>|<span_id>|<timestamp_unix_nanos>|<sha256_hex_of_log.body>`
- metric: `metric|<service>|<metric.name>|<sorted attribute key=value pairs joined by ,>|<timestamp_unix_nanos>`
- deployment: `deployment|<deployment_id>`

The UUIDv5 algorithm is RFC 4122 section 4.3 with SHA-1, implemented with the Go
standard library. Redelivering the same record yields the same `event_id`, which is what
makes ingestion idempotent (section 7.6).

### 7.6 Ingestion, idempotency, and dead letters

- Consumer group: `collector-go-normalizer`. It consumes `telemetry.raw.v1` and
  `deployments.v1` in one consumer. Offsets are committed only after the records from
  that message are written to ClickHouse successfully.
- Delivery is at-least-once. Duplicates are removed by ClickHouse table engines
  (section 9) and read with `FINAL`.
- Each partition is processed in order. The demo uses one partition per topic.
- **Dead letters:** a message that cannot be mapped or validated produces one message on
  `telemetry.dead-letter.v1` (shape in section 8.3) and its offset is committed. Its
  records are not written to ClickHouse, and the consumer continues with the next
  message.
- **ClickHouse unavailable:** the write is retried with exponential backoff starting at
  1 second, doubling, capped at 16 seconds per attempt. After 2 minutes of continuous
  failure the process exits with status 1. The offset is not committed, so the message is
  redelivered after restart.

## 8. JSON payloads and topics

### 8.1 Collector export

The Collector's kafka exporter is added to the existing `traces`, `metrics`, and `logs`
pipelines, alongside the unchanged `debug` exporter. Exact exporter block:

```yaml
exporters:
  kafka:
    brokers: ["redpanda:9092"]
    topic: telemetry.raw.v1
    encoding: otlp_json
    protocol_version: 2.1.0
```

Each pipeline lists `exporters: [debug, kafka]`. The implementation verifies delivery
with the acceptance script (section 13), not by inspecting the Collector's internals.

### 8.2 Topics

All topics have 1 partition and replication factor 1, created by the `redpanda-init`
service (section 12.3).

| Topic | Producer | Consumer | Key |
|---|---|---|---|
| `telemetry.raw.v1` | Collector (kafka exporter) | Normalizer | none (one partition) |
| `deployments.v1` | Deploy script | Normalizer | `deployment_id` |
| `telemetry.dead-letter.v1` | Normalizer | Operators (manual inspection) | source offset |
| `incidents.created.v1` | Correlator | Future consumers (not in this slice) | `incident_id` |

### 8.3 Dead-letter payload

```json
{
  "schema_version": "1.0",
  "reason": "trace_id is required for trace events",
  "source_topic": "telemetry.raw.v1",
  "source_partition": 0,
  "source_offset": 42,
  "received_at": "2026-10-03T12:00:00.000000000Z",
  "raw_payload": "<original message value as a string>"
}
```

`reason` is one of a fixed set of messages defined in the normalizer's error table, so
tests can assert exact values.

### 8.4 Deployment payload (`deployments.v1`)

Validated against `contracts/events/deployment_event.schema.json` (unchanged):

```json
{
  "schema_version": "1.0",
  "deployment_id": "<uuid v4>",
  "timestamp": "2026-10-03T12:00:00.000000000Z",
  "service": "demo-payments",
  "environment": "local",
  "new_version": "0.2.0-faulty",
  "initiated_by": "deploy-payments-script",
  "status": "succeeded"
}
```

`previous_version` is omitted. The deployment timestamp is the UTC time the script
publishes the event, which is after the health check passes.

### 8.5 Incident payload (`incidents.created.v1`)

The payload is exactly one object matching `contracts/events/incident.schema.json`
(unchanged):

```json
{
  "schema_version": "1.0",
  "incident_id": "<uuid v5>",
  "title": "Payments 5xx burst after deployment <deployment_id>",
  "status": "open",
  "severity": "high",
  "started_at": "2026-10-03T12:00:05.123000000Z",
  "detected_at": "2026-10-03T12:00:12.456000000Z",
  "services": ["demo-payments"],
  "trigger_rule": "payments-5xx-burst-after-deployment"
}
```

Evidence is not published on this topic. It is available from ClickHouse by
`incident_id`.

## 9. ClickHouse schema

Migrations are versioned SQL files embedded in the normalizer binary
(`services/collector-go/internal/store/migrations/`), applied at startup in version order,
and recorded in `schema_migrations`. Applying a version twice is a no-op.

All tables use database `signalforge` (from `CLICKHOUSE_DB`).

| Table | Engine | Order by | Purpose |
|---|---|---|---|
| `schema_migrations` | `MergeTree` | `version` | Applied migration versions. |
| `telemetry_events` | `ReplacingMergeTree(ingested_at)` | `event_id` | Canonical records. |
| `deployments` | `ReplacingMergeTree(ingested_at)` | `deployment_id` | Deployment events. |
| `incidents` | `ReplacingMergeTree(detected_at)` | `incident_id` | Incidents. |
| `evidence_items` | `ReplacingMergeTree(ingested_at)` | `evidence_id` | Incident evidence. |
| `correlation_runs` | `MergeTree` | `evaluated_until` | One row per correlator cycle. |

Column definitions:

- `telemetry_events`: `event_id UUID`, `schema_version String`, `timestamp DateTime64(9, 'UTC')`,
  `ingested_at DateTime64(3, 'UTC')`, `type LowCardinality(String)`,
  `service LowCardinality(String)`, `service_version String`,
  `environment LowCardinality(String)`, `deployment_id String`, `trace_id String`,
  `span_id String`, `severity LowCardinality(String)`, `attributes String` (JSON object).
  Partitioned by `toYYYYMMDD(timestamp)`.
- `deployments`: `deployment_id UUID`, `timestamp DateTime64(9, 'UTC')`,
  `service LowCardinality(String)`, `environment LowCardinality(String)`,
  `new_version String`, `previous_version String`, `initiated_by String`,
  `status LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `incidents`: `incident_id UUID`, `dedup_key String`, `environment LowCardinality(String)`,
  `service LowCardinality(String)`, `deployment_id String`, `trigger_rule String`,
  `title String`, `status LowCardinality(String)`, `severity LowCardinality(String)`,
  `started_at DateTime64(9, 'UTC')`, `detected_at DateTime64(9, 'UTC')`,
  `services Array(String)`.
- `evidence_items`: `evidence_id UUID`, `incident_id UUID`,
  `source_type LowCardinality(String)`, `source_ref String`,
  `timestamp DateTime64(9, 'UTC')`, `service LowCardinality(String)`, `summary String`,
  `reliability LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `correlation_runs`: `run_id UUID`, `evaluated_until DateTime64(9, 'UTC')`,
  `created_at DateTime64(3, 'UTC')`.

`ingested_at` and `detected_at` are the version columns for `ReplacingMergeTree`. Every
insert writes the same value for a given key on reprocessing; section 11 explains why
incidents are never reinserted with a new `detected_at`.

No TTL or retention is set. Retention is out of scope (section 4).

Tables are read with `FINAL` wherever correctness depends on deduplication.

## 10. Detection rule

The correlator evaluates the rule over canonical records from the last 10 minutes
(wall-clock lookback) on each cycle (section 10.2). Inside that window, all time
comparisons use event time, never the clock of the machine running the correlator.

### 10.1 Rule `payments-5xx-burst-after-deployment`

Inputs:

- **Failure records:** `telemetry_events` rows with `type = 'trace'`,
  `service = 'demo-payments'`, `attributes` `span.kind = 'server'`, and
  `http.response.status_code = 500`, with a non-empty `deployment_id`. Records with the
  same `trace_id` are collapsed to the earliest `timestamp`, so each trace counts once.
- **Deployments:** `deployments` rows with `service = 'demo-payments'` and
  `status = 'succeeded'`.

Procedure, for each deployment `D` (ordered by timestamp):

1. Let `F` be the failure records whose `deployment_id = D.deployment_id`, sorted by
   `timestamp` ascending, with duplicate traces removed.
2. Find the smallest index `i` such that `F[i]`, `F[i+1]`, `F[i+2]` all exist and
   `F[i+2].timestamp - F[i].timestamp <= 30 seconds`. If none exists, `D` produces no
   incident.
3. Let `T0 = F[i].timestamp`, the first triggering failure. Require
   `D.timestamp <= T0` and `T0 - D.timestamp <= 5 minutes`. If not, `D` produces no
   incident for this cycle.
4. Apply the deduplication check (section 11). If it suppresses the candidate, stop.
5. Otherwise create an incident (section 12.1) with `started_at = T0`, and evidence for
   `D` and `F[i]`, `F[i+1]`, `F[i+2]`.

Only one incident is created per deployment per cycle. Further failures in the same burst
are covered by the deduplication window.

Rationale for "three distinct traces": a single retried or repeated request could produce
several spans. Counting distinct trace IDs measures distinct failing requests.

### 10.2 Correlator cycle

- Runs every 1 second.
- Each cycle reads failure records and succeeded deployments from the lookback window,
  runs section 10.1 for every deployment, and inserts one `correlation_runs` row with
  `evaluated_until` equal to the maximum `timestamp` of the telemetry read in that cycle
  (or the current event time if none was read).
- A cycle that fails to read ClickHouse logs the error, inserts nothing, and retries on
  the next cycle. It never writes partial results because incident creation is
  idempotent (section 12.2).

Because each cycle re-evaluates the same window, a record that arrives late is still
evaluated, and an incident that already exists is never created twice.

## 11. Deduplication

Dedup key: `dedup_key = environment|service|deployment_id|trigger_rule`.

Window: 5 minutes of event time.

Rule: a candidate with start time `T0` is suppressed when an existing incident with the
same `dedup_key` has `started_at` in the interval `[T0 - 5 minutes, T0)`. A candidate
that is more than 5 minutes after an existing incident starts a new incident.

Stable identity: `incident_id = UUIDv5(NAMESPACE, dedup_key|<T0 as nanoseconds>)`. The
same burst always produces the same ID. A re-run therefore finds the existing row instead
of creating a second one.

Interpretation: the window is measured from the start of the earlier incident, not from
its detection time, so the dedup decision depends only on event time.

## 12. Incident and evidence

### 12.1 Incident

| Field | Value |
|---|---|
| `incident_id` | Section 11 |
| `title` | `Payments 5xx burst after deployment <deployment_id>` |
| `status` | `open` |
| `severity` | `high` |
| `started_at` | `T0` |
| `detected_at` | Wall-clock UTC time the row is first written |
| `services` | `["demo-payments"]` |
| `trigger_rule` | `payments-5xx-burst-after-deployment` |
| `dedup_key` | Section 11 (ClickHouse column only; not in the public payload) |

### 12.2 Evidence

Every incident has exactly four evidence rows:

| Row | `source_type` | `source_ref` | `timestamp` | `summary` |
|---|---|---|---|---|
| 1 | `deployment` | `deployment_id` | `D.timestamp` | `demo-payments version <new_version> deployed` |
| 2 | `trace` | `trace_id` of `F[i]` | `F[i].timestamp` | `demo-payments returned HTTP 500 for trace <trace_id>` |
| 3 | `trace` | `trace_id` of `F[i+1]` | `F[i+1].timestamp` | same pattern |
| 4 | `trace` | `trace_id` of `F[i+2]` | `F[i+2].timestamp` | same pattern |

`evidence_id = UUIDv5(NAMESPACE, incident_id|<source_ref>)`. `reliability` is `high`
for all four rows, because each is a direct record rather than an inference.

Creation order is: insert the incident row, then insert the four evidence rows. If the
second step fails, the next cycle finds the incident already exists and re-inserts any
missing evidence (the rows are idempotent by `evidence_id`). An incident is never left
without evidence once the cycle completes.

### 12.3 Redpanda topic creation and Compose services

The one-shot Compose service `redpanda-init` creates the four topics in section 8.2
before any producer or consumer starts. Its image is the same `redpandadata/redpanda`
image already used by `redpanda`, and it runs once with `restart: "no"`:

```
sh -c 'for t in telemetry.raw.v1 deployments.v1 telemetry.dead-letter.v1 incidents.created.v1; do
  rpk topic describe "$t" --brokers redpanda:9092 >/dev/null 2>&1 ||
  rpk topic create "$t" --partitions 1 --replicas 1 --brokers redpanda:9092;
done'
```

`redpanda-init` depends on `redpanda` with condition `service_healthy`. The `redpanda`
service gains the healthcheck `["CMD", "rpk", "cluster", "info", "--brokers", "redpanda:9092"]`
with interval 2 seconds and 30 retries. `collector-go` depends on `redpanda-init` with
condition `service_completed_successfully` and on `clickhouse` with condition
`service_healthy`. The `clickhouse` service gains the healthcheck
`["CMD", "clickhouse-client", "--query", "SELECT 1"]`.

## 13. Acceptance criteria

### 13.1 Contract and unit checks

1. `contracts/events/telemetry_event.schema.json` matches section 7.3 exactly.
2. `scripts/validate-schemas.py` passes for:
   - all existing valid samples;
   - a new valid metric sample without `trace_id`;
   - two new invalid samples, `contracts/events/samples/invalid/trace-without-trace-id.json` and
     `contracts/events/samples/invalid/log-without-trace-id.json`, which must fail validation.
   The script exits non-zero if any invalid sample passes.
3. Go unit tests pass for the mapping (every field in section 7.4), UUIDv5 identity
   (section 7.5), the dead-letter error table, the detection rule (section 10.1)
   including each rejection branch, and deduplication (section 11).
4. `demo-payments` unit tests pass for: fault enabled returns 500 and the exact body for
   a valid request and for an invalid request; fault disabled matches the completed
   slice; an invalid `PAYMENTS_FAULT_MODE` causes startup failure; `/health` returns 200
   in both modes.

### 13.2 Scenario checks (`scripts/verify-faulty-deployment-incident.mjs`)

Precondition: the Compose services `redpanda`, `redpanda-init`, `clickhouse`,
`otel-collector`, `collector-go`, `demo-orders`, and `demo-payments` are running and
healthy (section 12.3).

Steps:

1. Run the deploy script with the faulty version, fault mode enabled, and a fresh
   deployment ID. Expected: exit 0, and the script prints the deployment ID.
2. Poll ClickHouse until a `deployments` row exists with that ID and status `succeeded`
   (bounded, section 13.3).
3. Send three orders with fresh UUID `order_id`s, one after another. Each returns HTTP 502
   with the documented body.
4. Poll ClickHouse until three distinct failure traces with that `deployment_id` are
   present.
5. Poll ClickHouse until exactly one incident exists with
   `dedup_key = <environment>|demo-payments|<deployment_id>|payments-5xx-burst-after-deployment`.
   Assert:
   - `severity = 'high'`, `status = 'open'`, `services = ['demo-payments']`;
   - `started_at` equals the earliest of the three trigger traces' timestamps, to the
     nanosecond;
   - `detected_at >= started_at`.
6. Assert exactly four `evidence_items` rows for the incident: one `deployment` row with
   `source_ref` equal to the deployment ID, and three `trace` rows whose `source_ref`
   values are exactly the three triggering trace IDs.
7. Dedup. Send three more orders with fresh UUIDs. Poll until their traces are present in
   `telemetry_events` and a `correlation_runs` row has `evaluated_until` greater than or
   equal to the latest of their timestamps. Assert:
   - still exactly one incident for that `dedup_key`;
   - still exactly four evidence rows for that incident.
8. Dead-letter path. Publish one malformed message to `telemetry.raw.v1` with `rpk`
   (a trace event without `trace_id`). Poll until `telemetry.dead-letter.v1` holds a
   message whose `reason` is `trace_id is required for trace events`. Assert no
   `telemetry_events` row exists for that malformed record. Then send one valid order
   and assert its trace is ingested, which shows the pipeline kept running.
9. Idempotency. Build one valid trace message with fixed IDs in the script (one
   `resourceSpans` entry for `demo-orders` with a fixed `traceId` and `spanId`, and a
   span start time of now). Publish it to `telemetry.raw.v1` twice with `rpk`, then
   publish a second valid sentinel message with its own fixed IDs. The topic has one
   partition, so messages are consumed in order: when the sentinel's record appears in
   `telemetry_events`, both duplicates have been processed. Then assert that the `FINAL`
   count of rows with the fixed trace message's `event_id` is exactly 1. The script
   computes `event_id` with the section 7.5 UUIDv5 rule using Node's `crypto` module.
10. Restore. In a `finally` block, run the deploy script with the previous non-faulty
    version and fault mode disabled. Expected: exit 0. This runs even when an earlier
    step failed.

The script prints the incident record and its four evidence rows on success.

### 13.3 Bounded polling deadlines

| Wait | Interval | Deadline |
|---|---|---|
| Container health after deploy recreate | 1 s | 60 s |
| Deployment row visible in ClickHouse | 500 ms | 30 s |
| Trace or log visible in ClickHouse | 500 ms | 30 s |
| Incident or evidence visible | 500 ms | 60 s |
| Correlator run covering the dedup batch | 500 ms | 60 s |
| Dead-letter message visible | 500 ms | 30 s |
| Compose one-shot `redpanda-init` completion | 1 s | 60 s |

The deadlines are longer than the completed slice's 10 seconds because they cover a
longer pipeline: export interval (1 s), Kafka hop, normalizer, ClickHouse write, and a
correlator cycle. Every wait uses `pollUntil` with a named timeout error.

No fixed `sleep` is used in the script or in any service.

### 13.4 End-to-end and repeatability

- The acceptance script passes on two consecutive runs. Each run uses a fresh deployment
  ID, so each produces its own incident, and the second run does not see the first run's
  incident as its own.
- The script exits 0 only when every step in section 13.2 passes.
- After the script, `docker compose ... down` leaves no SignalForge containers or
  networks.

## 14. Known gaps this slice does not close

- Week 2 redaction of sensitive fields at the Collector remains unimplemented and
  untested.
- Retention and TTL are not configured.
- Redpanda is reached only from inside the Compose network. Host clients need a second
  listener, which is not added.
- The `prometheus` service scrapes only itself. Platform metrics for SignalForge are not
  scraped.
- The correlator is a single instance. Two instances would race on incident creation,
  which the idempotency design tolerates only with a single writer.
- Clock skew between containers is assumed to be negligible on the local Docker host.

## 15. Testing strategy

- **Contracts:** `scripts/validate-schemas.py` covers valid and invalid samples
  (section 13.1).
- **Go unit tests:** pure logic only, run in Docker (section 16). No network, no
  ClickHouse, no Redpanda. These cover mapping, identity, dead letters, detection,
  deduplication, and evidence construction.
- **Go integration checks:** the normalizer and correlator run against the real
  ClickHouse and Redpanda containers. The acceptance script is the integration test.
- **Node unit tests:** `demo-payments` fault mode, as in section 13.1.
- **Acceptance:** `scripts/verify-faulty-deployment-incident.mjs`, run twice (section 13.4).

Tests use fixed fixtures so results do not depend on timing. Timing-dependent behavior is
checked only in the acceptance script, with bounded polling.

## 16. Docker-based Go workflow

Go is not installed on the host. All Go commands run in a container built from the
official Go builder image.

- Builder image: `golang:<major>.<minor>-alpine`. The tag is the newest stable tag
  listed for the official image on Docker Hub when implementation starts, and the chosen
  tag is recorded in ADR 0004.
- Pinning: the implementation's first step resolves the tag's digest with
  `docker buildx imagetools inspect golang:<tag>` and writes
  `golang:<tag>@sha256:<digest>` into `services/collector-go/Dockerfile` as the only base
  image reference. The digest is recorded in ADR 0004. Tags are never used alone.
- Wrapper: `scripts/go-in-docker.mjs` runs `docker run --rm` with the absolute path of
  `services/collector-go` mounted at `/src`, working directory `/src`, and the command
  passed through. It computes the path with `path.resolve` and `url.fileURLToPath`, so the
  same invocation works on Windows PowerShell and Unix shells.
- Commands:
  - `node scripts/go-in-docker.mjs go test ./...`
  - `node scripts/go-in-docker.mjs go vet ./...`
  - `node scripts/go-in-docker.mjs go build -o /src/bin/collector-go ./cmd/collector-go`
- The production image is a multi-stage build: the builder stage compiles a static binary
  (`CGO_ENABLED=0`), and the runtime stage is `alpine` with the binary and no Go toolchain.
  The runtime image pins its base by digest with the same procedure.
- `services/collector-go/bin/` is gitignored.

## 17. Deployment mechanism

`scripts/deploy-payments.mjs` accepts:

| Flag | Required | Values | Default |
|---|---|---|---|
| `--version` | yes | any non-empty string | none |
| `--environment` | no | non-empty string | `local` |
| `--fault` | no | `enabled` or `disabled` | `disabled` |

Steps, in order. A failure at any step stops the script with exit status 1 and a message
naming the step:

1. Generate `deployment_id` with `crypto.randomUUID()`.
2. Run `docker compose -f infra/docker/docker-compose.yml up -d --force-recreate --no-deps demo-payments`
   via `child_process.spawn` with `env` set to the parent environment plus:
   `PAYMENTS_VERSION=<version>`, `DEPLOYMENT_ENVIRONMENT=<environment>`,
   `DEPLOYMENT_ID=<deployment_id>`, `PAYMENTS_FAULT_MODE=<fault>`.
3. Poll `docker inspect --format '{{.State.Health.Status}}' signalforge-demo-payments-1`
   until the value is `healthy` (section 13.3). Poll failure after the deadline aborts the
   script before any event is published.
4. Publish one message to `deployments.v1` by running
   `docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic produce deployments.v1 --key <deployment_id>`
   with the JSON payload of section 8.4 written to the process's standard input.
5. Print `deployment_id=<deployment_id>` on its own line, and exit 0.

The script publishes only the succeeded event. If step 4 fails, the script exits 1 and
prints the `deployment_id`, so an operator can see which deployment had no event.

The container name `signalforge-demo-payments-1` is the Compose project's default name.
The script builds it from the project name `signalforge` rather than hard-coding it.

## 18. Error handling summary

| Condition | Behavior |
|---|---|
| Invalid `PAYMENTS_FAULT_MODE` | `demo-payments` exits at startup. |
| Message on `telemetry.raw.v1` cannot be mapped or validated | Dead letter, offset committed, pipeline continues. |
| ClickHouse write fails | Retry with backoff up to 2 minutes, then exit 1 without committing. |
| Correlator read fails | Logged, cycle skipped, retried next cycle. |
| Correlator evidence insert fails | Repaired on the next cycle (section 12.2). |
| Deploy health poll times out | Script exits 1 before publishing the deployment event. |
| Deployment event publish fails | Script exits 1 and prints the `deployment_id`. |
| Acceptance assertion fails | Script exits 1, prints the failing step, and still runs the restore step. |

## 19. Expected file-level impacts

Documentation: this spec; `docs/decisions/0004-faulty-deployment-correlation.md` (ADR
recording the choices in sections 6.2, 7.1, 7.2, 9, 10, 11, 16, and 17).

Contracts:
- `contracts/events/telemetry_event.schema.json` (section 7.3).
- `contracts/events/dead_letter.schema.json` (new; section 8.3).
- `contracts/events/samples/telemetry_event.metric.sample.json` (new).
- `contracts/events/samples/invalid/trace-without-trace-id.json` (new).
- `contracts/events/samples/invalid/log-without-trace-id.json` (new).
- `contracts/events/samples/dead_letter.sample.json` (new).
- `scripts/validate-schemas.py` (valid and invalid sample checks, section 13.1).

Demo services:
- `services/demo-payments/src/server.ts` (fault mode, section 6.3).
- `services/demo-payments/src/instrument.ts` (resource attributes, section 6.4).
- `services/demo-payments/src/config.ts` (new; reads and validates environment, section 6.3).
- `services/demo-payments/test/fault.test.ts` (new).

Collector and Compose:
- `observability/otel-collector/config.yaml` (kafka exporter, section 8.1).
- `infra/docker/docker-compose.yml`: add `redpanda-init` (section 12.3); add healthchecks
  for `redpanda` (`rpk cluster info`) and `clickhouse` (`clickhouse-client --query "SELECT 1"`);
  make `collector-go` real (build from `services/collector-go`, environment, dependencies
  on `redpanda-init` with `service_completed_successfully` and on `clickhouse` healthy);
  add `PAYMENTS_VERSION`, `DEPLOYMENT_ENVIRONMENT`, `DEPLOYMENT_ID`, `PAYMENTS_FAULT_MODE`
  to `demo-payments` with the defaults in section 6.4. `demo-inventory` and all other
  placeholders are unchanged.
- `.env.example`: document the four variables above. Compose defaults make them optional.

Go service (`services/collector-go/`, replaces the placeholder README):
- `go.mod`, `go.sum`.
- `Dockerfile` (section 16).
- `cmd/collector-go/main.go`: starts the normalizer loop and the correlator loop in one
  process.
- `internal/config/`: environment variables `KAFKA_BROKERS`, `CLICKHOUSE_HOST`,
  `CLICKHOUSE_PORT`, `CLICKHOUSE_DB`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`.
- `internal/canonical/`: mapping (section 7.4), UUIDv5 (section 7.5), dead-letter errors.
- `internal/ingest/`: Redpanda consumer, offset handling, dead-letter production.
- `internal/store/`: ClickHouse connection, migrations, batch writes, queries.
- `internal/store/migrations/0001_correlation_schema.sql` (section 9).
- `internal/correlate/`: detection (section 10), deduplication (section 11), incident and
  evidence construction (section 12), `incidents.created.v1` production.
- Unit tests beside each package.
- `services/collector-go/README.md` (replaces the placeholder text).

Scripts:
- `scripts/go-in-docker.mjs` (section 16).
- `scripts/deploy-payments.mjs` (section 17).
- `scripts/verify-faulty-deployment-incident.mjs` (section 13.2).

Not touched: `services/demo-orders/*`, `services/demo-inventory/*`, the existing
Orders/Payments acceptance script, and `master`.

## 20. Self-review

- **Ambiguity:** each rule has a single interpretation. The deployment linkage window is
  defined relative to the first trigger (section 10.1 step 3). The dedup window is
  defined from the existing incident's start (section 11). Trace versus metric
  identifiers are defined by type (section 7.2).
- **Contradictions:** the completed spec's "no failure branch" statement is explicitly
  overridden (section 5). The plan's `telemetry.normalized.v1` topic is explicitly
  omitted with a reason (section 7.1). The completed slice's 10-second poll deadline is
  explicitly replaced for this pipeline (section 13.3).
- **Missing boundaries:** each component's responsibilities and non-responsibilities
  are listed (section 6.1). Interfaces are the topics and tables in sections 8 and 9.
- **Scope:** no dashboard, agent, approval, replay, retention, or second scenario
  (section 4). The only new runtime behavior is the Payments fault branch, the Collector
  export, the Go normalizer and correlator, and the deploy script.
- **Placeholders:** the Go builder tag and digest are resolved by a defined procedure at
  implementation start (section 16), not left open. Every other value is fixed in this
  document.
