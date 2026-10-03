# Faulty-deployment incident correlation — implementation plan

Status: **Proposed for review.** Execution must not begin until this status line reads
"Approved for execution" with an approval date.

Source specification: [2026-10-03-faulty-deployment-incident-correlation.md](../specs/2026-10-03-faulty-deployment-incident-correlation.md)
(approved design; every behavioral requirement below traces to a section of that spec).

Branch: `feature/faulty-deployment-correlation` (worktree
`.claude/worktrees/feature+faulty-deployment-correlation`, based on `master` at `046887a`).

## 1. Goal

Make one deliberately faulty `demo-payments` deployment produce exactly one persisted,
deduplicated, high-severity incident in ClickHouse, with `started_at` from the first
failing request, the deployment event and three triggering traces as evidence, and one
`incidents.created.v1` message. Prove it with a bounded acceptance script that passes
twice with fresh deployment IDs and restores healthy Payments afterwards.

## 2. Architecture

```
demo-orders ─┐                      scripts/deploy-payments.mjs
             ├─ OTLP/HTTP ─▶ otel-collector                 │ publishes succeeded event
demo-payments┘   (batch → queue → retry → kafka exporter)   ▼
                                  │                  deployments.v1 ─┐
                                  ▼                                  │
                          telemetry.raw.v1 (otlp_json)               │
                                  └──────────────┬─────────────────────┘
                                                 ▼
                              collector-go normalizer (Go, franz-go consumer)
                                 │ valid → ClickHouse (ReplacingMergeTree)
                                 │ invalid → telemetry.dead-letter.v1
                                                 ▼
                              ClickHouse: telemetry_events, deployments
                                                 ▼
                              collector-go correlator (Go, 1 s cycle)
                                 │ incidents, evidence_items, correlation_runs
                                 └─▶ incidents.created.v1
```

Single Go process `collector-go` runs the normalizer and correlator goroutines. Compose
service `collector-go` replaces its placeholder.

## 3. Technology stack (exact, verified 2026-10-03)

| Item | Exact choice | Source of verification |
|---|---|---|
| Go toolchain | `go1.27.1` | `https://go.dev/VERSION?m=text` |
| Builder image | `golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414` (index digest) | Docker Hub `library/golang` tag `1.27-alpine` record, `digest` field |
| Runtime image | `scratch` (static binary, no shell, no base image) | Design choice; no pinned base needed |
| Kafka client | `github.com/twmb/franz-go` `v1.22.1` (package `pkg/kgo`) | `proxy.golang.org` `@latest`, 2026-09-27 |
| ClickHouse client | `github.com/ClickHouse/clickhouse-go/v2` `v2.48.0` (native protocol, port 9000) | `proxy.golang.org` `@latest`, 2026-08-04 |
| Collector image | `otel/opentelemetry-collector-contrib:0.108.0` (unchanged) | Existing Compose |
| Kafka exporter | `kafka` exporter, `encoding: otlp_json`, `protocol_version: "2.0.0"` | Contrib v0.108.0 exporter README: `protocol_version` required; `otlp_json` valid for all signals |
| Batch processor | `batch` with `send_batch_size: 512`, `timeout: 1s` | Collector v0.108.0 batch processor README (default `send_batch_size` 8192, `timeout` 200ms) |
| Exporter queue | `sending_queue` `enabled: true`, `num_consumers: 10`, `queue_size: 1000` (documented defaults, stated explicitly) | Collector v0.108.0 exporterhelper README |
| Exporter retry | `retry_on_failure` `enabled: true`, `initial_interval: 1s`, `max_interval: 5s`, `max_elapsed_time: 60s` | Collector v0.108.0 exporterhelper README |
| Kafka CLI | `rpk` in the Redpanda image (`redpandadata/redpanda:v24.2.7`, unchanged) | rpk source: `topic produce -k/--key` reads stdin; `topic consume -n/--num`, `-o/--offset`, `-f/--format` |
| Node | Existing Node 24 and built-ins only (`child_process`, `crypto`, `fs`, `url`, `path`). No new npm dependency. | Existing `package.json` files |
| Redpanda health | `rpk cluster info --brokers redpanda:9092` | rpk command reference |
| ClickHouse health | `clickhouse-client --query "SELECT 1"` | ClickHouse image |

Protocol choice: the exporter README (v0.108.0) requires `protocol_version` and gives
`2.0.0` as its example value. That README does not state Redpanda compatibility, so
the value is not assumed correct: Task 3 proves delivery end to end (a consumed
`telemetry.raw.v1` record). If delivery fails, Task 3 is reopened and the value is
changed only with a new recorded verification.

## 4. Global constraints

- Product code is added only by the tasks below. Each task lists its exact file set.
- No task installs anything on the host. Go runs only in Docker (section 5.2). Node
  uses only the built-in modules listed in section 3.
- No task starts containers except Tasks 3, 7, 9, 10, and 11, and each of those states
  its startup and teardown commands.
- Every Compose or Collector change is validated by starting the affected service and
  reading its logs (no `validate` subcommand is assumed).
- Every wait in every script is bounded and uses a named timeout error. No `sleep` is used
  except inside the bounded polling helper.
- Scripts are cross-platform: `child_process.spawn` with argument arrays, no shell
  strings, no `&&`, no inline `VAR=value`, no `grep`, no `/tmp`.
- Every task ends with its own commit. Staged files are listed explicitly.
- No retry logic is added to `demo-orders` or `demo-payments`.
- Canonical records are never fabricated: trace and log records must carry the
  trace/span IDs they were emitted with; metric records have no `trace_id`.
- ClickHouse reads that affect correctness use `FINAL`.

## 5. Review focus: five failure modes to check in every task

1. **Fabricated or mismatched trace IDs.** A trace or log record that gains an ID from
   anywhere but its own payload would cite the wrong request as evidence. Checked in
   Tasks 1, 7, and 8 by fixture tests that assert IDs are copied, not generated.
2. **Duplicate delivery counted twice.** At-least-once delivery plus unmerged
   `ReplacingMergeTree` parts can double-count without `FINAL`. Checked in Tasks 6 and 9
   by a republish test that asserts an unchanged `FINAL` count.
3. **Timestamp precision drift.** Nanosecond `started_at` values that round in transit
   break the exact-equality acceptance assertion. Checked in Tasks 6 and 9 with
   nanosecond fixtures and `DateTime64(9, 'UTC')` columns.
4. **Faulty version left deployed.** A failed acceptance run that does not restore
   Payments poisons the next run. Checked in Tasks 10 and 11 by a `finally` restore
   and a test that the restore runs after an injected failure.
5. **Partial incident writes.** An incident row without its evidence, or a publish
   after a failed insert, breaks the four-evidence and single-incident guarantees.
   Checked in Task 8 by an evidence-repair test and a publish-after-commit test.

## 6. File map

Created files are marked **new**; changed files are marked **change**.

| File | Status | Task | Responsibility |
|---|---|---|---|
| `contracts/events/telemetry_event.schema.json` | change | 1 | Conditional `trace_id` rule (spec 7.3). |
| `contracts/events/dead_letter.schema.json` | new | 1 | Dead-letter payload contract (spec 8.3). |
| `contracts/events/samples/telemetry_event.metric.sample.json` | new | 1 | Valid metric without `trace_id`. |
| `contracts/events/samples/dead_letter.sample.json` | new | 1 | Valid dead-letter sample. |
| `contracts/events/samples/invalid/telemetry_event.trace-without-trace-id.json` | new | 1 | Must fail validation. |
| `contracts/events/samples/invalid/telemetry_event.log-without-trace-id.json` | new | 1 | Must fail validation. |
| `scripts/validate-schemas.py` | change | 1 | Validates valid samples and requires invalid samples to fail. |
| `services/demo-payments/src/config.ts` | new | 2 | Reads and validates `PAYMENTS_FAULT_MODE`, resource attributes. |
| `services/demo-payments/src/server.ts` | change | 2 | Fault branch before validation. |
| `services/demo-payments/src/main.ts` | change | 2 | Passes loaded config to `buildServer`. |
| `services/demo-payments/src/instrument.ts` | change | 2 | Applies resource attributes from config. |
| `services/demo-payments/test/config.test.ts` | new | 2 | Config and resource attribute tests. |
| `services/demo-payments/test/fault.test.ts` | new | 2 | Fault mode behavior tests. |
| `infra/docker/docker-compose.yml` | change | 2, 3, 9 | `demo-payments` env (2); Redpanda and ClickHouse healthchecks and `redpanda-init` (3); `collector-go` real service (9). |
| `.env.example` | change | 2 | Documents the new deployment variables. |
| `observability/otel-collector/config.yaml` | change | 3 | Batch, queue, retry, kafka exporter. |
| `scripts/rpk-consume-bounded.mjs` | new | 3 | Runs `rpk topic consume` under a 30 s kill timer; returns parsed records. |
| `services/collector-go/go.mod`, `go.sum` | new | 4 | Module definition with pinned dependencies. |
| `services/collector-go/Dockerfile` | new | 4 | Multi-stage build: pinned Go builder, `scratch` runtime. |
| `services/collector-go/.dockerignore` | new | 4 | Excludes `bin/`, `*.md`, tests from the build context. |
| `services/collector-go/cmd/collector-go/main.go` | new | 9 | Process entry: config, migrations, both loops. |
| `services/collector-go/internal/config/config.go`, `config_test.go` | new | 4 | Environment loading with exact errors. |
| `services/collector-go/internal/canonical/otlp.go` | new | 6 | OTLP JSON structs. |
| `services/collector-go/internal/canonical/mapping.go`, `mapping_test.go` | new | 6 | Canonical mapping and validation. |
| `services/collector-go/internal/canonical/identity.go`, `identity_test.go` | new | 6 | UUIDv5 identity. |
| `services/collector-go/internal/canonical/deadletter.go` | new | 6 | Reason strings and dead-letter payload. |
| `services/collector-go/internal/canonical/testdata/*.json` | new | 6 | Fixtures for mapping. |
| `services/collector-go/internal/store/store.go` | new | 5 | `Store` interface and row types. |
| `services/collector-go/internal/store/migrate.go`, `migrate_test.go` | new | 5 | Idempotent migration runner. |
| `services/collector-go/internal/store/migrations/0001_correlation_schema.sql` | new | 5 | ClickHouse tables. |
| `services/collector-go/internal/store/clickhouse.go` | new | 5 | `Store` implementation over clickhouse-go. |
| `services/collector-go/internal/store/clickhouse_integration_test.go` | new | 5 | Integration test, skipped unless `CLICKHOUSE_HOST` is set. |
| `services/collector-go/internal/ingest/backoff.go`, `backoff_test.go` | new | 7 | Retry schedule. |
| `services/collector-go/internal/ingest/normalizer.go`, `normalizer_test.go` | new | 7 | Batch processing, commits, dead letters. |
| `services/collector-go/internal/ingest/kafka.go` | new | 7 | franz-go consumer and producer adapters. |
| `services/collector-go/internal/correlate/rule.go`, `rule_test.go` | new | 8 | Detection rule (spec 10.1). |
| `services/collector-go/internal/correlate/dedup.go`, `dedup_test.go` | new | 8 | Dedup and identities (spec 11). |
| `services/collector-go/internal/correlate/correlator.go`, `correlator_test.go` | new | 8 | Cycle, evidence repair, publish (spec 10.2, 12). |
| `services/collector-go/README.md` | change | 9 | Replaces placeholder text. |
| `services/collector-go/bin/` | ignored | 4 | Built binaries; excluded by `.gitignore`. |
| `.gitignore` | change | 4 | Adds `services/collector-go/bin/`. |
| `scripts/go-in-docker.mjs` | new | 4 | Runs Go commands in the pinned builder image. |
| `scripts/deploy-payments.mjs`, `scripts/deploy-payments.test.mjs` | new | 10 | Deployment mechanism (spec 17). |
| `scripts/verify-faulty-deployment-incident.mjs` | new | 11 | Acceptance scenario (spec 13.2). |
| `docs/decisions/0004-faulty-deployment-correlation.md` | new | 12 | ADR recording pinned choices. |
| `README.md` | change | 12 | Documents the slice, commands, and limits. |

