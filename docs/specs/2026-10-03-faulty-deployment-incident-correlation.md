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
linked as evidence. The incident is then published to `incidents.created.v1` by a
durable publisher. The pipeline is deterministic, so the same script produces the same
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
                                                      │ incidents (pending), evidence_items
                                                      ▼
                                           collector-go publisher (Go)
                                                      │ incidents.created.v1 (Redpanda),
                                                      │ then incidents row (published)
                                                      ▼
                                           ClickHouse incidents (revisioned)
```

## 2. User-visible outcome

An operator runs one command:

```
node scripts/verify-faulty-deployment-incident.mjs
```

The script deploys a faulty Payments version, sends three orders, and waits for the
pipeline. It resolves each order to its trace through the Orders `payment failed` log
record, and checks that those traces are exactly the three faulty Payments traces used
as triggers. It prints the one incident it found, its evidence, its publication state,
and the incident ID. It then sends three more failing orders inside the five-minute
window and shows that no second incident appears. Two further scenarios prove that a
failed publication and a crash during publication are retried without duplicate
incidents or evidence. The script exits 0 only if every assertion in section 13 holds.

The plan defines no UI for this milestone (the dashboard is Week 4), so the outcome is
the printed incident record plus the queryable ClickHouse rows.

## 3. Success criteria

- A deployment of `demo-payments` with fault mode enabled makes every
  `POST /payments/charge` return HTTP 500, while `GET /health` stays HTTP 200.
- Three distinct failing Payments traces in 30 seconds, linked to a succeeded Payments
  deployment no older than five minutes, produce exactly one incident row.
- Repeated triggers within five minutes of that incident produce no new incident and no
  new evidence.
- Each submitted order maps to exactly one failing Payments trace, and the set of those
  traces equals the set of trigger traces in the incident's evidence.
- Every incident is published to `incidents.created.v1` at least once. The normal healthy
  path publishes it exactly once.
- A failed publication attempt, and a crash between a successful produce and the
  published-state write, are both recovered without a duplicate incident row or a
  duplicate evidence row.
- Every triggering trace and the deployment event are retrievable from ClickHouse by ID.
- Malformed telemetry is routed to the dead-letter topic and does not stop the pipeline.
- The acceptance script passes on two consecutive runs with fresh IDs.

## 4. Non-goals

- No dashboard, incident timeline, or operator UI (Week 4).
- No diagnosis, retrieval, citations, or LLM/agent behavior (Week 5).
- No Temporal workflows, approval, or remediation actions (Week 6).
- No replay or evaluation scoring (Week 7).
- No detection rule for `demo-orders`, `demo-inventory`, or any scenario other than the
  Payments faulty deployment. The slow-query, downstream-timeout, and resource-exhaustion
  scenarios are not implemented.
- No detection rule based on order identity. Order identity is used only by the
  acceptance script to verify its own assertions (section 13.2, step 4). The detection
  rule remains deployment- and time-window-based (section 10.1).
- No `started` or `failed` deployment events. The deployment script publishes only
  `succeeded`.
- No `telemetry.normalized.v1` topic. Canonical records go to ClickHouse only, and the
  correlator reads ClickHouse (section 7.1).
- No retention enforcement, redaction of telemetry fields, authentication, or RBAC.
  These remain Week 2 and later gaps (section 14).
- No retries or circuit breaker in `demo-orders` or `demo-payments`. The Orders→Payments
  behavior from the completed slice is unchanged.
- No Kubernetes, Helm, Terraform, or cloud deployment.
- No Collector processors for enrichment. Enrichment happens in the services (section 6.4).
- Go is not installed on the host. All Go builds, tests, and runs happen in Docker.

## 5. Overrides of earlier specifications

This spec explicitly supersedes one statement in the completed Orders/Payments spec: its
section 4 said `demo-payments` has no failure branch. Fault mode (section 6.3) adds one:
while fault mode is enabled, `POST /payments/charge` returns HTTP 500. The completed
spec's five environment variables are unchanged. This slice adds the variables in
sections 6.4 and 12.4 on top of them.

## 6. Components and boundaries

### 6.1 Responsibilities

| Component | Responsibility | Does not do |
|---|---|---|
| `demo-orders` | Unchanged from the completed slice. Emits traces, metrics, and logs, including the `order_id` attribute on `payment failed` logs. | Know about deployments or faults. |
| `demo-payments` | Adds fault mode (section 6.3). Emits resource attributes (section 6.4). | Publish deployment events, correlate, or write to storage. |
| `otel-collector` | Receives OTLP/HTTP from both services. Exports each signal to the debug exporter (unchanged) and to `telemetry.raw.v1` with the Kafka exporter in `otlp_json` encoding (section 8.1). | Parse, enrich, or filter records. |
| Deploy script `scripts/deploy-payments.mjs` | Generates a deployment UUID, recreates `demo-payments` with deployment environment variables through Compose, waits for health, then publishes a succeeded event to `deployments.v1`. | Send traffic, read storage, or change any other service. |
| Redpanda | Holds `telemetry.raw.v1`, `deployments.v1`, `telemetry.dead-letter.v1`, and `incidents.created.v1` (section 8.2). Topics are created by the `redpanda-init` one-shot service. | Interpret payloads. |
| Normalizer (Go, in `collector-go`) | Consumes `telemetry.raw.v1` and `deployments.v1`. Validates, maps to canonical records (including log attributes), writes ClickHouse. Routes invalid input to the dead-letter topic. | Detect incidents or publish incidents. |
| ClickHouse | Stores canonical telemetry, deployments, incidents (revisioned), evidence, correlation runs, and migration state (section 9). | Decide what an incident is. |
| Correlator (Go, in `collector-go`) | Reads ClickHouse on a fixed cycle, applies the detection rule (section 10), enforces deduplication (section 11), and writes incidents in state `pending` and their evidence (section 12). | Publish to Redpanda. |
| Publisher (Go, in `collector-go`) | Publishes pending incidents that have four evidence rows to `incidents.created.v1`, then records the published state (section 12.4). | Detect incidents or write evidence. |
| Acceptance script `scripts/verify-faulty-deployment-incident.mjs` | Drives the scenarios, polls ClickHouse and Redpanda with bounded deadlines, asserts section 13, and always restores the non-faulty deployment and default collector settings. | Modify any service. |

### 6.2 Deployment identity

The deploy script generates `deployment_id` as a random UUIDv4 for each run. Every
telemetry record from the deployed `demo-payments` container carries that ID as the
resource attribute `deployment.id`. Two runs therefore never share a deployment, and the
deployment ID is the join key between telemetry, the deployment event, and the incident.

### 6.3 Fault mode

- Enabled by the environment variable `PAYMENTS_FAULT_MODE`. Accepted values:
  `enabled` and `disabled`. Default: `disabled`. Any other value makes the process exit
  at startup with the message `PAYMENTS_FAULT_MODE must be enabled or disabled`.
- Fault mode is set only at container start. It cannot be toggled at runtime, and no
  endpoint exists for it.
- When enabled, the `POST /payments/charge` handler checks fault mode **before** body
  validation. Every request to that route returns:
  - HTTP status `500`
  - body `{"error":"injected_fault"}`
  - no order-specific fields and no stack trace
- The fault branch records the request in the `http_requests_total` metric and emits a
  `charge failed` error log with `status_code: 500` and `order_id` (the body's `order_id`
  if it is a string, else `unknown`). It does not attempt any internal dependency call.
- `GET /health` is unaffected.
- Fault mode does not change `demo-orders`. An Orders request that reaches the faulty
  Payments returns Orders' existing documented HTTP 502, and emits its existing
  `payment failed` error log carrying `order_id`.

### 6.4 Resource attributes and environment variables

`demo-payments` sets these OpenTelemetry resource attributes in `src/instrument.ts`, read
from the environment at process start:

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
only enrichment.

## 7. Normalization and canonical storage

### 7.1 Why the correlator reads ClickHouse, not Redpanda

The approved pipeline sends canonical records to ClickHouse and has the correlator
produce incidents. The plan's topic list (section 10.3) also named
`telemetry.normalized.v1`. That topic is intentionally omitted. Canonical records live
only in ClickHouse, so there is one authoritative copy to deduplicate and query. A second
Kafka copy would need its own deduplication. Consequence: the correlator's input is
ClickHouse queries (section 10.2).

### 7.2 Trace identifiers and order identity

`trace_id` is the join key for evidence. Every trace and log event must carry a real trace
ID taken from the telemetry itself. The normalizer never generates a trace ID, and it never
copies one from a different record.

- Trace and log events **require** `trace_id`. A trace or log record without one is
  invalid and goes to the dead-letter topic.
- Metric events **do not have** `trace_id`. A metric data point aggregates many requests,
  so it belongs to no single trace. Its `trace_id` is absent, not empty and not fabricated.

Fabricated trace IDs are prohibited because they would attach unrelated values to a trace.
The correlator would then cite evidence that never happened in that request, and the
incident record would be wrong.

Order identity exists in telemetry. The Orders `payment failed` log record carries the
attribute `order_id` (section 6.3 of the completed spec). The normalizer preserves every
log attribute in the canonical `attributes` object (section 7.4), so `order_id` is queryable
from ClickHouse. Order identity is used only by the acceptance script to prove that each
submitted order produced one of the triggering traces (section 13.2, step 4). Detection
never uses it.

### 7.3 Canonical event schema correction

`contracts/events/telemetry_event.schema.json` changes as follows. Nothing else in the file
changes:

- `trace_id` is removed from the top-level `required` array.
- Two conditional rules are added to the top-level schema using `allOf`:
  - when `type` is `trace` or `log`, `trace_id` is required;
  - when `type` is `metric`, `trace_id` is not permitted.
- `business_event` does not require `trace_id` and is not restricted by a conditional rule.
  Its requirement changes from "required" (current schema) to "optional" (new schema),
  because no business-event producer exists in this slice and the rule above defines trace
  and log requirements only.

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
message on `telemetry.raw.v1` contains exactly one top-level key: `resourceSpans`,
`resourceLogs`, or `resourceMetrics`. The normalizer maps each message to zero or more
canonical `telemetry_event` records. The OTLP JSON format is external and is pinned to the
Collector image version (`0.108.0`), so changes to it require a deliberate update.

Common fields for every record:

- `service` = resource attribute `service.name`. Required. Missing: invalid.
- `service_version` = `service.version`, if present.
- `environment` = `deployment.environment.name`, if present.
- `deployment_id` = `deployment.id`, if present. Absent means empty in ClickHouse.
- `schema_version` = `"1.0"`.
- `timestamp` = event time as UTC RFC 3339 with nanoseconds.

Per signal:

- **Trace (type `trace`):** one record per span. `trace_id` and `span_id` are the span's
  lower-case hex IDs. `timestamp` is the span start time. `attributes` contains the span's
  own attributes flattened to scalars, plus `span.name`, `span.kind` (`server` or `client`),
  `status.code` (`unset`, `ok`, or `error`), and `parent_span_id` (empty for a root span).
  Event identity: section 7.5.
- **Log (type `log`):** one record per log record. `trace_id` and `span_id` come from the
  log record; `trace_id` must be present (`span_id` optional). `severity` maps `DEBUG`,
  `INFO`, `WARN`, `ERROR`, `FATAL` to `debug`, `info`, `warn`, `error`, `fatal`. `timestamp`
  is `timeUnixNano`, or `observedTimeUnixNano` if the first is zero. `attributes` contains
  **every attribute on the log record, unchanged** (including `order_id`), plus `log.body`.
- **Metric (type `metric`):** one record per data point of sums, gauges, and histograms.
  No `trace_id`. `attributes` contains the data point attributes plus `metric.name`,
  `metric.kind` (`sum`, `gauge`, or `histogram`), and `metric.value` (sum and gauge), or
  `metric.count` and `metric.sum` (histogram). `timestamp` is the data point's
  `timeUnixNano`.

Unsupported top-level keys, a missing `service.name`, and metric types other than sum,
gauge, or histogram are invalid and go to the dead-letter topic.

### 7.5 Deterministic event identity

Every canonical record gets `event_id = UUIDv5(NAMESPACE, key)`, where
`NAMESPACE = 8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d` (fixed) and `key` is:

- trace: `trace|<trace_id>|<span_id>`
- log: `log|<trace_id>|<span_id>|<timestamp_unix_nanos>|<sha256_hex_of_log.body>`
- metric: `metric|<service>|<metric.name>|<sorted attribute key=value pairs joined by ,>|<timestamp_unix_nanos>`
- deployment: `deployment|<deployment_id>`

The UUIDv5 algorithm is RFC 4122 section 4.3 with SHA-1, implemented with the Go standard
library. Redelivering the same record yields the same `event_id`, which is what makes
ingestion idempotent (section 7.6).

### 7.6 Ingestion, idempotency, and dead letters

- Consumer group: `collector-go-normalizer`. It consumes `telemetry.raw.v1` and
  `deployments.v1` in one consumer. Offsets are committed only after the records from that
  message are written to ClickHouse successfully.
- Delivery is at-least-once. Duplicates are removed by ClickHouse table engines (section 9)
  and read with `FINAL`.
- Each partition is processed in order. The demo uses one partition per topic.
- **Dead letters:** a message that cannot be mapped or validated produces one message on
  `telemetry.dead-letter.v1` (shape in section 8.3) and its offset is committed. Its records
  are not written to ClickHouse, and the consumer continues with the next message.
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
    protocol_version: 2.0.0
```