## 7. Shared interfaces (single definition; all tasks use these names)

### 7.1 Node

```js
// scripts/deploy-payments.mjs
export function parseArgs(argv) // -> { version, environment, fault }  throws Error on invalid input
export function buildDeploymentEvent({ deploymentId, timestamp, version, environment }) // -> object per spec 8.4
export function buildComposeEnv(parentEnv, { version, environment, deploymentId, fault }) // -> env object
export function randomDeploymentId() // -> crypto.randomUUID()
```

```ts
// services/demo-payments/src/config.ts
export type FaultMode = 'enabled' | 'disabled';
export interface PaymentsConfig {
  faultMode: FaultMode;
  serviceVersion: string;        // PAYMENTS_VERSION, default "0.1.0"
  environment: string;           // DEPLOYMENT_ENVIRONMENT, default "local"
  deploymentId: string;          // DEPLOYMENT_ID, default "" (attribute omitted when empty)
}
export function loadConfig(env: Record<string, string | undefined>): PaymentsConfig; // throws Error('PAYMENTS_FAULT_MODE must be enabled or disabled')
export function resourceAttributes(config: PaymentsConfig): Record<string, string>;
// keys: "service.version", "deployment.environment.name", and "deployment.id" only if non-empty
export function buildServer(options: { faultMode: FaultMode }): FastifyInstance; // default { faultMode: 'disabled' }
```

### 7.2 Go (`signalforge/collector-go`)

```go
// internal/canonical
type Event struct {
    EventID        string         // lower-case UUID string
    SchemaVersion  string         // always "1.0"
    Timestamp      time.Time      // UTC, nanosecond precision
    Type           string         // "trace" | "log" | "metric"
    Service        string
    ServiceVersion string         // "" when absent
    Environment    string         // "" when absent
    DeploymentID   string         // "" when absent
    TraceID        string         // "" for metric; required for trace and log
    SpanID         string         // "" when absent (required for trace)
    Severity       string         // "debug"|"info"|"warn"|"error"|"fatal"; "info" for trace
    Attributes     map[string]any // JSON-encodable scalars; see spec 7.4
}

type Deployment struct {
    DeploymentID    string
    Timestamp       time.Time
    Service         string
    Environment     string
    NewVersion      string
    PreviousVersion string // "" when absent
    InitiatedBy     string // "" when absent
    Status          string // "succeeded"
}

type DeadLetter struct {
    SchemaVersion string    // "1.0"
    Reason        string    // exact text from section 8.2 of this plan
    SourceTopic   string
    SourcePartition int32
    SourceOffset  int64
    ReceivedAt    time.Time
    RawPayload    string
}

// Maps one telemetry.raw.v1 message to canonical events, or returns a reason.
func MapTelemetryMessage(payload []byte) (events []Event, reason string)
// Maps one deployments.v1 message to a Deployment, or returns a reason.
func MapDeploymentMessage(payload []byte) (Deployment, string)
// UUIDv5 with the fixed namespace.
func EventID(key string) string
const Namespace = "8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d"
```

```go
// internal/store
type Store interface {
    MigrateUp(ctx context.Context) error
    InsertEvents(ctx context.Context, events []canonical.Event) error
    InsertDeployments(ctx context.Context, deployments []canonical.Deployment) error
    FailureTraces(ctx context.Context, since time.Time) ([]FailureRow, error)
    SucceededDeployments(ctx context.Context, since time.Time) ([]canonical.Deployment, error)
    IncidentsByKey(ctx context.Context, dedupKey string) ([]IncidentRow, error)
    EvidenceCount(ctx context.Context, incidentID string) (int, error)
    InsertIncidentWithEvidence(ctx context.Context, inc IncidentRow, ev []EvidenceRow) error
    InsertEvidence(ctx context.Context, ev []EvidenceRow) error
    InsertCorrelationRun(ctx context.Context, run CorrelationRun) error
}

type FailureRow struct {
    TraceID, DeploymentID, Service string
    Timestamp                      time.Time // earliest span start for that trace
}
type IncidentRow struct {
    IncidentID, DedupKey, Environment, Service, DeploymentID, TriggerRule, Title string
    Status, Severity                                                             string
    StartedAt, DetectedAt                                                        time.Time
    Services                                                                     []string
}
type EvidenceRow struct {
    EvidenceID, IncidentID, SourceType, SourceRef, Service, Summary, Reliability string
    Timestamp                                                                    time.Time
}
type CorrelationRun struct {
    RunID          string
    EvaluatedUntil time.Time
    CreatedAt      time.Time
}
```

```go
// internal/ingest
type Record struct {
    Topic     string
    Partition int32
    Offset    int64
    Value     []byte
}
type Consumer interface {
    Poll(ctx context.Context) ([]Record, error)
    Commit(ctx context.Context, records []Record) error
}
type Producer interface {
    Produce(ctx context.Context, topic, key string, value []byte) error
}
type Normalizer struct { /* Consumer, Producer, store.Store, clock, backoff */ }
func (n *Normalizer) ProcessBatch(ctx context.Context, records []Record) error
```

```go
// internal/correlate
type Correlator struct { /* store.Store, Producer, clock, lookback 10m */ }
func (c *Correlator) RunCycle(ctx context.Context, now time.Time) error
// Pure detection
func DetectBurst(failures []store.FailureRow, deployments []canonical.Deployment) []Candidate
type Candidate struct {
    Deployment canonical.Deployment
    Triggers   [3]store.FailureRow // chronological, distinct traces
    StartedAt  time.Time            // == Triggers[0].Timestamp
}
```

Constants (fixed, not environment-configurable):

| Name | Value |
|---|---|
| `BurstCount` | 3 |
| `BurstWindow` | 30 s |
| `DeploymentWindow` | 5 min |
| `DedupWindow` | 5 min |
| `LookbackWindow` | 10 min (wall clock) |
| `CorrelatorInterval` | 1 s |
| `BackoffInitial` / `BackoffCap` | 1 s / 16 s |
| `BackoffGiveUp` | 2 min |
| `TriggerRule` | `payments-5xx-burst-after-deployment` |
| `Namespace` | `8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d` |

## 8. Behavior tables (exact strings)

### 8.1 Mapping and validation reasons

| Condition | Reason string |
|---|---|
| Payload is not JSON | `invalid JSON payload` |
| Payload has zero or several of `resourceSpans`/`resourceLogs`/`resourceMetrics` | `payload must contain exactly one of resourceSpans, resourceLogs, resourceMetrics` |
| Resource lacks `service.name` | `service.name resource attribute is required` |
| Span lacks `traceId` or `spanId` | `trace_id and span_id are required for trace events` |
| Log record lacks `traceId` | `trace_id is required for log events` |
| Metric type other than sum/gauge/histogram | `unsupported metric type: <type>` |
| Deployment payload is missing a required field | `deployment event is missing <field>` |
| Deployment `status` is not `succeeded` | `deployment event status must be succeeded` |

### 8.2 Dead-letter reason values used in fixtures

The four reasons in 8.1 that tests assert exactly are `invalid JSON payload`,
`trace_id and span_id are required for trace events`, `trace_id is required for log events`,
and `service.name resource attribute is required`. The acceptance script asserts the
reason `trace_id and span_id are required for trace events` for the malformed record it publishes
(which carries a `resourceSpans` span with no `traceId`).

### 8.3 Retry and give-up

- Attempt delays: 1 s, 2 s, 4 s, 8 s, 16 s, 16 s, … until 2 minutes of cumulative
  delay has elapsed. Then `ProcessBatch` returns the last error and the process exits 1.
- Offsets are never committed for a batch whose ClickHouse write or dead-letter
  produce failed.

### 8.4 Correlator outcomes

| Condition | Outcome |
|---|---|
| Candidate's `incident_id` already exists | Repair missing evidence only (no incident insert, no publish). |
| Dedup window suppresses candidate | Nothing written. |
| Otherwise | Insert incident row, then four evidence rows, then publish `incidents.created.v1`. |
| Publish fails after the insert | Logged as an error. Not retried. The ClickHouse incident is the source of truth. |
| ClickHouse read fails | Cycle returns the error; the loop logs it and continues on the next tick. |

Publication is best-effort after the commit (decision recorded in ADR 0004). This is a
deliberate limitation, not a guarantee. Section 13 lists it as a review item.

## 9. Tasks

Ten tasks, executed in order. Each lists dependencies, RED→GREEN steps, exact commands,
staged files, and its commit message. Every task's tests are owned by that task; the
acceptance coverage map is in section 10.

---

### Task 1 — Telemetry contract correction and contract samples

**Depends on:** none. **Spec:** 7.2, 7.3, 8.3, 13.1 items 1–2.

**Files:** `contracts/events/telemetry_event.schema.json` (change),
`contracts/events/dead_letter.schema.json` (new),
`contracts/events/samples/telemetry_event.metric.sample.json` (new),
`contracts/events/samples/dead_letter.sample.json` (new),
`contracts/events/samples/invalid/telemetry_event.trace-without-trace-id.json` (new),
`contracts/events/samples/invalid/telemetry_event.log-without-trace-id.json` (new),
`scripts/validate-schemas.py` (change).

**RED.** Update `scripts/validate-schemas.py` so it:
1. maps each file `<base>.<variant>.sample.json` to `contracts/events/<base>.schema.json`
   (the existing single-variant mapping is unchanged for files without a variant);
2. validates every file in `contracts/events/samples/*.json` and requires success;
3. validates every file in `contracts/events/samples/invalid/*.json` against its schema
   and requires **failure**, exiting 1 if any invalid sample passes.

Add the four new sample files exactly as specified below, without changing the schema.

Metric sample (`telemetry_event.metric.sample.json`):

```json
{
  "schema_version": "1.0",
  "event_id": "3f6a1c2e-9b8d-4e7f-a0b1-c2d3e4f50617",
  "timestamp": "2026-10-03T12:00:00.000000000Z",
  "type": "metric",
  "service": "demo-payments",
  "service_version": "0.2.0-faulty",
  "environment": "local",
  "deployment_id": "d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f",
  "severity": "info",
  "attributes": { "metric.name": "http_requests_total", "metric.kind": "sum", "metric.value": 3, "route": "/payments/charge", "status_code": 500 }
}
```

Invalid trace sample (`invalid/telemetry_event.trace-without-trace-id.json`): same shape
with `"type": "trace"`, `"span_id": "00f067aa0ba902b7"`, and no `trace_id` field.
Invalid log sample: `"type": "log"` with `"severity": "error"`, no `trace_id`.
Dead-letter sample: `{"schema_version":"1.0","reason":"invalid JSON payload","source_topic":"telemetry.raw.v1","source_partition":0,"source_offset":7,"received_at":"2026-10-03T12:00:00.000000000Z","raw_payload":"{not json"}`.

Run:

```
python scripts/validate-schemas.py
```

**Expected RED:** exit 1 with `FAILED` for `telemetry_event.metric.sample.json` (the current
schema requires `trace_id` for every type), and `dead_letter.schema.json not found`
for the dead-letter sample.