`protocol_version: 2.0.0` is an explicit compatibility choice for Redpanda v24.2.7. It is
not a documented requirement of the Collector. Task 3 of the implementation plan verifies
it by live delivery: a record produced by the Collector must be consumed from
`telemetry.raw.v1`. If that check fails, the value is changed and re-verified, and the
change is recorded in ADR 0004.

Each pipeline lists `exporters: [debug, kafka]`. The implementation verifies delivery with
the acceptance script (section 13), not by inspecting the Collector's internals.

### 8.2 Topics

All topics have 1 partition and replication factor 1, created by the `redpanda-init` service
(section 12.3).

| Topic | Producer | Consumer | Key |
|---|---|---|---|
| `telemetry.raw.v1` | Collector (kafka exporter) | Normalizer | none (one partition) |
| `deployments.v1` | Deploy script | Normalizer | `deployment_id` |
| `telemetry.dead-letter.v1` | Normalizer | Operators (manual inspection) | source offset |
| `incidents.created.v1` | Publisher (section 12.4) | Future consumers; acceptance script | `incident_id` |

### 8.3 Dead-letter payload

```json
{
  "schema_version": "1.0",
  "reason": "trace_id and span_id are required for trace events",
  "source_topic": "telemetry.raw.v1",
  "source_partition": 0,
  "source_offset": 42,
  "received_at": "2026-10-03T12:00:00.000000000Z",
  "raw_payload": "<original message value as a string>"
}
```

`reason` is one of a fixed set of messages defined in the normalizer's error table, so tests
can assert exact values.

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

`previous_version` is omitted. The deployment timestamp is the UTC time the script publishes
the event, which is after the health check passes.

### 8.5 Incident payload (`incidents.created.v1`)

The payload is exactly one object matching `contracts/events/incident.schema.json`
(unchanged). The Kafka message key is the `incident_id`.

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

**Delivery guarantee.** Publication is at-least-once. Each incident is persisted exactly
once: after `FINAL`, the `incidents` table holds one latest row per `incident_id`, and the
evidence rows are unique per `evidence_id`. The publisher may produce the same payload more
than once. This happens when the process stops after a successful produce and before the
published state is written (section 12.4). Consumers deduplicate by `incident_id`. The
normal healthy path produces exactly one message per incident.

Evidence is not published on this topic. It is available from ClickHouse by `incident_id`.

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
| `incidents` | `ReplacingMergeTree(revision)` | `incident_id` | Incident revisions; latest revision is the state. |
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
- `incidents`: `incident_id UUID`, `revision UInt64`, `dedup_key String`,
  `environment LowCardinality(String)`, `service LowCardinality(String)`,
  `deployment_id String`, `trigger_rule String`, `title String`,
  `status LowCardinality(String)`, `severity LowCardinality(String)`,
  `started_at DateTime64(9, 'UTC')`, `detected_at DateTime64(9, 'UTC')`,
  `services Array(String)`, `publication_state LowCardinality(String)` (`pending` or
  `published`), `published_at Nullable(DateTime64(9, 'UTC'))` (`NULL` while pending; a non-null
  UTC timestamp once published).