**GREEN.** Change `telemetry_event.schema.json` to remove `trace_id` from top-level
`required` and add the `allOf` block from spec 7.3 verbatim. Create
`contracts/events/dead_letter.schema.json` with `schema_version` (const `"1.0"`),
`reason` (string), `source_topic` (string), `source_partition` (integer ≥ 0),
`source_offset` (integer ≥ 0), `received_at` (date-time), `raw_payload` (string). All
required; `additionalProperties: false`.

Run `python scripts/validate-schemas.py`.
**Expected:** exit 0; the five existing samples, the metric sample, and the dead-letter
sample validate; both invalid samples fail (the script prints `OK (rejected as expected)`).

**Regression:** `docker compose -f infra/docker/docker-compose.yml config --quiet` → exit 0.

**Staged files:** the eight files above (schema, dead-letter schema, four samples, two invalid samples, script).

```
git add contracts/events/telemetry_event.schema.json contracts/events/dead_letter.schema.json
git add contracts/events/samples/telemetry_event.metric.sample.json contracts/events/samples/dead_letter.sample.json
git add contracts/events/samples/invalid/telemetry_event.trace-without-trace-id.json contracts/events/samples/invalid/telemetry_event.log-without-trace-id.json
git add scripts/validate-schemas.py
git diff --cached --check
git diff --cached --stat
git commit -m "feat(contracts): require trace_id only for trace and log telemetry"
```

---

### Task 2 — Payments fault mode, configuration, and deployment resource attributes

**Depends on:** Task 1 (contract only, no code dependency). **Spec:** 6.3, 6.4.

**Files:** `services/demo-payments/src/config.ts` (new), `src/server.ts` (change),
`src/main.ts` (change), `src/instrument.ts` (change), `test/config.test.ts` (new),
`test/fault.test.ts` (new), `infra/docker/docker-compose.yml` (change: `demo-payments`
environment only), `.env.example` (change).

**RED.** Create `test/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resourceAttributes } from '../src/config.js';

test('defaults when deployment variables are absent', () => {
  const c = loadConfig({});
  assert.deepEqual(c, { faultMode: 'disabled', serviceVersion: '0.1.0', environment: 'local', deploymentId: '' });
});
test('reads all deployment variables', () => {
  const c = loadConfig({ PAYMENTS_FAULT_MODE: 'enabled', PAYMENTS_VERSION: '0.2.0-faulty', DEPLOYMENT_ENVIRONMENT: 'staging', DEPLOYMENT_ID: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f' });
  assert.equal(c.faultMode, 'enabled');
  assert.equal(c.serviceVersion, '0.2.0-faulty');
  assert.equal(c.environment, 'staging');
});
test('rejects an unknown fault mode with the exact message', () => {
  assert.throws(() => loadConfig({ PAYMENTS_FAULT_MODE: 'on' }), { message: 'PAYMENTS_FAULT_MODE must be enabled or disabled' });
});
test('omits deployment.id when DEPLOYMENT_ID is empty', () => {
  const attrs = resourceAttributes(loadConfig({ DEPLOYMENT_ID: '' }));
  assert.equal('deployment.id' in attrs, false);
  assert.equal(attrs['service.version'], '0.1.0');
  assert.equal(attrs['deployment.environment.name'], 'local');
});
test('includes deployment.id when DEPLOYMENT_ID is set', () => {
  const attrs = resourceAttributes(loadConfig({ DEPLOYMENT_ID: 'x-1' }));
  assert.equal(attrs['deployment.id'], 'x-1');
});
```

Create `test/fault.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

const VALID = { order_id: '11111111-1111-1111-1111-111111111111', amount_cents: 500 };

test('fault enabled: valid charge returns 500 with the exact body', async () => {
  const app = buildServer({ faultMode: 'enabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: VALID });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'injected_fault' });
  await app.close();
});
test('fault enabled: invalid charge still returns 500 (fault is checked before validation)', async () => {
  const app = buildServer({ faultMode: 'enabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: { amount_cents: 1 } });
  assert.equal(res.statusCode, 500);
  await app.close();
});
test('fault enabled: health stays 200', async () => {
  const app = buildServer({ faultMode: 'enabled' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  await app.close();
});
test('fault disabled: valid charge returns 200 approved', async () => {
  const app = buildServer({ faultMode: 'disabled' });
  const res = await app.inject({ method: 'POST', url: '/payments/charge', payload: VALID });
  assert.equal(res.statusCode, 200);
  await app.close();
});
```

Run `npm --prefix services/demo-payments test`.
**Expected RED:** `config.test.ts` fails with `Cannot find module '../src/config.js'`.
`fault.test.ts` loads the existing server, which has no fault branch, so the fault-enabled
cases fail with `expected 500, got 200`. The fault-disabled and health cases pass, which is
correct and must stay green.

**GREEN.**
- `src/config.ts`: implement `loadConfig` with the defaults and the exact error from
  section 7.1; `resourceAttributes` returns `service.version`, `deployment.environment.name`,
  and `deployment.id` only when non-empty.
- `src/server.ts`: `buildServer(options = { faultMode: 'disabled' })`. In the
  `POST /payments/charge` handler, first check `options.faultMode === 'enabled'`; if so,
  record `recordHttpRequest('/payments/charge', 'POST', 500, duration)`, log
  `logEvent('error', 'charge failed', { order_id, status_code: 500 })` where `order_id`
  is the body's string `order_id` or `unknown`, and reply `500 { error: 'injected_fault' }`.
  The existing validation and success paths are unchanged.
- `src/main.ts`: `const config = loadConfig(process.env)`; `buildServer({ faultMode: config.faultMode })`.
  `loadConfig` throws before the server starts, so startup fails with exit code 1.
- `src/instrument.ts`: replace the direct reads of `PAYMENTS_VERSION`/`DEPLOYMENT_ENVIRONMENT`
  with `resourceAttributes(loadConfig(process.env))`, merged into the resource with
  `resourceFromAttributes`. Existing `OTEL_SERVICE_NAME` handling is unchanged.

Run `npm --prefix services/demo-payments test`. **Expected:** all tests pass.
Run `npm --prefix services/demo-payments run typecheck` → exit 0.
Run `npm --prefix services/demo-payments run build` → exit 0.

**Compose and env** (`infra/docker/docker-compose.yml`, service `demo-payments` only):

```yaml
      PAYMENTS_VERSION: ${PAYMENTS_VERSION:-0.1.0}
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-local}
      DEPLOYMENT_ID: ${DEPLOYMENT_ID:-}
      PAYMENTS_FAULT_MODE: ${PAYMENTS_FAULT_MODE:-disabled}
```

`.env.example`: add a commented block documenting these four variables with their defaults.

Validate the Compose file: `docker compose -f infra/docker/docker-compose.yml config --quiet` → exit 0.

**Docker validation of the Payments image:** `docker compose -f infra/docker/docker-compose.yml build demo-payments`
→ exit 0. Then `docker compose -f infra/docker/docker-compose.yml up -d demo-payments`;
poll `docker inspect --format "{{.State.Health.Status}}" signalforge-demo-payments-1`
every 1 s, deadline 60 s, until `healthy`. Then
`docker compose -f infra/docker/docker-compose.yml down`. Confirm
`docker ps --filter name=signalforge` prints nothing.

**Staged files:**

```
git add services/demo-payments/src/config.ts services/demo-payments/src/server.ts services/demo-payments/src/main.ts services/demo-payments/src/instrument.ts
git add services/demo-payments/test/config.test.ts services/demo-payments/test/fault.test.ts
git add infra/docker/docker-compose.yml .env.example
git diff --cached --check
git diff --cached --stat
git commit -m "feat(demo-payments): add deterministic fault mode and deployment resource attributes"
```

---

### Task 3 — Collector Kafka export and Redpanda topic initialization

**Depends on:** Task 1 (dead-letter topic name is used by the normalizer later; topic creation only here). **Spec:** 8.1, 8.2, 12.3.

**Files:** `observability/otel-collector/config.yaml` (change), `infra/docker/docker-compose.yml` (change:
`redpanda` healthcheck, `redpanda-init`, `clickhouse` healthcheck).

**RED.** Before changing anything, start the stack's dependencies and show the topics are absent:

```
docker compose -f infra/docker/docker-compose.yml up -d redpanda
docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic list --brokers redpanda:9092
docker compose -f infra/docker/docker-compose.yml down
```

**Expected RED:** the topic list does not contain `telemetry.raw.v1`, `deployments.v1`,
`telemetry.dead-letter.v1`, or `incidents.created.v1`. (`rpk topic list` prints only
existing topics; if auto-creation is enabled it may still show none before any produce.)

**GREEN, Collector.** Replace `observability/otel-collector/config.yaml` with the existing
receivers and `debug` exporter, plus:

```yaml
processors:
  batch:
    send_batch_size: 512
    timeout: 1s

exporters:
  debug:
    verbosity: detailed
  kafka:
    brokers: ["redpanda:9092"]
    topic: telemetry.raw.v1
    encoding: otlp_json
    protocol_version: "2.0.0"
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 1000
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 5s
      max_elapsed_time: 60s

service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [debug, kafka] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [debug, kafka] }
    logs:    { receivers: [otlp], processors: [batch], exporters: [debug, kafka] }
```

Keep the existing `receivers.otlp` block (gRPC 4317, HTTP 4318) byte-for-byte.

**GREEN, Compose.** In `infra/docker/docker-compose.yml`:
- `redpanda` gains
  `healthcheck: { test: ["CMD", "rpk", "cluster", "info", "--brokers", "redpanda:9092"], interval: 2s, timeout: 5s, retries: 30 }`.
- `clickhouse` gains
  `healthcheck: { test: ["CMD", "clickhouse-client", "--query", "SELECT 1"], interval: 2s, timeout: 5s, retries: 30 }`.
- New service:

```yaml
  redpanda-init:
    image: redpandadata/redpanda:v24.2.7
    restart: "no"
    depends_on:
      redpanda:
        condition: service_healthy
    entrypoint: ["sh", "-c"]
    command:
      - 'for t in telemetry.raw.v1 deployments.v1 telemetry.dead-letter.v1 incidents.created.v1; do rpk topic describe "$t" --brokers redpanda:9092 >/dev/null 2>&1 || rpk topic create "$t" --partitions 1 --replicas 1 --brokers redpanda:9092; done'
```

**Verification (GREEN):**

```
docker compose -f infra/docker/docker-compose.yml up -d redpanda redpanda-init otel-collector
```

Poll `docker compose ... ps -a --format json` for `redpanda-init` state `exited` with exit
code 0, deadline 60 s, interval 1 s. Then:

```
docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic list --brokers redpanda:9092
```

Expected: all four topics listed. Then confirm the Collector accepted the config:
`docker compose -f infra/docker/docker-compose.yml logs otel-collector` contains
`Everything is ready. Begin running and processing data.` and no `error` line.

Delivery is verified by sending one order through the stack with
`docker compose ... up -d demo-orders demo-payments` (start both), posting one order with
`curl`, then consuming one message:

Read one record with a bounded consumer. `rpk topic consume --num` exits after the
record count is reached, but it waits indefinitely if fewer records exist, so the run is
bounded by a Node helper: `child_process.spawn` runs the command below and kills it after
30 s, and the step passes only if stdout already contains one JSON record:

```
docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic consume telemetry.raw.v1 --brokers redpanda:9092 --offset start --num 1 --format json
```