- `evidence_items`: `evidence_id UUID`, `incident_id UUID`,
  `source_type LowCardinality(String)`, `source_ref String`,
  `timestamp DateTime64(9, 'UTC')`, `service LowCardinality(String)`, `summary String`,
  `reliability LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `correlation_runs`: `run_id UUID`, `evaluated_until DateTime64(9, 'UTC')`,
  `created_at DateTime64(3, 'UTC')`.

**Revision pattern.** The `incidents` table is written only by inserts. Creating an
incident inserts revision 1 with `publication_state = 'pending'`. Marking it published
inserts a new row with the same `incident_id` and fields, `revision` one higher,
`publication_state = 'published'`, and `published_at` set to a non-null UTC timestamp;
`detected_at` is copied unchanged. A pending revision always has `published_at = NULL`. `ReplacingMergeTree(revision)` keeps the highest revision per `incident_id`.
Reads that need the current state use `FINAL`. Evidence rows keep the same pattern with
`ingested_at` as their version column, and their IDs are deterministic (section 12.2), so
repeated inserts are harmless.

No TTL or retention is set. Retention is out of scope (section 4).

Tables are read with `FINAL` wherever correctness depends on deduplication.

## 10. Detection rule

The correlator evaluates the rule over canonical records from the last 10 minutes
(wall-clock lookback) on each cycle (section 10.2). Inside that window, all time comparisons
use event time, never the clock of the machine running the correlator.

### 10.1 Rule `payments-5xx-burst-after-deployment`

Inputs:

- **Failure records:** `telemetry_events` rows with `type = 'trace'`, `service = 'demo-payments'`,
  `attributes` `span.kind = 'server'`, and `http.response.status_code = 500`, with a non-empty
  `deployment_id`. Records with the same `trace_id` are collapsed to the earliest
  `timestamp`, so each trace counts once.
- **Deployments:** `deployments` rows with `service = 'demo-payments'` and
  `status = 'succeeded'`.

Procedure, for each deployment `D` (ordered by timestamp):

1. Let `F` be the failure records whose `deployment_id = D.deployment_id`, sorted by
   `timestamp` ascending, with duplicate traces removed.
2. Find the smallest index `i` such that `F[i]`, `F[i+1]`, `F[i+2]` all exist and
   `F[i+2].timestamp - F[i].timestamp <= 30 seconds`. If none exists, `D` produces no incident.
3. Let `T0 = F[i].timestamp`, the first triggering failure. Require `D.timestamp <= T0` and
   `T0 - D.timestamp <= 5 minutes`. If not, `D` produces no incident for this cycle.
4. Apply the deduplication check (section 11). If it suppresses the candidate, stop.
5. Otherwise create an incident (section 12.1) with `started_at = T0`, and evidence for `D`
   and `F[i]`, `F[i+1]`, `F[i+2]`.

Only one incident is created per deployment per cycle. Further failures in the same burst
are covered by the deduplication window.

Rationale for "three distinct traces": a single retried or repeated request could produce
several spans. Counting distinct trace IDs measures distinct failing requests.

### 10.2 Correlator cycle

- Runs every 1 second.
- Each cycle reads failure records and succeeded deployments from the lookback window, runs
  section 10.1 for every deployment, repairs evidence for existing incidents (section 12.2),
  and inserts one `correlation_runs` row with `evaluated_until` equal to the maximum
  `timestamp` of the failure records read in that cycle (or the current event time if none
  were read).
- A cycle that fails to read ClickHouse logs the error, inserts nothing, and retries on the
  next cycle.

Because each cycle re-evaluates the same window, a record that arrives late is still
evaluated, and an existing incident is never created twice.

The correlator never publishes. Publication is the publisher's responsibility (section 12.4).

## 11. Deduplication

Dedup key: `dedup_key = environment|service|deployment_id|trigger_rule`.

Window: 5 minutes of event time.

Rule: a candidate with start time `T0` is suppressed when an existing incident with the same
`dedup_key` has `started_at` in the interval `[T0 - 5 minutes, T0)`. A candidate that is more
than 5 minutes after an existing incident starts a new incident.

Stable identity: `incident_id = UUIDv5(NAMESPACE, dedup_key|<T0 as nanoseconds>)`. The same
burst always produces the same ID. A re-run therefore finds the existing row instead of
creating a second one.

Interpretation: the window is measured from the start of the earlier incident, not from its
detection time, so the dedup decision depends only on event time.

## 12. Incident and evidence

### 12.1 Incident

| Field | Value on creation (revision 1) |
|---|---|
| `incident_id` | Section 11 |
| `revision` | `1` |
| `title` | `Payments 5xx burst after deployment <deployment_id>` |
| `status` | `open` |
| `severity` | `high` |
| `started_at` | `T0` |
| `detected_at` | Wall-clock UTC time of the first insert; copied unchanged into later revisions |
| `services` | `["demo-payments"]` |
| `trigger_rule` | `payments-5xx-burst-after-deployment` |
| `dedup_key` | Section 11 (ClickHouse column; not in the public payload) |
| `publication_state` | `pending` |
| `published_at` | `NULL` |

### 12.2 Evidence

Every incident has exactly four evidence rows:

| Row | `source_type` | `source_ref` | `timestamp` | `summary` |
|---|---|---|---|---|
| 1 | `deployment` | `deployment_id` | `D.timestamp` | `demo-payments version <new_version> deployed` |
| 2 | `trace` | `trace_id` of `F[i]` | `F[i].timestamp` | `demo-payments returned HTTP 500 for trace <trace_id>` |
| 3 | `trace` | `trace_id` of `F[i+1]` | `F[i+1].timestamp` | same pattern |
| 4 | `trace` | `trace_id` of `F[i+2]` | `F[i+2].timestamp` | same pattern |

`evidence_id = UUIDv5(NAMESPACE, incident_id|<source_ref>)`. `reliability` is `high` for all
four rows, because each is a direct record rather than an inference.

Creation order is: insert the incident row (revision 1, `publication_state = pending`), then
insert the four evidence rows. If the second step fails, the next correlator cycle finds the
incident already exists and re-inserts any missing evidence (the rows are idempotent by
`evidence_id`). The publisher does not publish an incident until all four rows exist
(section 12.4). If the process crashes before the fourth row exists, the same repair path
completes the evidence before any publication.

### 12.3 Redpanda topic creation and Compose services

The one-shot Compose service `redpanda-init` creates the four topics in section 8.2 before
any producer or consumer starts. Its image is the same `redpandadata/redpanda` image already
used by `redpanda`, and it runs once with `restart: "no"`:

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

### 12.4 Durable publication

`collector-go` runs three loops in one process: the normalizer, the correlator (section
10.2), and the publisher. The publisher runs every 1 second.

**Store operations used by the publisher.**
- `PendingIncidents()`: returns the latest revision of every incident whose
  `publication_state` is `pending` and whose `published_at` is `NULL`.
- `EvidenceCount(incident_id)`: returns the number of evidence rows for an incident.
- `MarkIncidentPublished(incident, published_at)`: inserts revision `incident.revision + 1`
  with `publication_state = published` and a non-null `published_at`, all other fields copied.

**Publisher cycle, for each pending incident:**
1. If `EvidenceCount` is less than 4, skip it. The correlator repairs evidence (section 12.2),
   and the incident is considered again on the next cycle.
2. Produce the payload of section 8.5 to `incidents.created.v1`, with the key set to
   `incident_id`. If the produce fails, log `publish failed` with the incident ID and attempt
   number, leave the state `pending`, and try again on the next cycle. Attempts are not
   capped; each attempt is logged.
3. After a successful produce, call `MarkIncidentPublished`. If that call fails, log
   `publish state write failed` and leave the state `pending`. The next cycle produces the
   same payload again and then marks it published.

**Crash behavior.** If the process stops between steps 2 and 3, the incident stays `pending`.
On restart the publisher produces the same message again, because the published state was
never recorded. This is the at-least-once behavior the spec allows. No row is duplicated,
because the incident and its evidence keep their deterministic IDs and the revision bump
replaces the earlier state.

**Restart with incomplete evidence.** A crash before the fourth evidence row exists leaves
the incident `pending` with fewer than four evidence rows. On restart the correlator repairs
the missing rows first (section 12.2), and only then does the publisher produce.

**Test hooks (disabled by default).** Two environment variables exercise these paths in the
acceptance script. Both are read by `internal/config` and documented in the service README:

| Variable | Default | Behavior |
|---|---|---|
| `INCIDENT_PUBLISH_FAIL_ATTEMPTS` | `0` | The first N produce attempts in the process lifetime return an error without producing. |
| `INCIDENT_CRASH_AFTER_PRODUCE` | `0` | When `1`, the process exits with status 1 after the first successful produce and before `MarkIncidentPublished`. |

## 13. Acceptance criteria

### 13.1 Contract and unit checks

1. `contracts/events/telemetry_event.schema.json` matches section 7.3 exactly.
2. `scripts/validate-schemas.py` passes for:
   - all existing valid samples;
   - a new valid metric sample without `trace_id`;
   - two new invalid samples, `contracts/events/samples/invalid/telemetry_event.trace-without-trace-id.json`
     and `contracts/events/samples/invalid/telemetry_event.log-without-trace-id.json`, which
     must fail validation.
   The script exits non-zero if any invalid sample passes.
3. Go unit tests pass for: the mapping (every field in section 7.4, including log attribute
   preservation), UUIDv5 identity (section 7.5), the dead-letter error table, the detection
   rule (section 10.1) including each rejection branch, deduplication (section 11), evidence
   construction and repair (section 12.2), and the publisher (section 12.4): success,
   produce failure with retry, mark failure with retry, crash after produce with restart, and
   incomplete evidence not published.
4. `demo-payments` unit tests pass for: fault enabled returns 500 and the exact body for a
   valid request and for an invalid request; fault disabled matches the completed slice; an
   invalid `PAYMENTS_FAULT_MODE` causes startup failure; `/health` returns 200 in both modes.

### 13.2 Scenario checks (`scripts/verify-faulty-deployment-incident.mjs`)

Precondition: the Compose services `redpanda`, `redpanda-init`, `clickhouse`,
`otel-collector`, `collector-go`, `demo-orders`, and `demo-payments` are running and healthy
(section 12.3), and `collector-go` has the default test-hook values.

Each scenario uses a new deployment ID, so each produces its own incident.

**Scenario A: main correlation path.**

1. Deploy the faulty version with fault mode enabled and a fresh deployment ID. Expected:
   exit 0, and the script prints the deployment ID.
2. Poll ClickHouse until a `deployments` row exists with that ID and status `succeeded`.
3. Send three orders with fresh UUID `order_id`s, one after another, and record them as
   `O1`, `O2`, `O3`. Each returns HTTP 502 with the documented body.
4. **Order-to-trace identity.** Poll ClickHouse until the Orders `payment failed` log
   records for `O1`, `O2`, and `O3` are present, then collect their trace IDs:
   ```sql
   SELECT JSONExtractString(attributes, 'order_id') AS order_id, trace_id
   FROM telemetry_events FINAL
   WHERE type = 'log' AND service = 'demo-orders' AND severity = 'error'
     AND JSONExtractString(attributes, 'order_id') IN ('O1', 'O2', 'O3')
   ```
   This must return exactly one row per order, giving three trace IDs `T(O1)`, `T(O2)`,
   `T(O3)`. Then poll until the Payments failure traces for the deployment, that is the
   distinct `trace_id` values of `type='trace'`, `service='demo-payments'`,
   `span.kind='server'`, `http.response.status_code=500`, and this `deployment_id`, form a
   set `S`. Assert that `S` equals exactly `{T(O1), T(O2), T(O3)}`. This shows that the
   trigger traces are the traces of these three orders, not merely three traces in a window.
5. Poll (500 ms, 60 s) for exactly one incident row with
   `dedup_key = <env>|demo-payments|<deployment_id>|payments-5xx-burst-after-deployment`
   (latest revision). Assert `severity = 'high'`, `status = 'open'`,
   `services = ['demo-payments']`, `started_at` equals the minimum timestamp among the
   three trigger Payments traces, to the nanosecond, and `detected_at >= started_at`.
6. Assert exactly four `evidence_items` rows for the incident: one `deployment` row whose
   `source_ref` is the deployment ID, and three `trace` rows whose `source_ref` set equals
   `{T(O1), T(O2), T(O3)}`.
7. **Publication.** Poll (500 ms, 60 s) until the latest incident revision has
   `publication_state = 'published'`. Then consume `incidents.created.v1` with the bounded
   reader (Task 3) and assert that at least one record has this `incident_id` as its key and
   its `incident_id` field. In the healthy path there is exactly one such record. The script
   asserts exactly one, because this scenario has no injected faults.
8. **Dedup.** Send three more faulty orders `O4`, `O5`, `O6` and resolve their traces as in
   step 4. Poll (500 ms, 60 s) until `correlation_runs` has `evaluated_until` at or after the
   newest of their failure timestamps. Assert:
   - `IncidentsByKey` for the same dedup key returns exactly one incident;
   - that incident has exactly four evidence rows;
   - none of `T(O4)`, `T(O5)`, `T(O6)` appears as an evidence `source_ref`.
9. **Dead letter.** Publish one malformed trace message to `telemetry.raw.v1` with
   `rpk topic produce` (no `traceId`). Poll (500 ms, 30 s) for a message on
   `telemetry.dead-letter.v1` whose `reason` is `trace_id and span_id are required for trace
   events`. Assert no `telemetry_events` row exists for the malformed record. Then send one
   valid order and poll (500 ms, 30 s) until its trace appears in `telemetry_events`.
10. **Idempotency.** Build one valid trace message with fixed IDs (`traceId`
    `0af7651916cd43dd8448eb211c80319c`, `spanId` `b7ad6b7169203331`, `service.name` `demo-orders`,
    start time now). Publish it to `telemetry.raw.v1` twice, then publish a sentinel message
    with its own fixed IDs. The topic has one partition, so messages are consumed in order:
    when the sentinel appears in `telemetry_events`, both duplicates were processed. Assert the
    `FINAL` count of rows with the fixed message's `event_id` (computed with section 7.5) is 1.

**Scenario B: failed publication, retried without duplicates.**

11. Recreate `collector-go` with `INCIDENT_PUBLISH_FAIL_ATTEMPTS=2`, passed through the
    process environment. Wait for health. Deploy a new faulty deployment (`D2`) and send three
    orders. Poll (500 ms, 60 s) until the incident for `D2` exists and its state is
    `published`. Assert:
    - the `collector-go` logs contain at least two `publish failed` lines for this incident ID;
    - exactly one incident row for the `D2` dedup key after `FINAL`;
    - exactly four evidence rows;
    - the bounded consume of `incidents.created.v1` returns at least one record with this
      incident ID.

**Scenario C: crash between produce and publication state, then restart.**

12. Recreate `collector-go` with `INCIDENT_CRASH_AFTER_PRODUCE=1`. Deploy a new faulty
    deployment (`D3`) and send three orders. Poll (500 ms, 60 s) until the `collector-go`
    container state is `exited` with exit code 1. Recreate `collector-go` with default test
    hooks. Poll (500 ms, 60 s) until the incident for `D3` has state `published`. Assert:
    - exactly one incident row for the `D3` dedup key after `FINAL`;
    - exactly four evidence rows for it;
    - the bounded consume of `incidents.created.v1` returns at least two records with this
      incident ID, because the produce happened before the crash and again after restart. Both
      records have the same key, which is the allowed at-least-once duplicate.

**Restore (always runs).**

13. In a `finally` block: recreate `collector-go` with default test hooks, and run
    `node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled`. Each step's exit status
    is recorded. A failure here makes the overall run fail even if all assertions passed.

**Output.** On success, print the incident row, the four evidence rows, the incident ID, the
publication state, and the deployment IDs of all three scenarios, then print `PASS`. On
failure, print `FAIL <step>: <message>` and the recent `collector-go` logs.

**Exit status:** 0 only if every assertion in scenarios A, B, and C passes and the restore
step succeeds.

### 13.3 Bounded polling deadlines

| Wait | Interval | Deadline |
|---|---|---|
| Container health after deploy or recreate | 1 s | 60 s |
| `collector-go` container exits with code 1 (scenario C) | 1 s | 60 s |
| Deployment row visible in ClickHouse | 500 ms | 30 s |
| Payments and Orders log traces visible in ClickHouse | 500 ms | 30 s |
| Incident or evidence visible | 500 ms | 60 s |
| Incident publication state `published` | 500 ms | 60 s |
| Correlator run covering the dedup batch | 500 ms | 60 s |
| Dead-letter message visible | 500 ms | 30 s |
| Compose one-shot `redpanda-init` completion | 1 s | 60 s |

The deadlines are longer than the completed slice's 10 seconds because they cover a longer
pipeline: export interval (1 s), Kafka hop, normalizer, ClickHouse write, correlator cycle,
and publisher cycle. Every wait uses `pollUntil` with a named timeout error. Every Kafka read
is bounded by a 5-second process kill timer (Task 3).

No fixed `sleep` is used in the script or in any service.

### 13.4 End-to-end and repeatability

- The acceptance script passes on two consecutive runs. Each run uses fresh deployment IDs and
  fresh order IDs, so each produces its own incidents, and the second run does not treat the
  first run's incidents as its own.
- The script exits 0 only when every step in section 13.2 passes.
- After the script, `docker compose ... down` leaves no SignalForge containers or networks.

## 14. Known gaps this slice does not close

- Week 2 redaction of sensitive fields at the Collector remains unimplemented and untested.
- Retention and TTL are not configured.
- Redpanda is reached only from inside the Compose network. Host clients need a second
  listener, which is not added.
- The `prometheus` service scrapes only itself. Platform metrics for SignalForge are not
  scraped.
- The correlator and publisher run in one process. Two instances would race on incident
  creation and publication. Single-instance operation is required.
- Clock skew between containers is assumed to be negligible on the local Docker host.
- Consumers of `incidents.created.v1` must deduplicate by `incident_id`. No consumer in this
  slice exists to enforce it.

## 15. Testing strategy

- **Contracts:** `scripts/validate-schemas.py` covers valid and invalid samples (section 13.1).
- **Go unit tests:** pure logic and fake stores/producers, run in Docker (section 16). No
  network, no ClickHouse, no Redpanda. The fake store reproduces `ReplacingMergeTree` semantics:
  for each key it returns the row with the highest version, which lets tests check
  "no duplicate rows" exactly.
- **Go integration checks:** the normalizer and correlator run against the real ClickHouse
  container (Task 9). The acceptance script is the end-to-end integration test.
- **Node unit tests:** `demo-payments` fault mode and configuration (section 13.1), and the
  deployment script (section 17).
- **Acceptance:** `scripts/verify-faulty-deployment-incident.mjs`, run twice (section 13.4).

Tests use fixed fixtures so results do not depend on timing. Timing-dependent behavior is
checked only in the acceptance script, with bounded polling.

## 16. Docker-based Go workflow

Go is not installed on the host. All Go commands run in a container built from the official
Go builder image.

- Builder image: `golang:1.27-alpine`, pinned by digest (below). Go version: `go1.27.1`,
  the latest stable release at the time of the source check (2026-10-03).
- Pinned builder: `golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414`,
  the index digest from the Docker Hub tag record for `library/golang:1.27-alpine` (checked
  2026-10-03). Tags are never used without this digest.
- Wrapper: `scripts/go-in-docker.mjs` runs `docker run --rm` with the absolute path of
  `services/collector-go` mounted at `/src`, working directory `/src`, and the command
  passed through. It computes paths with `path.resolve` and `url.fileURLToPath`, so the same
  invocation works on Windows PowerShell and Unix shells.
- Commands:
  - `node scripts/go-in-docker.mjs go test ./...`
  - `node scripts/go-in-docker.mjs go vet ./...`
  - `node scripts/go-in-docker.mjs go build -o /src/bin/collector-go ./cmd/collector-go`
- The production image is a multi-stage build: the builder compiles a static binary
  (`CGO_ENABLED=0`), and the runtime stage is `scratch` containing only the binary.
- `services/collector-go/bin/` is gitignored.

## 17. Deployment mechanism

`scripts/deploy-payments.mjs` accepts:

| Flag | Required | Values | Default |
|---|---|---|---|
| `--version` | yes | any non-empty string | none |
| `--environment` | no | non-empty string | `local` |
| `--fault` | no | `enabled` or `disabled` | `disabled` |

Steps, in order. A failure at any step stops the script with exit status 1 and a message naming
the step:

1. Generate `deployment_id` with `crypto.randomUUID()`.
2. Run `docker compose -f infra/docker/docker-compose.yml up -d --force-recreate --no-deps demo-payments`
   via `child_process.spawn` with `env` set to the parent environment plus
   `PAYMENTS_VERSION=<version>`, `DEPLOYMENT_ENVIRONMENT=<environment>`,
   `DEPLOYMENT_ID=<deployment_id>`, `PAYMENTS_FAULT_MODE=<fault>`.
3. Poll `docker inspect --format {{.State.Health.Status}} signalforge-demo-payments-1` until
   the value is `healthy` (section 13.3). A poll timeout aborts the script before any event is
   published.
4. Publish one message to `deployments.v1` with
   `docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic produce deployments.v1 --key <deployment_id> --brokers redpanda:9092`,
   writing the JSON payload of section 8.4 to the process's standard input.
5. Print `deployment_id=<deployment_id>` on its own line and exit 0.

The script publishes only the succeeded event. If step 4 fails, the script exits 1 and prints
the `deployment_id`, so an operator can see which deployment had no event.

The container name `signalforge-demo-payments-1` is the Compose project's default name for the
project `signalforge`.

## 18. Error handling summary

| Condition | Behavior |
|---|---|
| Invalid `PAYMENTS_FAULT_MODE` | `demo-payments` exits at startup. |
| Invalid `INCIDENT_PUBLISH_FAIL_ATTEMPTS` or `INCIDENT_CRASH_AFTER_PRODUCE` | `collector-go` exits at startup (section 12.4). |
| Message on `telemetry.raw.v1` cannot be mapped or validated | Dead letter, offset committed, pipeline continues. |
| ClickHouse write fails | Retry with backoff up to 2 minutes, then exit 1 without committing. |
| Correlator read fails | Logged, cycle skipped, retried next cycle. |
| Correlator evidence insert fails | Repaired on the next cycle (section 12.2); the publisher waits for four rows. |
| Publisher produce fails | Logged, incident stays `pending`, retried next cycle without a cap. |
| Publisher state write fails after produce | Logged, incident stays `pending`, produced again next cycle (allowed duplicate). |
| Process crashes between produce and state write | On restart the incident is produced again; no duplicate row (section 12.4). |
| Deploy health poll times out | Script exits 1 before publishing the deployment event. |
| Deployment event publish fails | Script exits 1 and prints the `deployment_id`. |
| Acceptance assertion fails | Script exits 1, prints the failing step, and still runs the restore step. |

## 19. Expected file-level impacts

Documentation: this spec; `docs/decisions/0004-faulty-deployment-correlation.md` (ADR
recording the choices in sections 6.2, 7.1, 7.2, 8.1, 9, 10, 11, 12.4, 16, and 17).

Contracts:
- `contracts/events/telemetry_event.schema.json` (section 7.3).
- `contracts/events/dead_letter.schema.json` (new; section 8.3).
- `contracts/events/samples/telemetry_event.metric.sample.json` (new).
- `contracts/events/samples/invalid/telemetry_event.trace-without-trace-id.json` (new).
- `contracts/events/samples/invalid/telemetry_event.log-without-trace-id.json` (new).
- `contracts/events/samples/dead_letter.sample.json` (new).
- `scripts/validate-schemas.py` (valid and invalid sample checks, section 13.1).

Demo services:
- `services/demo-payments/src/server.ts` (fault mode, section 6.3).
- `services/demo-payments/src/instrument.ts` (resource attributes, section 6.4).
- `services/demo-payments/src/config.ts` (new; reads and validates environment, section 6.3).
- `services/demo-payments/test/config.test.ts` and `test/fault.test.ts` (new).

Collector and Compose:
- `observability/otel-collector/config.yaml` (kafka exporter, section 8.1).
- `infra/docker/docker-compose.yml`: add `redpanda-init` (section 12.3); add healthchecks for
  `redpanda` and `clickhouse`; make `collector-go` real (build from `services/collector-go`,
  environment including the two test hooks with defaults `0`, dependencies on `redpanda-init`
  with `service_completed_successfully` and on `clickhouse` healthy, `restart: "no"`); add the
  four `demo-payments` deployment variables with the defaults in section 6.4.
- `.env.example`: document the deployment variables and the two test hooks. Compose defaults
  make them optional.

Go service (`services/collector-go/`, replaces the placeholder README):
- `go.mod`, `go.sum`; `Dockerfile` (section 16); `.dockerignore`.
- `cmd/collector-go/main.go`: starts the normalizer, correlator, and publisher loops in one
  process.
- `internal/config/`: environment variables `KAFKA_BROKERS`, `CLICKHOUSE_HOST`,
  `CLICKHOUSE_PORT`, `CLICKHOUSE_DB`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`,
  `INCIDENT_PUBLISH_FAIL_ATTEMPTS`, `INCIDENT_CRASH_AFTER_PRODUCE`.
- `internal/canonical/`: mapping with log attribute preservation (section 7.4), UUIDv5
  (section 7.5), dead-letter errors.
- `internal/ingest/`: Redpanda consumer, offset handling, dead-letter production.
- `internal/store/`: ClickHouse connection, migrations, batch writes, queries, the `Store`
  interface with the publisher operations of section 12.4.
- `internal/store/migrations/0001_correlation_schema.sql` (section 9, with the revisioned
  `incidents` table).
- `internal/correlate/`: detection (section 10), deduplication (section 11), incident and
  evidence construction and repair (section 12), and the correlator cycle.
- `internal/publish/`: the publisher cycle (section 12.4), the `incidents.created.v1` payload,
  and the test hooks.
- Unit tests beside each package.
- `services/collector-go/README.md` (replaces the placeholder text, documents the test hooks).

Scripts:
- `scripts/go-in-docker.mjs` (section 16).
- `scripts/rpk-consume-bounded.mjs` (bounded Kafka read, Task 3).
- `scripts/deploy-payments.mjs` (section 17).
- `scripts/verify-faulty-deployment-incident.mjs` (section 13.2).

Not touched: `services/demo-orders/*`, `services/demo-inventory/*`, the existing Orders/Payments
acceptance script, and `master`.

## 20. Self-review