Expected: one JSON record whose `value` contains `"resourceSpans"`. The helper is
`scripts/rpk-consume-bounded.mjs`, created in this task (its only purpose is this bounded
read; Tasks 10 and 11 reuse it). Add it to the Task 3 staged files and its file-map row.

Then `docker compose -f infra/docker/docker-compose.yml down`.

**Staged files:**

```
git add observability/otel-collector/config.yaml infra/docker/docker-compose.yml scripts/rpk-consume-bounded.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(observability): export telemetry to Redpanda with batching, queueing, and retry"
```

---

### Task 4 — Go service scaffold and Docker-only workflow

**Depends on:** Task 3 (Compose file exists). **Spec:** 16.

**Files:** `services/collector-go/go.mod`, `go.sum`, `Dockerfile`, `.dockerignore`,
`internal/config/config.go`, `internal/config/config_test.go`,
`scripts/go-in-docker.mjs` (all new), `.gitignore` (change).

**RED.** Attempt the wrapper before it exists:

```
node scripts/go-in-docker.mjs go version
```

**Expected RED:** `Error: Cannot find module '...scripts/go-in-docker.mjs'` (exit 1).

**GREEN, wrapper.** `scripts/go-in-docker.mjs` (exact behavior):
- Accepts the Go command as remaining arguments.
- Computes `repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`,
  `goDir = path.join(repo, 'services', 'collector-go')`.
- Optional leading flag `--network <name>` adds `--network <name>` to the `docker run`
  arguments (used by Task 5's integration test on `signalforge_default`). Otherwise the
  default bridge network is used.
- Runs `docker` with `spawn('docker', ['run', '--rm', ...networkArgs, '-v', `${goDir}:/src`, '-w', '/src',
  '-e', 'CGO_ENABLED=0', GO_IMAGE, ...goArgs], { stdio: 'inherit', windowsHide: true })`.
  Environment variables required by a command (for example `CLICKHOUSE_HOST`) are passed
  with `-e` by the caller using the same syntax; the wrapper forwards `--env KEY=VALUE`
  flags repeatedly as `-e KEY=VALUE`. Forwarding is part of this task's wrapper tests.
- `GO_IMAGE = 'golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414'`.
- Exits with the child's exit code. No shell is used.

**Module and dependencies (run through the wrapper):**

```
node scripts/go-in-docker.mjs go mod init signalforge/collector-go
node scripts/go-in-docker.mjs go get github.com/twmb/franz-go/pkg/kgo@v1.22.1
node scripts/go-in-docker.mjs go get github.com/ClickHouse/clickhouse-go/v2@v2.48.0
node scripts/go-in-docker.mjs go mod tidy
```

`go.mod` must end up with `go 1.27` and require exactly those two modules at those
versions (plus their transitive requirements recorded by `go mod tidy`).

**GREEN, config.** `internal/config/config.go`:

```go
type Config struct {
    KafkaBrokers       []string // KAFKA_BROKERS, comma-separated, required
    ClickHouseHost     string   // CLICKHOUSE_HOST, required
    ClickHousePort     int      // CLICKHOUSE_PORT, default 9000
    ClickHouseDatabase string   // CLICKHOUSE_DB, required
    ClickHouseUser     string   // CLICKHOUSE_USER, required
    ClickHousePassword string   // CLICKHOUSE_PASSWORD, required (may be empty only if set explicitly)
}
func Load(lookup func(string) (string, bool)) (Config, error)
```

Errors (exact): `KAFKA_BROKERS is required`, `CLICKHOUSE_HOST is required`,
`CLICKHOUSE_DB is required`, `CLICKHOUSE_USER is required`,
`CLICKHOUSE_PASSWORD is required`, `CLICKHOUSE_PORT must be an integer between 1 and 65535`.

**RED → GREEN, config tests** (`config_test.go`, written first; they fail with
`undefined: Load` before `config.go` exists):

```go
func TestLoadRequiresBrokers(t *testing.T) {
    _, err := Load(env(map[string]string{"CLICKHOUSE_HOST": "h", "CLICKHOUSE_DB": "d", "CLICKHOUSE_USER": "u", "CLICKHOUSE_PASSWORD": "p"}))
    if err == nil || err.Error() != "KAFKA_BROKERS is required" { t.Fatalf("got %v", err) }
}
func TestLoadDefaultsPortAndSplitsBrokers(t *testing.T) {
    c, err := Load(env(map[string]string{"KAFKA_BROKERS": "a:9092,b:9092", "CLICKHOUSE_HOST": "h", "CLICKHOUSE_DB": "d", "CLICKHOUSE_USER": "u", "CLICKHOUSE_PASSWORD": "p"}))
    if err != nil || c.ClickHousePort != 9000 || len(c.KafkaBrokers) != 2 { t.Fatalf("%+v %v", c, err) }
}
func TestLoadRejectsBadPort(t *testing.T) {
    _, err := Load(env(map[string]string{"KAFKA_BROKERS": "a", "CLICKHOUSE_HOST": "h", "CLICKHOUSE_DB": "d", "CLICKHOUSE_USER": "u", "CLICKHOUSE_PASSWORD": "p", "CLICKHOUSE_PORT": "x"}))
    if err == nil || err.Error() != "CLICKHOUSE_PORT must be an integer between 1 and 65535" { t.Fatalf("got %v", err) }
}
```

Helper `env(m map[string]string) func(string) (string, bool)` returns the lookup.

Run `node scripts/go-in-docker.mjs go test ./internal/config/...` → **expected:** `ok`.

**Dockerfile** (`services/collector-go/Dockerfile`):

```dockerfile
FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/collector-go ./cmd/collector-go

FROM scratch
COPY --from=builder /out/collector-go /collector-go
ENTRYPOINT ["/collector-go"]
```

`.dockerignore`: `bin`, `**/*_test.go`, `*.md`.

**Verify production image** (after Task 9 adds `cmd/collector-go/main.go`; in this task
add a temporary minimal `cmd/collector-go/main.go` that is removed in Task 9? No:
Task 4 adds `cmd/collector-go/main.go` containing only `package main` and a `func main() {}`
that exits 0, so the Dockerfile builds in this task; Task 9 replaces it.)

```
docker build -t signalforge-collector-go:task4 services/collector-go
```

**Expected:** build exits 0.

`.gitignore`: append `services/collector-go/bin/`.

**Staged files:**

```
git add services/collector-go/go.mod services/collector-go/go.sum services/collector-go/Dockerfile services/collector-go/.dockerignore
git add services/collector-go/internal/config/config.go services/collector-go/internal/config/config_test.go
git add services/collector-go/cmd/collector-go/main.go scripts/go-in-docker.mjs .gitignore
git diff --cached --check
git diff --cached --stat
git commit -m "build(collector-go): add Docker-only Go workflow with pinned toolchain"
```

---

### Task 5 — ClickHouse schema, idempotent migrations, and store

**Depends on:** Task 4. **Spec:** 9.

**Files (new):** `internal/store/store.go`, `internal/store/migrate.go`,
`internal/store/migrate_test.go`, `internal/store/migrations/0001_correlation_schema.sql`,
`internal/store/clickhouse.go`, `internal/store/clickhouse_integration_test.go`.

**Migration file format.** Statements are separated by the line `-- statement-break`.
`migrate.go` embeds `migrations/*.sql` with `//go:embed`, sorts by filename, parses the
version from the leading digits, and applies every version greater than the maximum in
`schema_migrations`. After each migration's statements succeed, it inserts
`(version, name, applied_at)`.

**RED → GREEN, migration parser tests** (`migrate_test.go`):

```go
func TestSplitStatements(t *testing.T) {
    got := splitStatements("CREATE A;\n-- statement-break\nCREATE B;\n")
    if len(got) != 2 || got[0] != "CREATE A;" || got[1] != "CREATE B;" { t.Fatalf("%q", got) }
}
func TestPendingSkipsApplied(t *testing.T) {
    all := []migration{{1, "a"}, {2, "b"}, {3, "c"}}
    got := pending(all, 2)
    if len(got) != 1 || got[0].Version != 3 { t.Fatalf("%+v", got) }
}
func TestVersionFromFilename(t *testing.T) {
    v, err := versionFromFilename("0001_correlation_schema.sql")
    if err != nil || v != 1 { t.Fatalf("%d %v", v, err) }
}
```

Expected RED: `undefined: splitStatements` etc. GREEN: implement the three functions
(`versionFromFilename` returns an error for names not starting with four digits and an
underscore).

**Schema** (`0001_correlation_schema.sql`): the exact `CREATE TABLE IF NOT EXISTS`
statements from spec section 9, using `signalforge` as the database that ClickHouse
creates from `CLICKHOUSE_DB`, with these engines and keys:

- `schema_migrations`: `MergeTree`, `ORDER BY version`; columns `version UInt32`,
  `name String`, `applied_at DateTime64(3, 'UTC')`.
- `telemetry_events`: `ReplacingMergeTree(ingested_at)`, `ORDER BY event_id`,
  `PARTITION BY toYYYYMMDD(timestamp)`; columns exactly as spec 9:
  `event_id UUID`, `schema_version String`, `timestamp DateTime64(9, 'UTC')`,
  `ingested_at DateTime64(3, 'UTC')`, `type LowCardinality(String)`,
  `service LowCardinality(String)`, `service_version String`,
  `environment LowCardinality(String)`, `deployment_id String`, `trace_id String`,
  `span_id String`, `severity LowCardinality(String)`, `attributes String`.
- `deployments`: `ReplacingMergeTree(ingested_at)`, `ORDER BY deployment_id`; columns
  `deployment_id UUID`, `timestamp DateTime64(9, 'UTC')`, `service LowCardinality(String)`,
  `environment LowCardinality(String)`, `new_version String`, `previous_version String`,
  `initiated_by String`, `status LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `incidents`: `ReplacingMergeTree(detected_at)`, `ORDER BY incident_id`; columns
  `incident_id UUID`, `dedup_key String`, `environment LowCardinality(String)`,
  `service LowCardinality(String)`, `deployment_id String`, `trigger_rule String`,
  `title String`, `status LowCardinality(String)`, `severity LowCardinality(String)`,
  `started_at DateTime64(9, 'UTC')`, `detected_at DateTime64(9, 'UTC')`,
  `services Array(String)`.
- `evidence_items`: `ReplacingMergeTree(ingested_at)`, `ORDER BY evidence_id`; columns
  `evidence_id UUID`, `incident_id UUID`, `source_type LowCardinality(String)`,
  `source_ref String`, `timestamp DateTime64(9, 'UTC')`, `service LowCardinality(String)`,
  `summary String`, `reliability LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `correlation_runs`: `MergeTree`, `ORDER BY evaluated_until`; columns
  `run_id UUID`, `evaluated_until DateTime64(9, 'UTC')`, `created_at DateTime64(3, 'UTC')`.

Each table statement is `CREATE TABLE IF NOT EXISTS`, so reapplying is harmless.

**Store implementation** (`clickhouse.go`) uses `clickhouse.Open(&clickhouse.Options{Addr: []string{host:port}, Auth: {Database, Username, Password}})`
from `github.com/ClickHouse/clickhouse-go/v2` (v2.48.0). Writes use `conn.PrepareBatch`
with explicit column lists and `batch.Send()`. Reads use these exact SQL statements,
with `FINAL` on every `ReplacingMergeTree` read:

```sql
-- FailureTraces
SELECT trace_id, deployment_id, service, min(timestamp) AS ts
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments' AND span_kind = 'server'
  AND deployment_id != '' AND timestamp >= ?
  AND JSONExtractInt(attributes, 'http.response.status_code') = 500
GROUP BY trace_id, deployment_id, service
ORDER BY ts
```

`span_kind` is read as `JSONExtractString(attributes, 'span.kind')`; the statement uses
that expression, not a column. (The spec defines `span.kind` as an attribute.)

```sql
-- SucceededDeployments
SELECT deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status
FROM deployments FINAL
WHERE service = 'demo-payments' AND status = 'succeeded' AND timestamp >= ?
ORDER BY timestamp
-- IncidentsByKey
SELECT incident_id, dedup_key, environment, service, deployment_id, trigger_rule, title, status, severity, started_at, detected_at, services
FROM incidents FINAL WHERE dedup_key = ?
-- EvidenceCount
SELECT count() FROM evidence_items FINAL WHERE incident_id = ?
```

The `FailureTraces` `GROUP BY` collapses duplicate spans, so each trace contributes its
earliest span start. This is the input to the rule's "distinct trace" requirement.

**Integration test** (`clickhouse_integration_test.go`): skipped unless `CLICKHOUSE_HOST`
is set. When run on the Compose network, it calls `MigrateUp` twice and asserts the second
call applies zero versions, then inserts one `telemetry_events` row and reads it back with
`FINAL`, asserting equal nanosecond timestamps.

Run unit tests:

```
node scripts/go-in-docker.mjs go test ./internal/store/... -run 'TestSplitStatements|TestPendingSkipsApplied|TestVersionFromFilename'
```

Expected: `ok`.

The integration test needs live ClickHouse. It is run in Task 9 (the stack is up there),
using the wrapper's `--network` and `--env` flags defined in Task 4.

**Staged files:**

```
git add services/collector-go/internal/store services/collector-go/go.mod services/collector-go/go.sum scripts/go-in-docker.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): add idempotent ClickHouse schema and store"
```

---

### Task 6 — Canonical mapping, identities, and dead-letter reasons

**Depends on:** Task 4 (Go module and wrapper). The `canonical` package does not import
`store`. **Spec:** 7.4, 7.5, 8.1, 8.3, 13.1 item 3.

**Files (new):** `internal/canonical/otlp.go`, `internal/canonical/mapping.go`,
`internal/canonical/mapping_test.go`, `internal/canonical/identity.go`,
`internal/canonical/identity_test.go`, `internal/canonical/deadletter.go`,
`internal/canonical/testdata/traces.json`, `testdata/logs.json`, `testdata/metrics.json`,
`testdata/deployment.json`.

**RED.** Write `identity_test.go` first:

```go
func TestEventIDIsStableAndUUIDv5(t *testing.T) {
    a := EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331")
    b := EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331")
    if a != b { t.Fatal("not stable") }
    if len(a) != 36 || a[14] != '5' { t.Fatalf("not a v5 UUID: %s", a) }
}
func TestEventIDDiffersByKey(t *testing.T) {
    if EventID("trace|x|y") == EventID("trace|x|z") { t.Fatal("collision") }
}
```

Expected RED: `undefined: EventID`.

**GREEN, identity.go.** `EventID(key)` computes SHA-1 over `Namespace` UUID bytes
concatenated with the key bytes (RFC 4122 §4.3), sets version nibble to 5 and variant
bits to RFC 4122, formats lower-case with hyphens. `Namespace` is the constant from section
7.2. Implement with `crypto/sha1`, `encoding/hex`, and `strings` only.

**RED → GREEN, mapping tests** (`mapping_test.go`). Fixtures in `testdata/` are written
first and used by these tests. Key assertions:

```go
func TestTraceMappingCopiesIDsFromPayload(t *testing.T) {
    events, reason := MapTelemetryMessage(load(t, "traces.json"))
    if reason != "" { t.Fatal(reason) }
    got := find(events, func(e Event) bool { return e.SpanID == "b7ad6b7169203331" })
    if got.TraceID != "0af7651916cd43dd8448eb211c80319c" { t.Fatalf("trace id not copied: %q", got.TraceID) }
    if got.Type != "trace" || got.Service != "demo-payments" || got.DeploymentID != "d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f" { t.Fatalf("%+v", got) }
    if got.Timestamp.Nanosecond() != 719000123 { t.Fatalf("ns lost: %d", got.Timestamp.Nanosecond()) }
    if got.Attributes["http.response.status_code"] != float64(500) { t.Fatalf("status attr: %v", got.Attributes) }
    if got.Attributes["span.kind"] != "server" { t.Fatalf("kind: %v", got.Attributes) }
}
func TestTraceWithoutTraceIDIsRejected(t *testing.T) {
    _, reason := MapTelemetryMessage(load(t, "trace_missing_trace_id.json"))
    if reason != "trace_id and span_id are required for trace events" { t.Fatalf("got %q", reason) }
}
func TestLogWithoutTraceIDIsRejected(t *testing.T) {
    _, reason := MapTelemetryMessage(load(t, "log_missing_trace_id.json"))
    if reason != "trace_id is required for log events" { t.Fatalf("got %q", reason) }
}
func TestMetricHasNoTraceID(t *testing.T) {
    events, reason := MapTelemetryMessage(load(t, "metrics.json"))
    if reason != "" { t.Fatal(reason) }
    for _, e := range events { if e.Type == "metric" && e.TraceID != "" { t.Fatalf("fabricated trace id: %q", e.TraceID) } }
}
func TestMissingServiceNameIsRejected(t *testing.T) {
    _, reason := MapTelemetryMessage(load(t, "traces_no_service.json"))
    if reason != "service.name resource attribute is required" { t.Fatalf("got %q", reason) }
}
func TestInvalidJSONIsRejected(t *testing.T) {
    _, reason := MapTelemetryMessage([]byte("{not json"))
    if reason != "invalid JSON payload" { t.Fatalf("got %q", reason) }
}
func TestExactlyOneTopLevelKey(t *testing.T) {
    _, reason := MapTelemetryMessage([]byte(`{}`))
    if reason != "payload must contain exactly one of resourceSpans, resourceLogs, resourceMetrics" { t.Fatalf("got %q", reason) }
}
func TestDeploymentMappingAndStatus(t *testing.T) {
    d, reason := MapDeploymentMessage(load(t, "deployment.json"))
    if reason != "" || d.DeploymentID != "d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f" { t.Fatalf("%+v %q", d, reason) }
    _, reason = MapDeploymentMessage([]byte(`{"schema_version":"1.0","deployment_id":"x","timestamp":"2026-10-03T12:00:00Z","service":"demo-payments","new_version":"v","status":"failed"}`))
    if reason != "deployment event status must be succeeded" { t.Fatalf("got %q", reason) }
}
```

**Canonical timestamp rule (exact):** `timestamp` = `time.Unix(0, n).UTC()` where `n` is
`startTimeUnixNano` for spans, `timeUnixNano` for log records (or
`observedTimeUnixNano` when zero), and `timeUnixNano` for metric data points. OTLP JSON
encodes these 64-bit integers as strings; parse with `strconv.ParseInt`.

**Attribute value rule:** `stringValue` → string; `intValue` (string in OTLP JSON) →
`float64` JSON number (parsed as int64 then converted); `boolValue` → bool; `doubleValue` →
float64; other value types → invalid is not required, they are stored as their JSON text.

**Trace identity:** `EventID("trace|" + traceID + "|" + spanID)`. **Log identity:**
`EventID("log|" + traceID + "|" + spanID + "|" + ns + "|" + sha256hex(body))`. **Metric
identity:** `EventID("metric|" + service + "|" + name + "|" + sortedKV + "|" + ns)` with
`sortedKV` = sorted `key=value` pairs joined by `,` using the stringified attribute value.
**Deployment identity:** `EventID("deployment|" + deploymentID)`.

**Span kind mapping:** OTLP `kind` integer 2 → `server`, 3 → `client`; any other value →
`unspecified`. `status.code`: 0 → `unset`, 1 → `ok`, 2 → `error`.

**Staged files:**

```
git add services/collector-go/internal/canonical
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): map OTLP JSON to canonical events with UUIDv5 identities"
```

---

### Task 7 — Normalizer: batch processing, dead letters, and at-least-once commits

**Depends on:** Tasks 5, 6. **Spec:** 7.6, 8.3.

**Files (new):** `internal/ingest/backoff.go`, `internal/ingest/backoff_test.go`,
`internal/ingest/normalizer.go`, `internal/ingest/normalizer_test.go`,
`internal/ingest/kafka.go`.

**RED → GREEN, backoff** (`backoff_test.go`): `Backoff{Initial: time.Second, Cap: 16*time.Second, GiveUp: 2*time.Minute}`.

```go
func TestBackoffSequence(t *testing.T) {
    b := NewBackoff()
    want := []time.Duration{1, 2, 4, 8, 16, 16} // seconds
    for i, w := range want {
        got, ok := b.Next()
        if !ok || got != w*time.Second { t.Fatalf("step %d: %v %v", i, got, ok) }
    }
}
func TestBackoffGivesUpAfterTwoMinutes(t *testing.T) {
    b := NewBackoff()
    var total time.Duration
    for { d, ok := b.Next(); if !ok { break }; total += d }
    if total < 2*time.Minute || total > 2*time.Minute+16*time.Second { t.Fatalf("total %v", total) }
}
```

Expected RED: `undefined: NewBackoff`. GREEN: `Next()` returns the current delay and
doubles it up to the cap, and returns `ok=false` once the cumulative delay reaches
2 minutes (the last delay is truncated so the total is exactly 2 minutes).

**RED → GREEN, normalizer** (`normalizer_test.go`) with in-memory fakes implementing
`Consumer`, `Producer`, and a `store.Store` fake that records calls:

```go
func TestValidBatchIsWrittenThenCommitted(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow}
    if err := n.ProcessBatch(ctx, []Record{validTraceRecord(7)}); err != nil { t.Fatal(err) }
    if f.store.eventsWritten != 1 || f.consumer.committedOffsets[0] != 7 { t.Fatalf("%+v %+v", f.store, f.consumer) }
    if len(f.producer.sent) != 0 { t.Fatal("valid record must not be dead-lettered") }
}
func TestInvalidRecordGoesToDeadLetterWithExactReason(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow}
    _ = n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(9)})
    if len(f.producer.sent) != 1 || f.producer.sent[0].topic != "telemetry.dead-letter.v1" { t.Fatalf("%+v", f.producer.sent) }
    dl := decodeDeadLetter(t, f.producer.sent[0].value)
    if dl.Reason != "trace_id and span_id are required for trace events" || dl.SourceOffset != 9 { t.Fatalf("%+v", dl) }
    if f.store.eventsWritten != 0 { t.Fatal("invalid record must not be stored") }
    if f.consumer.committedOffsets[0] != 9 { t.Fatal("dead-lettered offset must be committed") }
}
func TestWriteFailureDoesNotCommit(t *testing.T) {
    f := newFakes()
    f.store.failWrites = 1000 // always fail
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: instantBackoff(3)}
    err := n.ProcessBatch(ctx, []Record{validTraceRecord(11)})
    if err == nil { t.Fatal("expected failure after give-up") }
    if len(f.consumer.committedOffsets) != 0 { t.Fatal("offset committed despite failed write") }
}
func TestDeadLetterProduceFailureDoesNotCommit(t *testing.T) {
    f := newFakes()
    f.producer.fail = true
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: instantBackoff(1)}
    if err := n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(12)}); err == nil { t.Fatal("expected error") }
    if len(f.consumer.committedOffsets) != 0 { t.Fatal("offset committed without dead letter") }
}
func TestDeploymentRecordIsStored(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow}
    _ = n.ProcessBatch(ctx, []Record{deploymentRecord(13)})
    if f.store.deploymentsWritten != 1 { t.Fatal("deployment not written") }
}
```

`instantBackoff(k)` is a `Backoff` whose delays are zero and which gives up after `k`
attempts. Expected RED: `undefined: Normalizer`. GREEN: implement `ProcessBatch`:
1. For each record, select `Topic`: `telemetry.raw.v1` → `MapTelemetryMessage`; `deployments.v1` →
   `MapDeploymentMessage` then append to a deployments slice; any other topic → dead letter with
   reason `unexpected source topic <topic>`.
2. Collect all valid events and deployments across the batch.
3. Write events with `Store.InsertEvents` and deployments with `Store.InsertDeployments`
   under the backoff (section 8.3). Failure after give-up returns the error.
4. Produce every dead letter to `telemetry.dead-letter.v1` with key = `strconv.FormatInt(offset, 10)`,
   under the same backoff. Failure after give-up returns the error.
5. Commit all offsets in the batch with `Consumer.Commit` only after steps 3 and 4 succeed.

**Kafka adapters** (`kafka.go`, no unit test; exercised by Task 9's acceptance):
- `NewConsumer(brokers []string, topics []string, group string) (*kgo.Client, error)` with
  `kgo.ConsumeTopics`, `kgo.ConsumerGroup(group)`, `kgo.DisableAutoCommit()`,
  `kgo.FetchMaxWait(time.Second)`.
- `Poll` uses `client.PollFetches(ctx)` and converts records to `Record`, returning an
  error for any fetch error.
- `Commit` builds `map[string]map[int32]kgo.EpochOffset` for the highest offset + 1 per
  partition and calls `client.CommitOffsetsSync`.
- `Producer` wraps a second `kgo.Client` with `kgo.DefaultProduceTopic` unset and calls
  `ProduceSync` with a `kgo.Record{Topic, Key, Value}`.

Import path: `github.com/twmb/franz-go/pkg/kgo` at v1.22.1 (Task 4).

**Staged files:**

```
git add services/collector-go/internal/ingest
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): normalize telemetry with dead letters and at-least-once commits"
```

---

### Task 8 — Correlator: detection, deduplication, incidents, evidence, and publication

**Depends on:** Tasks 5, 6, 7 (uses the same `store.Store` and `canonical` types). **Spec:** 10, 11, 12.

**Files (new):** `internal/correlate/rule.go`, `rule_test.go`, `dedup.go`, `dedup_test.go`,
`correlator.go`, `correlator_test.go`.

**RED → GREEN, detection** (`rule_test.go`, written first; fixtures are built in the test
with helper `fail(traceID string, at time.Time)`):

```go
var dep = canonical.Deployment{DeploymentID: "D1", Timestamp: t0.Add(-1*time.Minute), Service: "demo-payments", Environment: "local", Status: "succeeded"}

func TestThreeFailuresWithin30sCreateCandidate(t *testing.T) {
    f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(10*time.Second)), fail("c", t0.Add(29*time.Second))}
    c := DetectBurst(f, []canonical.Deployment{dep})
    if len(c) != 1 || !c[0].StartedAt.Equal(t0) { t.Fatalf("%+v", c) }
}
func TestThirtyOneSecondsDoesNotTrigger(t *testing.T) {
    f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(10*time.Second)), fail("c", t0.Add(31*time.Second))}
    if c := DetectBurst(f, []canonical.Deployment{dep}); len(c) != 0 { t.Fatalf("%+v", c) }
}
func TestDuplicateTraceDoesNotCount(t *testing.T) {
    f := []store.FailureRow{fail("a", t0), fail("a", t0.Add(time.Second)), fail("b", t0.Add(2*time.Second))}
    if c := DetectBurst(f, []canonical.Deployment{dep}); len(c) != 0 { t.Fatal("same trace counted twice") }
}
func TestDeploymentOlderThanFiveMinutesIsNotLinked(t *testing.T) {
    old := dep; old.Timestamp = t0.Add(-5*time.Minute - time.Second)
    f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(time.Second)), fail("c", t0.Add(2*time.Second))}
    if c := DetectBurst(f, []canonical.Deployment{old}); len(c) != 0 { t.Fatal("linked to old deployment") }
}
func TestDeploymentAfterFirstFailureIsNotLinked(t *testing.T) {
    late := dep; late.Timestamp = t0.Add(time.Second)
    f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(time.Second)), fail("c", t0.Add(2*time.Second))}
    if c := DetectBurst(f, []canonical.Deployment{late}); len(c) != 0 { t.Fatal("failure preceded deployment") }
}
func TestFailureRowsFromAnotherDeploymentAreIgnored(t *testing.T) {
    f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(time.Second)), {TraceID: "c", DeploymentID: "OTHER", Timestamp: t0.Add(2 * time.Second), Service: "demo-payments"}}
    if c := DetectBurst(f, []canonical.Deployment{dep}); len(c) != 0 { t.Fatal("mixed deployments") }
}
```

`DetectBurst` (exact procedure, spec 10.1): for each deployment with `Status == "succeeded"`
and `Service == "demo-payments"`, filter failures to that `DeploymentID`, sort by time,
collapse duplicate `TraceID` (keep earliest), find the smallest `i` where three entries
exist with `F[i+2].Timestamp - F[i].Timestamp <= 30s`, then require
`dep.Timestamp <= F[i].Timestamp` and `F[i].Timestamp - dep.Timestamp <= 5 min`. Output
one `Candidate` per matching deployment.

**RED → GREEN, dedup and identities** (`dedup_test.go`):

```go
func TestDedupKeyFormat(t *testing.T) {
    got := DedupKey("local", "demo-payments", "D1", "payments-5xx-burst-after-deployment")
    want := "local|demo-payments|D1|payments-5xx-burst-after-deployment"
    if got != want { t.Fatal(got) }
}
func TestSuppressesWithinFiveMinutesBeforeCandidate(t *testing.T) {
    existing := store.IncidentRow{StartedAt: t0}
    if !Suppressed([]store.IncidentRow{existing}, t0.Add(4*time.Minute)) { t.Fatal("not suppressed") }
}
func TestNotSuppressedAfterFiveMinutes(t *testing.T) {
    existing := store.IncidentRow{StartedAt: t0}
    if Suppressed([]store.IncidentRow{existing}, t0.Add(5*time.Minute+time.Second)) { t.Fatal("suppressed") }
}
func TestIncidentIDIsStable(t *testing.T) {
    a := IncidentID("local|demo-payments|D1|r", t0)
    b := IncidentID("local|demo-payments|D1|r", t0)
    if a != b { t.Fatal("unstable") }
}
```

`Suppressed(existing, candidateStart)` returns true when any existing row has
`StartedAt` in `[candidateStart - 5m, candidateStart)`. `IncidentID(key, start)` =
`canonical.EventID(key + "|" + strconv.FormatInt(start.UnixNano(), 10))`.
`EvidenceID(incidentID, sourceRef)` = `canonical.EventID(incidentID + "|" + sourceRef)`.

**RED → GREEN, correlator** (`correlator_test.go`) with a fake store and fake producer:

```go
func TestCycleCreatesOneIncidentWithFourEvidenceRows(t *testing.T) {
    s := newFakeStore(failuresFor(t0), []canonical.Deployment{dep})
    p := &fakeProducer{}
    c := &Correlator{Store: s, Producer: p, Now: func() time.Time { return t0.Add(time.Minute) }}
    if err := c.RunCycle(ctx, c.Now()); err != nil { t.Fatal(err) }
    if len(s.incidents) != 1 { t.Fatalf("incidents: %d", len(s.incidents)) }
    inc := s.incidents[0]
    if inc.Severity != "high" || inc.Status != "open" || inc.TriggerRule != TriggerRule || inc.Services[0] != "demo-payments" { t.Fatalf("%+v", inc) }
    if !inc.StartedAt.Equal(t0) { t.Fatal("started_at mismatch") }
    if len(s.evidence) != 4 { t.Fatalf("evidence: %d", len(s.evidence)) }
    if len(p.sent) != 1 || p.sent[0].topic != "incidents.created.v1" { t.Fatalf("%+v", p.sent) }
}
func TestSecondCycleIsIdempotent(t *testing.T) {
    s := newFakeStore(failuresFor(t0), []canonical.Deployment{dep})
    p := &fakeProducer{}
    c := &Correlator{Store: s, Producer: p, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now()); _ = c.RunCycle(ctx, c.Now())
    if len(s.incidents) != 1 || len(s.evidence) != 4 || len(p.sent) != 1 { t.Fatal("not idempotent") }
}
func TestRepairsMissingEvidenceForExistingIncident(t *testing.T) {
    s := newFakeStore(failuresFor(t0), []canonical.Deployment{dep})
    p := &fakeProducer{}
    c := &Correlator{Store: s, Producer: p, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now())
    s.evidence = s.evidence[:1] // simulate a failed evidence insert
    _ = c.RunCycle(ctx, c.Now())
    if len(s.evidence) != 4 { t.Fatalf("not repaired: %d", len(s.evidence)) }
    if len(p.sent) != 1 { t.Fatal("republished on repair") }
}
func TestPublishFailureKeepsIncidentAndDoesNotRetry(t *testing.T) {
    s := newFakeStore(failuresFor(t0), []canonical.Deployment{dep})
    p := &fakeProducer{fail: true}
    c := &Correlator{Store: s, Producer: p, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now())
    if len(s.incidents) != 1 || len(s.evidence) != 4 { t.Fatal("incident must persist") }
}
func TestReadFailureReturnsErrorWithoutWriting(t *testing.T) {
    s := newFakeStore(nil, nil)
    s.failRead = true
    c := &Correlator{Store: s, Producer: &fakeProducer{}, Now: fixed(t0)}
    if err := c.RunCycle(ctx, c.Now()); err == nil { t.Fatal("expected error") }
    if len(s.incidents) != 0 { t.Fatal("wrote after read failure") }
}
func TestCorrelationRunIsRecorded(t *testing.T) {
    s := newFakeStore(failuresFor(t0), []canonical.Deployment{dep})
    c := &Correlator{Store: s, Producer: &fakeProducer{}, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now())
    if len(s.runs) != 1 || s.runs[0].EvaluatedUntil.Before(t0) { t.Fatalf("%+v", s.runs) }
}
```

`RunCycle(ctx, now)` procedure (exact, spec 10.2 and 12):
1. `since := now.Add(-LookbackWindow)`. Read `FailureTraces(since)` and
   `SucceededDeployments(since)`. A read error returns immediately (no writes).
2. `candidates := DetectBurst(failures, deployments)`.
3. For each candidate: `key := DedupKey(...)`, `id := IncidentID(key, candidate.StartedAt)`.
   Read `IncidentsByKey(key)`.
   - If an existing row has `IncidentID == id`: count evidence; if fewer than 4,
     `InsertEvidence` the missing rows (all four are re-derived and inserted;
     `ReplacingMergeTree` keeps one row per `evidence_id`). Do not publish. Continue.
   - Else if `Suppressed(existing, candidate.StartedAt)`: skip.
   - Else build the incident row (`DetectedAt: now`), the four evidence rows, and call
     `InsertIncidentWithEvidence`. On success, publish the incident payload (spec 8.5)
     to `incidents.created.v1` with key = incident ID. A publish error is logged
     with the incident ID and not retried.
4. Insert one `CorrelationRun{RunID: UUIDv5(Namespace, "run|"+now nanos), EvaluatedUntil: max(failure timestamps, now-if-none), CreatedAt: now}`.

`EvaluatedUntil` rule, exact: the maximum `Timestamp` among the failures read in the
cycle, or `now` when there are none. The acceptance script's dedup check uses it.

`RunCycle` returns the first store error encountered after step 1; publish errors do not
return an error.

**Staged files:**

```
git add services/collector-go/internal/correlate
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): correlate payments 5xx bursts into deduplicated incidents"
```

---

### Task 9 — Process wiring, Compose service, and Docker validation

**Depends on:** Tasks 3, 4, 5, 7, 8. **Spec:** 6.1, 13.2 precondition, 16, 18.

**Files:** `services/collector-go/cmd/collector-go/main.go` (change: replaces the Task 4
stub), `services/collector-go/README.md` (change), `infra/docker/docker-compose.yml`
(change: `collector-go` real service).

**RED.** Before wiring, start the stack and confirm the Go service is still the placeholder:

```
docker compose -f infra/docker/docker-compose.yml up -d collector-go
docker compose -f infra/docker/docker-compose.yml logs collector-go
```

**Expected RED:** the log is empty and the container runs `sleep infinity`; no
normalizer or correlator log lines appear within 30 s of start. Then
`docker compose ... down`.

**GREEN, main.go.** Sequence:
1. `cfg, err := config.Load(os.LookupEnv)`; on error print the message and exit 1.
2. Open the ClickHouse store; `MigrateUp(ctx)`; on error exit 1.
3. Create the Kafka consumer (topics `telemetry.raw.v1`, `deployments.v1`, group
   `collector-go-normalizer`) and the producer.
4. Start the normalizer loop: `for { recs, err := consumer.Poll(ctx); ...; n.ProcessBatch }`.
   A `ProcessBatch` error exits the process with status 1 (section 8.3).
5. Start the correlator loop: a 1 s `time.Ticker`, calling `RunCycle(ctx, time.Now().UTC())`;
   cycle errors are logged and do not exit.
6. Shut down on SIGINT or SIGTERM: cancel the context and return.

Logging is `log/slog` JSON to stdout. Log lines use the fixed event names
`migrations applied`, `batch processed`, `dead letter produced`, `incident created`,
`incident suppressed`, `incident evidence repaired`, `publish failed`, `cycle failed`.

**Compose** (`infra/docker/docker-compose.yml`): replace the placeholder `collector-go`:

```yaml
  collector-go:
    build: ../../services/collector-go
    environment:
      KAFKA_BROKERS: redpanda:9092
      CLICKHOUSE_HOST: clickhouse
      CLICKHOUSE_PORT: "9000"
      CLICKHOUSE_DB: signalforge
      CLICKHOUSE_USER: default
      CLICKHOUSE_PASSWORD: changeme-local-only
    depends_on:
      redpanda-init:
        condition: service_completed_successfully
      clickhouse:
        condition: service_healthy
    restart: "no"
```

`restart: "no"` matches the process exit behavior in section 8.3: a fatal ClickHouse
failure stops the service and does not hide the failure.

**Verification commands (GREEN):**

```
node scripts/go-in-docker.mjs go vet ./...
node scripts/go-in-docker.mjs go test ./...
docker compose -f infra/docker/docker-compose.yml up -d --build collector-go
```

Poll `docker compose ... ps --format json` for `collector-go` state `running`, deadline
60 s, interval 1 s. Then read logs:

```
docker compose -f infra/docker/docker-compose.yml logs collector-go
```

Expected: a line with `migrations applied` and `"applied":1` (first start), and no
`error` level lines. Restart test: `docker compose ... restart collector-go`, then the
logs show `migrations applied` with `"applied":0`.

Run the ClickHouse integration test (Task 5) through the wrapper with the network flag
and the connection variables, with the stack from Task 9 running:
`node scripts/go-in-docker.mjs --network signalforge_default --env CLICKHOUSE_HOST=clickhouse --env CLICKHOUSE_PORT=9000 --env CLICKHOUSE_DB=signalforge --env CLICKHOUSE_USER=default --env CLICKHOUSE_PASSWORD=changeme-local-only go test ./internal/store/... -run Integration`
→ expected `ok`.

Validate the Compose file: `docker compose -f infra/docker/docker-compose.yml config --quiet` → exit 0.

Then `docker compose -f infra/docker/docker-compose.yml down`.

**Staged files:**

```
git add services/collector-go/cmd/collector-go/main.go services/collector-go/README.md infra/docker/docker-compose.yml scripts/go-in-docker.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): run normalizer and correlator in Compose"
```

---

### Task 10 — Deployment mechanism script

**Depends on:** Tasks 2, 3, 9. **Spec:** 17, 8.4.

**Files (new):** `scripts/deploy-payments.mjs`, `scripts/deploy-payments.test.mjs`.

**RED.** Create `scripts/deploy-payments.test.mjs` first, using `node:test`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildDeploymentEvent, buildComposeEnv } from './deploy-payments.mjs';

test('requires --version', () => {
  assert.throws(() => parseArgs(['--fault', 'enabled']), /--version is required/);
});
test('rejects an unknown fault value', () => {
  assert.throws(() => parseArgs(['--version', 'x', '--fault', 'on']), /--fault must be enabled or disabled/);
});
test('defaults environment and fault', () => {
  assert.deepEqual(parseArgs(['--version', '0.2.0']), { version: '0.2.0', environment: 'local', fault: 'disabled' });
});
test('builds the deployment event exactly per spec 8.4', () => {
  const ev = buildDeploymentEvent({ deploymentId: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f', timestamp: '2026-10-03T12:00:00.000000000Z', version: '0.2.0-faulty', environment: 'local' });
  assert.deepEqual(ev, { schema_version: '1.0', deployment_id: 'd3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f', timestamp: '2026-10-03T12:00:00.000000000Z', service: 'demo-payments', environment: 'local', new_version: '0.2.0-faulty', initiated_by: 'deploy-payments-script', status: 'succeeded' });
});
test('compose env carries the four deployment variables and keeps parent env', () => {
  const env = buildComposeEnv({ PATH: '/bin' }, { version: '0.2.0', environment: 'local', deploymentId: 'D', fault: 'enabled' });
  assert.deepEqual(env, { PATH: '/bin', PAYMENTS_VERSION: '0.2.0', DEPLOYMENT_ENVIRONMENT: 'local', DEPLOYMENT_ID: 'D', PAYMENTS_FAULT_MODE: 'enabled' });
});
```

Run `node --test scripts/deploy-payments.test.mjs`. **Expected RED:** `Cannot find module './deploy-payments.mjs'`.

**GREEN.** Implement the exports with exactly the behaviors asserted. `parseArgs` throws
`--version is required` when absent, `--fault must be enabled or disabled`, and
`--environment must not be empty` when given an empty string. The default timestamp is
`new Date().toISOString()` with nanoseconds replaced by `.000000000Z` only if the Date
has none; the event builder takes the timestamp as an argument, so tests stay exact.

The script's `main()`, executed when `import.meta.url` equals the process argv entry,
performs the steps in spec 17 in this order, each with `child_process.spawn` and an argument
array:

1. `deploymentId = randomDeploymentId()`.
2. Spawn `docker compose -f infra/docker/docker-compose.yml up -d --force-recreate --no-deps demo-payments`
   with `env: buildComposeEnv(process.env, ...)`. Exit code ≠ 0 → exit 1 with message
   `step compose-recreate failed`.
3. Poll `docker inspect --format {{.State.Health.Status}} signalforge-demo-payments-1`
   every 1 s, deadline 60 s, until `healthy`. Timeout → exit 1 with `step health timed out`.
4. Spawn `docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic produce deployments.v1 --key <deploymentId> --brokers redpanda:9092`
   and write `JSON.stringify(buildDeploymentEvent(...))` to its stdin, then close stdin.
   Non-zero exit → exit 1 with `step publish failed` and the `deployment_id` printed.
5. Print `deployment_id=<deploymentId>` on its own line and exit 0.

Note on the `--brokers` flag: `rpk topic produce` accepts `--brokers` (global rpk flag,
used the same way in Task 3); if the implementation discovers that the flag must be
placed differently, that change is recorded in the commit message and the test remains
unchanged.

**Verification:**

```
node --test scripts/deploy-payments.test.mjs
```

Expected: all tests pass. Then a live deploy with the stack up (Task 9):
`node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled` → exit 0, prints a
`deployment_id`. Confirm with
`docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic consume deployments.v1 --brokers redpanda:9092 --offset start --num 1 --format json`
→ one record whose value contains that deployment ID.

**Staged files:**

```
git add scripts/deploy-payments.mjs scripts/deploy-payments.test.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(scripts): add deployment script that publishes succeeded payments deployments"
```

---

### Task 11 — Acceptance script

**Depends on:** Tasks 1–10. **Spec:** 13.2, 13.3, 13.4.

**Files (new):** `scripts/verify-faulty-deployment-incident.mjs`.

**RED.** Run the script with the stack down:

```
node scripts/verify-faulty-deployment-incident.mjs
```

**Expected RED:** exit 1 and the message `precondition failed: service collector-go is not running`
(the precondition check runs first and names the failing service).

**GREEN: script structure** (all waits via `pollUntil(check, { intervalMs, timeoutMs, what })`
with a named error `Timed out after <ms>ms waiting for: <what>`):

Helpers:
- `compose(args, { env, input })` — `child_process.spawn('docker', ['compose', '-f', COMPOSE, ...args])`;
  resolves `{stdout, stderr, code}`; rejects only on spawn error.
- `clickhouse(sql)` — posts the SQL to ClickHouse's HTTP interface through
  `docker compose exec -T clickhouse clickhouse-client --query <sql> --format JSONEachRow`,
  returning parsed rows. Named queries are the only SQL used.
- `consume(topic, { num, offset })` — `rpk topic consume <topic> --brokers redpanda:9092 --offset <offset> --num <num> --format json`
  with a 5 s kill timer (the bounded read in Task 3); returns parsed JSON records.
- `eventIdV5(key)` — the section 7.5 UUIDv5 rule using `crypto` (SHA-1), identical to the Go
  implementation (checked by an assertion against a fixture value from Task 6's
  `identity_test.go` expected value).

Steps (exact):

0. **Precondition.** `docker inspect` the containers `signalforge-collector-go-1`,
   `signalforge-demo-orders-1`, `signalforge-demo-payments-1`, `signalforge-clickhouse-1`,
   `signalforge-redpanda-1`, `signalforge-otel-collector-1` must be `running`. Otherwise exit 1
   with `precondition failed: service <name> is not running`.
1. **Deploy faulty.** `node scripts/deploy-payments.mjs --version 0.2.0-faulty --fault enabled`
   via spawn; parse `deployment_id=<id>` from stdout. Non-zero → fail.
2. **Deployment visible.** Poll (500 ms, 30 s):
   `SELECT deployment_id, status FROM deployments FINAL WHERE deployment_id = '<id>'` returns one row with `status = 'succeeded'`.
3. **Three faulty orders.** For i in 1..3: fresh `randomUUID()` order id;
   `POST http://localhost:8081/orders` with `item: "widget"`, `amount_cents: 500`. Assert
   each response status is 502 and body equals `{order_id, status:'failed', reason:'payment_unavailable'}`.
4. **Failure traces visible.** Poll (500 ms, 30 s):
   `SELECT trace_id, min(timestamp) FROM telemetry_events FINAL WHERE deployment_id = '<id>' AND type='trace' AND service='demo-payments' AND JSONExtractInt(attributes,'http.response.status_code') = 500 GROUP BY trace_id`
   returns at least three distinct `trace_id` values. The script takes the three earliest
   of these and asserts that the third's timestamp is within 30 s of the first. The three
   orders in step 3 are sent back to back, so they form the burst. Telemetry does not carry
   the order ID, so trigger identity is established by deployment and time window, which is
   the rule in spec 10.1.
5. **Incident.** Poll (500 ms, 60 s) for
   `SELECT incident_id, dedup_key, severity, status, started_at, detected_at, services FROM incidents FINAL WHERE dedup_key = '<env>|demo-payments|<id>|payments-5xx-burst-after-deployment'`
   returning exactly one row. Assert `severity === 'high'`, `status === 'open'`,
   `services` equals `["demo-payments"]`, `started_at` equals (to the nanosecond string)
   the minimum failure timestamp from step 4, and `detected_at >= started_at`.
6. **Evidence.** `SELECT source_type, source_ref FROM evidence_items FINAL WHERE incident_id = '<incident_id>'`
   returns exactly four rows: one `deployment` with `source_ref` = deployment ID, and three
   `trace` rows whose `source_ref` set equals the three trigger trace IDs from step 4.
7. **Incident message.** `consume('incidents.created.v1', { num: 50, offset: 'start' })`
   contains a record whose `incident_id` equals the step-5 incident ID.
8. **Dedup.** Send three more faulty orders (fresh UUIDs, same expectations as step 3).
   Poll (500 ms, 60 s) until
   `SELECT max(evaluated_until) FROM correlation_runs` is at least the newest failure
   timestamp from the new traces. Then assert:
   - `IncidentsByKey` for the same dedup key returns exactly one row;
   - the evidence count for that incident is still exactly 4;
   - the new traces are **not** referenced by any evidence row.
9. **Dead letter.** Publish one malformed trace message to `telemetry.raw.v1` with
   `rpk topic produce telemetry.raw.v1 --brokers redpanda:9092` and stdin
   `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"demo-payments"}}]},"scopeSpans":[{"spans":[{"name":"POST","kind":2,"startTimeUnixNano":"1790000000000000000"}]}]}]}`
   (no `traceId`). Poll (500 ms, 30 s) for `consume('telemetry.dead-letter.v1', ...)` to contain
   a record with `reason === "trace_id and span_id are required for trace events"`.
   Then send one valid order and poll (500 ms, 30 s) until its trace appears in
   `telemetry_events`, proving the pipeline continued.
10. **Idempotency.** Build one valid trace message with fixed IDs (`traceId` =
    `0af7651916cd43dd8448eb211c80319c`, `spanId` = `b7ad6b7169203331`, `service.name` =
    `demo-orders`, start time = current nanoseconds as a string) and compute its `event_id`
    with `eventIdV5('trace|0af...|b7ad...')`. Publish it twice, then publish a valid sentinel
    message with its own fixed IDs (`traceId` = `1111...` 32 hex, `spanId` = `2222...` 16 hex).
    Poll (500 ms, 30 s) until the sentinel's `event_id` appears in `telemetry_events`.
    Then assert `SELECT count() FROM telemetry_events FINAL WHERE event_id = '<fixed>'` = 1.
11. **Restore (finally).** Regardless of earlier outcome, run
    `node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled`. Its exit status is
    reported; a failure here makes the overall run fail even if all assertions passed.

**Output.** On success, print the incident row, the four evidence rows, the incident ID,
and `PASS` with the deployment ID. On failure, print `FAIL <step>: <message>` and the
recent `collector-go` logs (`docker compose logs --no-color --no-log-prefix --tail 200 collector-go`).

**Exit status:** 0 only if steps 0–10 pass and step 11 succeeds.

**Verification (GREEN):** start the stack for the scenario:

```
docker compose -f infra/docker/docker-compose.yml up -d --build redpanda redpanda-init clickhouse otel-collector collector-go demo-orders demo-payments
```

Poll container health for `signalforge-demo-payments-1` and `signalforge-demo-orders-1`
(deadline 60 s), then:

```
node scripts/verify-faulty-deployment-incident.mjs
```

Expected: exit 0, `PASS`. Run it a **second time** with the stack still up:

```
node scripts/verify-faulty-deployment-incident.mjs
```

Expected: exit 0, `PASS`, with a different deployment ID and a second, distinct incident row.
The two runs together prove the fresh-ID repeatability in spec 13.4.

**Staged files:**

```
git add scripts/verify-faulty-deployment-incident.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "test: add faulty-deployment incident acceptance script"
```

---

### Task 12 — ADR, README, and final clean-stack validation

**Depends on:** Task 11. **Spec:** 20 (self-review), all of section 13.

**Files:** `docs/decisions/0004-faulty-deployment-correlation.md` (new), `README.md` (change).

**ADR content (exact sections):** Status: Accepted. Context: the spec's pipeline. Decision:
the pinned values in section 3 of this plan (Go 1.27.1, the builder digest, franz-go v1.22.1,
clickhouse-go v2.48.0, `protocol_version` 2.0.0, batch/queue/retry values), the choice to
read ClickHouse rather than a normalized topic, SDK-side enrichment, single process,
best-effort incident publication, and the `trigger_rule` and window constants. Consequences:
the limitations in spec section 14 and the publication limitation in section 8.4 of this plan.

**README changes:** a new section "Faulty deployment incident correlation" with: the one
command to run the acceptance script; the prerequisites (Docker only; no host Go); the
commands `node scripts/go-in-docker.mjs go test ./...` and
`node scripts/deploy-payments.mjs --version <v> --fault enabled`; the topic list; the limits
from the spec. The "Status" line is updated to name this slice. The Quick start and
Observability sections from the completed slice remain accurate and are not rewritten.

**Final validation (every command, in order; stop at the first failure and report it):**

1. `python scripts/validate-schemas.py` → exit 0.
2. `node --test scripts/deploy-payments.test.mjs` → all pass.
3. `npm --prefix services/demo-orders test` and `npm --prefix services/demo-orders run typecheck` → pass.
4. `npm --prefix services/demo-payments test` and `npm --prefix services/demo-payments run typecheck` → pass.
5. `node scripts/go-in-docker.mjs go vet ./...` and `node scripts/go-in-docker.mjs go test ./...` in `services/collector-go` → pass.
6. `docker compose -f infra/docker/docker-compose.yml config --quiet` → exit 0.
7. `docker compose -f infra/docker/docker-compose.yml build --no-cache collector-go demo-payments demo-orders` → exit 0 (clean-image build).
8. Start the stack (command of Task 11), wait for health, run
   `node scripts/verify-faulty-deployment-incident.mjs` twice → both exit 0.
9. `docker compose -f infra/docker/docker-compose.yml down` → exit 0.
10. Confirm `docker ps --filter name=signalforge` and `docker network ls --filter name=signalforge`
    print nothing.
11. `git status --porcelain=v1` → empty.

**Staged files:**

```
git add docs/decisions/0004-faulty-deployment-correlation.md README.md
git diff --cached --check
git diff --cached --stat
git commit -m "docs: document faulty-deployment incident correlation and record decisions"
```

## 10. Spec coverage map

| Spec section | Requirement | Task(s) | Owning test |
|---|---|---|---|
| 6.1 | Component responsibilities | 2, 3, 9, 10 | Compose validation in each task |
| 6.2 | Per-run deployment ID | 10, 11 | Deploy test (`randomDeploymentId`), acceptance step 1 |
| 6.3 | Fault mode before validation, health 200, invalid mode exits | 2 | `fault.test.ts`, `config.test.ts` |
| 6.4 | Resource attributes and env defaults | 2 | `config.test.ts` (`resourceAttributes`) |
| 7.2 | Trace-ID rule, no fabrication | 1, 6 | `mapping_test.go` (copy, metric, missing) |
| 7.3 | Conditional `trace_id` schema | 1 | `validate-schemas.py` valid and invalid samples |
| 7.4 | Canonical mapping | 6 | `mapping_test.go` fixtures |
| 7.5 | UUIDv5 identity | 6 | `identity_test.go` |
| 7.6 | At-least-once, dead letters, backoff | 7 | `normalizer_test.go`, `backoff_test.go`; acceptance step 9 |
| 8.1 | Collector Kafka exporter, `otlp_json`, batch/queue/retry | 3 | Collector startup log; delivery consume |
| 8.2 | Topics incl. dead-letter | 3 | `rpk topic list` |
| 8.3 | Dead-letter payload | 1, 7 | Schema sample; `normalizer_test.go` |
| 8.4 | Deployment payload | 10 | Deploy test (`buildDeploymentEvent`) |
| 8.5 | Incident payload | 8 | `correlator_test.go` (publish); acceptance step 7 |
| 9 | ClickHouse schema, migrations, FINAL | 5 | `migrate_test.go`; integration test; acceptance reads |
| 10.1 | Detection rule | 8 | `rule_test.go` (every rejection branch) |
| 10.2 | Polling correlator cycle | 8, 9 | `correlator_test.go`; acceptance step 8 |
| 11 | Dedup key, window, stable ID | 8 | `dedup_test.go`; acceptance step 8 |
| 12.1 | Incident fields | 8 | `correlator_test.go` (fields) |
| 12.2 | Four evidence rows, repair | 8 | `correlator_test.go` (repair); acceptance step 6 |
| 12.3 | Topic init and Compose dependencies | 3, 9 | Task 3 init check; Task 9 precondition |
| 13.1 | Contract and unit checks | 1, 2, 6, 7, 8 | Each task's tests |
| 13.2 | Scenario steps 1–10 | 11 | Acceptance script |
| 13.3 | Polling deadlines | 11 | Named timeouts in script |
| 13.4 | Two consecutive runs, teardown | 11, 12 | Task 11 verification; Task 12 step 8–10 |
| 16 | Docker-only Go workflow, pinned builder | 4 | Wrapper runs; image build |
| 17 | Deployment mechanism | 10 | Deploy test and live deploy |
| 18 | Error handling | 7, 8, 9, 10, 11 | Owning tests listed in their tasks |

## 11. Self-review

- **Spec coverage:** every row of spec sections 6–18 maps to a task and a test in section 10.
- **Missing test ownership:** each behavior has an owning test; the acceptance script owns
  only end-to-end behavior, not unit behavior.
- **Placeholder language:** no TODO, TBD, or deferred choices remain. The Go builder digest
  and every package version are recorded from sources (section 3). Two items are verified
  by execution in their tasks rather than assumed: the `protocol_version` value (Task 3
  delivery proof) and the rpk `--brokers` placement (Task 10 note). Both name the exact
  reopening rule.
- **Contradictory interfaces:** `buildServer` changes once (Task 2) and every caller is
  updated in that task. The Go `Store` interface is defined once (section 7.2) and used
  unchanged by Tasks 7 and 8. `EventID` is used identically by Tasks 6, 8, and 11.
- **Scope creep check:** no task adds a dashboard, agent, approval, replay, retention,
  second scenario, or a Collector processor for enrichment. The only additions beyond the
  spec are the dead-letter schema file (required by spec 8.3) and the `correlation_runs`
  table (required by spec 13.2 step 8).
- **Design corrections needed before implementation (reported to the user):**
  1. Incident publication is best-effort after commit (section 8.4). The spec implies at-least-once
     publication; a durable outbox would be needed to meet that. This is a design decision for review.
  2. The Payments fault branch logs `order_id` from the body before validation, so a
     malformed body logs `unknown`. Acceptable, but it is a behavior the spec does not state.
  3. The acceptance step 4 identifies triggers by time window, not by per-order trace
     mapping. The spec requires linkage by deployment and time, which this matches; a stricter
     per-order mapping would require propagating the order ID to telemetry, which is out of scope.