- **Ambiguity:** each rule has one interpretation. The deployment linkage window is relative to
  the first trigger (section 10.1 step 3). The dedup window is from the existing incident's start
  (section 11). Publication states and the at-least-once guarantee are defined in sections 8.5
  and 12.4. Order identity is used only by the acceptance script (section 7.2).
- **Contradictions:** the completed spec's "no failure branch" statement is overridden (section
  5). The plan's `telemetry.normalized.v1` topic is omitted with a reason (section 7.1). The
  exporter's `protocol_version` is `2.0.0` in this spec and the plan; the earlier `2.1.0` in this
  spec was a mismatch and is corrected (section 8.1). "Exactly one message" is no longer
  promised; the guarantee is one persisted incident and at-least-once publication, with the
  healthy path producing one message (section 8.5).
- **Missing boundaries:** every component's responsibilities and non-responsibilities are listed
  (section 6.1). The correlator no longer publishes; the publisher owns publication.
- **Scope:** no dashboard, agent, approval, replay, retention, or second scenario (section 4). The
  only new runtime behavior is the Payments fault branch, the Collector export, the Go normalizer,
  correlator, and publisher, the test hooks, and the deploy script.
- **Placeholders:** the Go builder version and digest are fixed in section 16. No value is left to
  be decided during implementation.
