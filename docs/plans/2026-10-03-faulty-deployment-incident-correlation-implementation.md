# Faulty-deployment incident correlation — implementation plan

Status: **Proposed for review.** Execution must not begin until this status line reads
"Approved for execution" with an approval date.

Source specification: [2026-10-03-faulty-deployment-incident-correlation.md](../specs/2026-10-03-faulty-deployment-incident-correlation.md)
(approved design; every behavioral requirement below traces to a section of that spec).

Branch: `feature/faulty-deployment-correlation` (worktree
`.claude/worktrees/feature+faulty-deployment-correlation`, based on `master` at `046887a`).

## 1. Goal

Make one deliberately faulty `demo-payments` deployment produce exactly one persisted,
deduplicated, high-severity incident in ClickHouse, with `started_at` from the first failing
request, the deployment event and three triggering traces as evidence, and an
`incidents.created.v1` publication under an at-least-once publisher. Prove it with a bounded
acceptance script that passes twice with fresh IDs, covers failed-publication and
crash-restart recovery without duplicate incident or evidence rows, and restores healthy
Payments in a `finally` block.

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
                                 │ incidents (revision 1, pending), evidence_items,
                                 │ correlation_runs
                                                 ▼
                              collector-go publisher (Go, 1 s cycle)
                                 │ produce incidents.created.v1 (key incident_id)
                                 │ then insert incident revision (published)
                                                 ▼
                              ClickHouse incidents (latest revision = state)
```

One Go process, `collector-go`, runs the normalizer, correlator, and publisher loops. The
Compose service `collector-go` replaces its placeholder.

## 3. Technology stack (exact, verified 2026-10-03)

| Item | Exact choice | Source of verification |
|---|---|---|
| Go toolchain | `go1.27.1` | `https://go.dev/VERSION?m=text` |
| Builder image | `golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414` (index digest) | Docker Hub `library/golang` tag `1.27-alpine` record, `digest` field |
| Runtime image | `scratch` (static binary, no shell, no base image) | Design choice; no pinned base needed |
| Kafka client | `github.com/twmb/franz-go` `v1.22.1` (package `pkg/kgo`) | `proxy.golang.org` `@latest`, 2026-09-27 |
| ClickHouse client | `github.com/ClickHouse/clickhouse-go/v2` `v2.48.0` (native protocol, port 9000) | `proxy.golang.org` `@latest` (module path escaped as `!click!house`), 2026-08-04 |
| Collector image | `otel/opentelemetry-collector-contrib:0.108.0` (unchanged) | Existing Compose |
| Kafka exporter | `kafka` exporter, `encoding: otlp_json`, `protocol_version: 2.0.0` | Contrib v0.108.0 exporter README: `protocol_version` is required and `otlp_json` is valid for all signals. The value `2.0.0` is an explicit compatibility choice, not a documented requirement; Task 3 verifies it by live delivery. |
| Batch processor | `batch` with `send_batch_size: 512`, `timeout: 1s` | Collector v0.108.0 batch processor README (documented defaults: `send_batch_size` 8192, `timeout` 200ms) |
| Exporter queue | `sending_queue` `enabled: true`, `num_consumers: 10`, `queue_size: 1000` (documented defaults, stated explicitly) | Collector v0.108.0 exporterhelper README |
| Exporter retry | `retry_on_failure` `enabled: true`, `initial_interval: 1s`, `max_interval: 5s`, `max_elapsed_time: 60s` | Collector v0.108.0 exporterhelper README |
| Kafka CLI | `rpk` in the Redpanda image (`redpandadata/redpanda:v24.2.7`, unchanged) | rpk source: `topic produce -k/--key` reads stdin; `topic consume -n/--num`, `-o/--offset`, `-f/--format` |
| Node | Existing Node 24 and built-ins only (`child_process`, `crypto`, `fs`, `url`, `path`). No new npm dependency. | Existing `package.json` files |
| Redpanda health | `rpk cluster info --brokers redpanda:9092` | rpk command reference |
| ClickHouse health | `clickhouse-client --query "SELECT 1"` | ClickHouse image |

Protocol choice: `protocol_version: 2.0.0` is chosen explicitly for compatibility with
Redpanda v24.2.7. The exporter README requires the setting but does not document this
value as correct for Redpanda, so the value is not presented as documented. Task 3 proves
delivery with a live consumed record from `telemetry.raw.v1`. If that check fails, Task 3 is
reopened, the value is changed, the change is re-verified, and ADR 0004 records the change.

## 4. Global constraints

- Product code is added only by the tasks below. Each task lists its exact file set.
- No task installs anything on the host. Go runs only in Docker (Task 4). Node uses only the
  built-in modules listed in section 3.
- Containers are started only by Tasks 3, 7, 9, 10, 11, and 12, and each of those tasks states
  its startup and teardown commands.
- Every Compose or Collector change is validated by starting the affected service and reading
  its logs. No `validate` subcommand is assumed.
- Every wait in every script is bounded and uses a named timeout error. No `sleep` is used
  except inside the bounded polling helper.
- Scripts are cross-platform: `child_process.spawn` with argument arrays, no shell strings, no
  `&&`, no inline `VAR=value`, no `grep`, no `/tmp`.
- Every task ends with its own commit. Staged files are listed explicitly.
- No retry logic is added to `demo-orders` or `demo-payments`.
- Canonical records are never fabricated: trace and log records carry the IDs they were
  emitted with; metric records have no `trace_id`.
- ClickHouse reads that affect correctness use `FINAL`.
- Incident publication is at-least-once. Exactly one persisted incident row per incident ID is
  the invariant. The healthy path produces one Kafka message; a retry or crash may produce a
  second message with the same key, which consumers deduplicate.

## 5. Review focus: five failure modes to check in every task

1. **Fabricated or mismatched trace IDs.** A trace or log record that gains an ID from anywhere
   but its own payload would cite the wrong request as evidence. Checked in Tasks 6 and 8 by
   fixtures that assert IDs are copied, and in Task 12 by the order-to-trace set equality.
2. **Duplicate delivery counted twice.** At-least-once delivery, retried publication, and
   unmerged `ReplacingMergeTree` parts can double-count without `FINAL`. Checked in Tasks 5, 6,
   and 8 by fake-store semantics tests, and in Task 12 by the republish test and by the
   no-duplicate-row assertions of Scenarios B and C.
3. **Timestamp precision drift.** Nanosecond `started_at` values that round in transit break the
   exact-equality assertion. Checked in Tasks 5, 6, and 12 with nanosecond fixtures and
   `DateTime64(9, 'UTC')` columns.
4. **Faulty version or test hooks left active.** A failed acceptance run that does not restore
   Payments, or does not restore default `collector-go` hooks, poisons the next run. Checked in
   Tasks 10 and 12 by `finally` restores and by a test that the restore runs after an injected
   failure.
5. **Lost, partial, or duplicated incident state.** An incident without its evidence, a publish
   before evidence exists, a lost publication after a crash, or a duplicated row after a retry
   each breaks a guarantee. Checked in Task 8 by repair, publish-failure, mark-failure, and
   crash-restart tests, and in Task 12 by Scenarios B and C.

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
| `services/demo-payments/src/config.ts` | new | 2 | Reads and validates `PAYMENTS_FAULT_MODE`; resource attributes. |
| `services/demo-payments/src/server.ts` | change | 2 | Fault branch before validation; `buildServer(options)`. |
| `services/demo-payments/src/main.ts` | change | 2 | Passes loaded config to `buildServer`. |
| `services/demo-payments/src/instrument.ts` | change | 2 | Applies resource attributes from config. |
| `services/demo-payments/test/config.test.ts` | new | 2 | Config and resource attribute tests. |
| `services/demo-payments/test/fault.test.ts` | new | 2 | Fault mode behavior tests. |
| `infra/docker/docker-compose.yml` | change | 2, 3, 9 | `demo-payments` environment (2); Redpanda and ClickHouse healthchecks and `redpanda-init` (3); `collector-go` real service with test-hook defaults (9). |
| `.env.example` | change | 2, 9 | Documents deployment variables (2) and test hooks (9). |
| `observability/otel-collector/config.yaml` | change | 3 | Batch, queue, retry, kafka exporter. |
| `scripts/rpk-consume-bounded.mjs` | new | 3 | Runs `rpk topic consume` under a 5-second kill timer (bounded reads for Tasks 3, 11, 12). |
| `services/collector-go/go.mod`, `go.sum` | new | 4 | Module definition with pinned dependencies. |
| `services/collector-go/Dockerfile` | new | 4 | Multi-stage build: pinned Go builder, `scratch` runtime. |
| `services/collector-go/.dockerignore` | new | 4 | Excludes `bin/`, `*.md`, and tests from the build context. |
| `services/collector-go/cmd/collector-go/main.go` | new (stub in 4), change (9) | 4, 9 | Process entry: config, migrations, three loops. |
| `services/collector-go/internal/config/config.go`, `config_test.go` | new | 4, 9 | Environment loading with exact errors, including test hooks (9). |
| `services/collector-go/internal/store/store.go` | new | 5 | `Store` interface and row types (section 7.2). |
| `services/collector-go/internal/store/migrate.go`, `migrate_test.go` | new | 5 | Idempotent migration runner. |
| `services/collector-go/internal/store/migrations/0001_correlation_schema.sql` | new | 5 | ClickHouse tables (revisioned `incidents`). |
| `services/collector-go/internal/store/clickhouse.go` | new | 5 | `Store` implementation over clickhouse-go. |
| `services/collector-go/internal/store/fake_test.go` | new | 5 | `ReplacingMergeTree`-semantics fake shared by correlator and publisher tests. |
| `services/collector-go/internal/store/clickhouse_integration_test.go` | new | 5 | Integration test, skipped unless `CLICKHOUSE_HOST` is set. |
| `services/collector-go/internal/canonical/otlp.go` | new | 6 | OTLP JSON structs. |
| `services/collector-go/internal/canonical/mapping.go`, `mapping_test.go` | new | 6 | Canonical mapping, validation, log attribute preservation. |
| `services/collector-go/internal/canonical/identity.go`, `identity_test.go` | new | 6 | UUIDv5 identity. |
| `services/collector-go/internal/canonical/deadletter.go` | new | 6 | Reason strings and dead-letter payload. |
| `services/collector-go/internal/canonical/testdata/*.json` | new | 6 | Fixtures for mapping. |
| `services/collector-go/internal/ingest/backoff.go`, `backoff_test.go` | new | 7 | Retry schedule. |
| `services/collector-go/internal/ingest/normalizer.go`, `normalizer_test.go` | new | 7 | Batch processing, commits, dead letters. |
| `services/collector-go/internal/ingest/kafka.go` | new | 7 | franz-go consumer and producer adapters. |
| `services/collector-go/internal/correlate/rule.go`, `rule_test.go` | new | 8 | Detection rule (spec 10.1). |
| `services/collector-go/internal/correlate/dedup.go`, `dedup_test.go` | new | 8 | Dedup and identities (spec 11). |
| `services/collector-go/internal/correlate/correlator.go`, `correlator_test.go` | new | 8 | Cycle, incident creation (pending), evidence repair (spec 10.2, 12.1, 12.2). |
| `services/collector-go/internal/publish/publisher.go`, `publisher_test.go` | new | 8 | Durable publisher (spec 12.4): produce, state write, test hooks. |
| `services/collector-go/README.md` | change | 9 | Replaces placeholder text; documents test hooks. |
| `services/collector-go/bin/` | ignored | 4 | Built binaries; excluded by `.gitignore`. |
| `.gitignore` | change | 4 | Adds `services/collector-go/bin/`. |
| `scripts/go-in-docker.mjs` | new | 4 | Runs Go commands in the pinned builder image (`--network`, `--env` flags). |
| `scripts/deploy-payments.mjs`, `scripts/deploy-payments.test.mjs` | new | 10 | Deployment mechanism (spec 17). |
| `scripts/verify-faulty-deployment-incident.mjs` | new | 11 | Acceptance scenarios A, B, C and restore (spec 13.2). |
| `docs/decisions/0004-faulty-deployment-correlation.md` | new | 12 | ADR recording pinned choices. |
| `README.md` | change | 12 | Documents the slice, commands, test hooks, and limits. |

## 7. Shared interfaces (single definition; all tasks use these names)

### 7.1 Node

```js
// scripts/deploy-payments.mjs
export function parseArgs(argv) // -> { version, environment, fault }  throws Error on invalid input
export function buildDeploymentEvent({ deploymentId, timestamp, version, environment }) // -> object per spec 8.4
export function buildComposeEnv(parentEnv, { version, environment, deploymentId, fault }) // -> env object
export function randomDeploymentId() // -> crypto.randomUUID()

// scripts/rpk-consume-bounded.mjs
export function buildConsumeArgs({ topic, num, offset }) // -> exact docker compose argument array (Task 3)
export function parseRecords(text) // -> object[] from complete JSON lines; drops a trailing partial line
export function consumeBounded({ topic, num, offset, timeoutMs = 5000 }) // -> Promise<object[]>
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
export function buildServer(options?: { faultMode: FaultMode }): FastifyInstance; // default { faultMode: 'disabled' }
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
    Attributes     map[string]any // JSON-encodable scalars; log attributes preserved (spec 7.4)
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
    SchemaVersion   string    // "1.0"
    Reason          string    // exact text from section 8.1
    SourceTopic     string
    SourcePartition int32
    SourceOffset    int64
    ReceivedAt      time.Time
    RawPayload      string
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
    IncidentsByKey(ctx context.Context, dedupKey string) ([]IncidentRow, error)   // latest revision per incident_id
    InsertIncidentWithEvidence(ctx context.Context, inc IncidentRow, ev []EvidenceRow) error // inc.Revision == 1, state pending
    InsertEvidence(ctx context.Context, ev []EvidenceRow) error                  // idempotent by evidence_id
    EvidenceCount(ctx context.Context, incidentID string) (int, error)
    PendingIncidents(ctx context.Context) ([]IncidentRow, error)                 // latest revision with publication_state = pending
    MarkIncidentPublished(ctx context.Context, inc IncidentRow, publishedAt time.Time) error // inserts revision inc.Revision+1, state published
    InsertCorrelationRun(ctx context.Context, run CorrelationRun) error
    LatestEvaluatedUntil(ctx context.Context) (time.Time, error)
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
    Revision                                                                     uint64
    PublicationState                                                             string    // "pending" | "published"
    PublishedAt                                                                  time.Time // zero time (1970-01-01 UTC) while pending
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
type Normalizer struct { /* Consumer, Producer, Store, Now, Backoff */ }
func (n *Normalizer) ProcessBatch(ctx context.Context, records []Record) error
```

```go
// internal/correlate
type Correlator struct { /* Store, Now, Log */ }   // no Producer: the correlator never publishes
func (c *Correlator) RunCycle(ctx context.Context, now time.Time) error
// Pure detection
func DetectBurst(failures []store.FailureRow, deployments []canonical.Deployment) []Candidate
type Candidate struct {
    Deployment canonical.Deployment
    Triggers   [3]store.FailureRow // chronological, distinct traces
    StartedAt  time.Time            // == Triggers[0].Timestamp
}
func DedupKey(environment, service, deploymentID, triggerRule string) string
func Suppressed(existing []store.IncidentRow, candidateStart time.Time) bool
func IncidentID(dedupKey string, startedAt time.Time) string   // canonical.EventID(key + "|" + nanos)
func EvidenceID(incidentID, sourceRef string) string           // canonical.EventID(incidentID + "|" + sourceRef)
```

```go
// internal/publish
type Publisher struct {
    Store                 store.Store
    Producer              ingest.Producer
    Now                   func() time.Time
    Exit                  func(code int)  // os.Exit in production; recorded in tests
    FailProduceAttempts   int             // test hook: first N produce attempts fail
    CrashAfterProduce     bool            // test hook: exit(1) after a successful produce, before the state write
    Log                   *slog.Logger
}
// RunCycle publishes every pending incident with four evidence rows. It returns only store
// read errors; produce and state-write errors are logged and retried on the next cycle.
func (p *Publisher) RunCycle(ctx context.Context) error
// IncidentPayload builds the section 8.5 JSON object for an incident.
func IncidentPayload(inc store.IncidentRow) ([]byte, error)
const Topic = "incidents.created.v1"
```

Constants (fixed, not environment-configurable, except the two test hooks):

| Name | Value |
|---|---|
| `BurstCount` | 3 |
| `BurstWindow` | 30 s |
| `DeploymentWindow` | 5 min |
| `DedupWindow` | 5 min |
| `LookbackWindow` | 10 min (wall clock) |
| `CorrelatorInterval` | 1 s |
| `PublisherInterval` | 1 s |
| `BackoffInitial` / `BackoffCap` | 1 s / 16 s |
| `BackoffGiveUp` | 2 min |
| `TriggerRule` | `payments-5xx-burst-after-deployment` |
| `Namespace` | `8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d` |
| `ZeroTime` | `1970-01-01T00:00:00Z` (`publication_state` `pending` value of `published_at`) |

Test hooks, read by `internal/config` (Task 9):

| Variable | Default | Exact error on invalid value |
|---|---|---|
| `INCIDENT_PUBLISH_FAIL_ATTEMPTS` | `0` | `INCIDENT_PUBLISH_FAIL_ATTEMPTS must be a non-negative integer` |
| `INCIDENT_CRASH_AFTER_PRODUCE` | `0` | `INCIDENT_CRASH_AFTER_PRODUCE must be 0 or 1` |

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
| Message topic is neither `telemetry.raw.v1` nor `deployments.v1` | `unexpected source topic <topic>` |

Fixture tests assert these exact strings. The acceptance script asserts
`trace_id and span_id are required for trace events` for its malformed record.

### 8.2 Retry and give-up

- Attempt delays: 1 s, 2 s, 4 s, 8 s, 16 s, 16 s, … until 2 minutes of cumulative delay has
  elapsed. Then the operation returns its last error, and the normalizer's `ProcessBatch` error
  exits the process with status 1.
- Normalizer offsets are never committed for a batch whose ClickHouse write or dead-letter
  produce failed.

### 8.3 Correlator outcomes (correlator only; it never publishes)

| Condition | Outcome |
|---|---|
| Candidate's `incident_id` already exists | Repair missing evidence only: insert the four evidence rows (idempotent). No incident insert. |
| Dedup window suppresses candidate | Nothing written for the candidate. |
| Otherwise | Insert the incident row (revision 1, `publication_state = pending`), then the four evidence rows. |
| Evidence insert fails after the incident insert | Next cycle repairs it (row above). The publisher does not see the incident until four evidence rows exist. |
| ClickHouse read fails | Cycle returns the error; the loop logs it and continues on the next tick. Nothing is written. |
| Every cycle | Inserts one `correlation_runs` row with `EvaluatedUntil` = the maximum failure timestamp read, or `now` if none. |

### 8.4 Publisher outcomes (spec 12.4)

| Condition | Outcome |
|---|---|
| Pending incident with fewer than four evidence rows | Skipped. Not produced. Re-examined next cycle. |
| Pending incident with four evidence rows, produce succeeds, state write succeeds | One message produced with key `incident_id`; one revision inserted with `published`. Healthy path. |
| Produce fails | Logged `publish failed` with incident ID and attempt number; state stays `pending`; retried next cycle with no cap. |
| Produce succeeds, state write fails | Logged `publish state write failed`; state stays `pending`; produced again next cycle (allowed duplicate), then the state is written. |
| `CrashAfterProduce` is set and a produce succeeds | `Exit(1)` is called before the state write. On restart the same incident is produced again and then marked published. |
| `FailProduceAttempts` = N | The first N produce calls in the process lifetime return an error without producing. |
| Store read fails | `RunCycle` returns the error. Nothing is produced. |

## 9. Tasks

Twelve tasks, executed in order. Each lists dependencies, RED→GREEN steps, exact commands,
staged files, and its commit message. The spec coverage map is in section 10.

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
   (files without a variant keep the existing mapping);
2. validates every file in `contracts/events/samples/*.json` and requires success;
3. validates every file in `contracts/events/samples/invalid/*.json` against its schema and
   requires **failure**, exiting 1 if any invalid sample passes.

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

Invalid trace sample (`invalid/telemetry_event.trace-without-trace-id.json`): same shape with
`"type": "trace"`, `"span_id": "00f067aa0ba902b7"`, and no `trace_id`. Invalid log sample:
`"type": "log"` with `"severity": "error"` and no `trace_id`. Dead-letter sample:
`{"schema_version":"1.0","reason":"invalid JSON payload","source_topic":"telemetry.raw.v1","source_partition":0,"source_offset":7,"received_at":"2026-10-03T12:00:00.000000000Z","raw_payload":"{not json"}`.

```
python scripts/validate-schemas.py
```

**Expected RED:** exit 1 with `FAILED` for `telemetry_event.metric.sample.json` (the current
schema requires `trace_id` for every type), and `dead_letter.schema.json not found` for the
dead-letter sample.

**GREEN.** Change `telemetry_event.schema.json`: remove `trace_id` from top-level `required`
and add the `allOf` block of spec 7.3 verbatim. Create `contracts/events/dead_letter.schema.json`
with `schema_version` (const `"1.0"`), `reason` (string), `source_topic` (string),
`source_partition` (integer ≥ 0), `source_offset` (integer ≥ 0), `received_at` (date-time),
`raw_payload` (string); all required; `additionalProperties: false`.

```
python scripts/validate-schemas.py
```

**Expected:** exit 0; the existing samples, the metric sample, and the dead-letter sample
validate; both invalid samples are rejected (`OK (rejected as expected)`).

**Regression:** `docker compose -f infra/docker/docker-compose.yml config --quiet` → exit 0.

**Staged files:**

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
  assert.equal(resourceAttributes(loadConfig({ DEPLOYMENT_ID: 'x-1' }))['deployment.id'], 'x-1');
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
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  await app.close();
});
test('fault disabled: valid charge returns 200 approved', async () => {
  const app = buildServer({ faultMode: 'disabled' });
  assert.equal((await app.inject({ method: 'POST', url: '/payments/charge', payload: VALID })).statusCode, 200);
  await app.close();
});
```

```
npm --prefix services/demo-payments test
```

**Expected RED:** `config.test.ts` fails with `Cannot find module '../src/config.js'`.
`fault.test.ts` loads the existing server, which has no fault branch, so the fault-enabled
cases fail with `expected 500, got 200`. The fault-disabled and health cases pass and must stay
green.

**GREEN.**
- `src/config.ts`: `loadConfig` with the defaults and the exact error from section 7.1;
  `resourceAttributes` returns `service.version`, `deployment.environment.name`, and
  `deployment.id` only when non-empty.
- `src/server.ts`: `buildServer(options = { faultMode: 'disabled' })`. In the
  `POST /payments/charge` handler, first check `options.faultMode === 'enabled'`. If so:
  `recordHttpRequest('/payments/charge', 'POST', 500, durationSeconds)`;
  `logEvent('error', 'charge failed', { order_id, status_code: 500 })` where `order_id` is the
  body's string `order_id` or `unknown`; reply `500 { error: 'injected_fault' }`. The existing
  validation and success paths are unchanged.
- `src/main.ts`: `const config = loadConfig(process.env)`, then `buildServer({ faultMode: config.faultMode })`.
  `loadConfig` throws before the server starts, so startup fails with exit code 1.
- `src/instrument.ts`: replace the direct reads of `PAYMENTS_VERSION` and `DEPLOYMENT_ENVIRONMENT`
  with `resourceAttributes(loadConfig(process.env))`, merged into the resource with
  `resourceFromAttributes`. Existing `OTEL_SERVICE_NAME` handling is unchanged.

```
npm --prefix services/demo-payments test
npm --prefix services/demo-payments run typecheck
npm --prefix services/demo-payments run build
```

**Expected:** all tests pass; typecheck and build exit 0.

**Compose and env** (`infra/docker/docker-compose.yml`, service `demo-payments` only):

```yaml
      PAYMENTS_VERSION: ${PAYMENTS_VERSION:-0.1.0}
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-local}
      DEPLOYMENT_ID: ${DEPLOYMENT_ID:-}
      PAYMENTS_FAULT_MODE: ${PAYMENTS_FAULT_MODE:-disabled}
```

`.env.example`: a commented block documenting these four variables with their defaults.

```
docker compose -f infra/docker/docker-compose.yml config --quiet
docker compose -f infra/docker/docker-compose.yml build demo-payments
docker compose -f infra/docker/docker-compose.yml up -d demo-payments
```

Poll `docker inspect --format {{.State.Health.Status}} signalforge-demo-payments-1` every
1 s, deadline 60 s, until `healthy`. Then:

```
docker compose -f infra/docker/docker-compose.yml down
docker ps --filter name=signalforge
```

The `ps` command prints nothing.

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

**Depends on:** Task 1. **Spec:** 8.1, 8.2, 12.3.

**Files:** `observability/otel-collector/config.yaml` (change),
`infra/docker/docker-compose.yml` (change: `redpanda` healthcheck, `redpanda-init`, `clickhouse`
healthcheck), `scripts/rpk-consume-bounded.mjs` (new).

**RED.** Start the broker and show the topics are absent:

```
docker compose -f infra/docker/docker-compose.yml up -d redpanda
docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic list --brokers redpanda:9092
docker compose -f infra/docker/docker-compose.yml down
```

**Expected RED:** the list does not contain `telemetry.raw.v1`, `deployments.v1`,
`telemetry.dead-letter.v1`, or `incidents.created.v1`.

**Bounded reader** (`scripts/rpk-consume-bounded.mjs`), exported `consumeBounded`:
spawns `docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic consume <topic> --brokers redpanda:9092 --offset <offset> --num <num> --format json`
with `child_process.spawn` and an argument array. It collects stdout and kills the process
after `timeoutMs` (default 5000 ms). It returns the records parsed from stdout, one JSON
document per record (rpk's `--format json` with `--pretty-print=false` prints one document per
line; the implementation passes `--pretty-print=false`). Records parsed before a kill are
returned; a partial trailing line is discarded.

Its test, `scripts/rpk-consume-bounded.test.mjs`, covers the two pure functions only, so it needs
no Docker and no broker. `buildConsumeArgs({ topic, num, offset })` must return exactly
`['compose', '-f', 'infra/docker/docker-compose.yml', 'exec', '-T', 'redpanda', 'rpk', 'topic', 'consume', topic, '--brokers', 'redpanda:9092', '--offset', offset, '--num', String(num), '--format', 'json', '--pretty-print=false']`.
`parseRecords(text)` must return the parsed objects for two complete JSON lines and drop a trailing
partial line. RED: `Cannot find module './rpk-consume-bounded.mjs'`. GREEN: implement both functions
and the spawn wrapper around them.

**GREEN, Collector.** Replace `observability/otel-collector/config.yaml` with the existing
`receivers.otlp` block byte-for-byte, the `debug` exporter (verbosity `detailed`), plus:

```yaml
processors:
  batch:
    send_batch_size: 512
    timeout: 1s

exporters:
  kafka:
    brokers: ["redpanda:9092"]
    topic: telemetry.raw.v1
    encoding: otlp_json
    protocol_version: 2.0.0
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
node --test scripts/rpk-consume-bounded.test.mjs
docker compose -f infra/docker/docker-compose.yml up -d redpanda redpanda-init otel-collector demo-orders demo-payments
```

Poll `docker compose -f infra/docker/docker-compose.yml ps -a --format json` until
`redpanda-init` has state `exited` with exit code 0 (deadline 60 s, interval 1 s). Then:

```
docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic list --brokers redpanda:9092
docker compose -f infra/docker/docker-compose.yml logs otel-collector
```

Expected: all four topics listed; the Collector log contains `Everything is ready. Begin running and processing data.` and no `error` line.

Delivery proof: post one order with `curl -X POST http://localhost:8081/orders -H "Content-Type: application/json" -d '{"order_id":"11111111-2222-4333-8444-555555555555","item":"widget","amount_cents":500}'`,
then call `consumeBounded({ topic: 'telemetry.raw.v1', num: 1, offset: 'start' })`.
**Expected:** at least one record whose text contains `resourceSpans`. If none is returned, the
step fails, the protocol value is reopened (section 3), and this task is not complete.

```
docker compose -f infra/docker/docker-compose.yml down
```

**Staged files:**

```
git add observability/otel-collector/config.yaml infra/docker/docker-compose.yml scripts/rpk-consume-bounded.mjs scripts/rpk-consume-bounded.test.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(observability): export telemetry to Redpanda with batching, queueing, and retry"
```

---

### Task 4 — Go service scaffold and Docker-only workflow

**Depends on:** Task 3. **Spec:** 16.

**Files:** `services/collector-go/go.mod`, `go.sum`, `Dockerfile`, `.dockerignore`,
`cmd/collector-go/main.go` (stub), `internal/config/config.go`, `internal/config/config_test.go`
(config fields for the core connection only; the test hooks are added in Task 9),
`scripts/go-in-docker.mjs` (all new), `.gitignore` (change).

**RED.**

```
node scripts/go-in-docker.mjs go version
```

**Expected RED:** `Error: Cannot find module '...scripts/go-in-docker.mjs'` (exit 1).

**GREEN, wrapper.** `scripts/go-in-docker.mjs` (exact behavior):
- Optional leading flags, repeatable: `--network <name>` adds `--network <name>` to `docker run`;
  `--env KEY=VALUE` adds `-e KEY=VALUE`. Flags precede the Go command.
- `repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`;
  `goDir = path.join(repo, 'services', 'collector-go')`.
- Runs `spawn('docker', ['run', '--rm', ...networkArgs, ...envArgs, '-v', `${goDir}:/src`, '-w', '/src', '-e', 'CGO_ENABLED=0', GO_IMAGE, ...goArgs], { stdio: 'inherit', windowsHide: true })`.
- `GO_IMAGE = 'golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414'`.
- Exits with the child's exit code. No shell is used.
- Argument parsing is exported as `parseWrapperArgs(argv)` → `{ networkArgs, envArgs, goArgs }`
  for testing. Test `scripts/go-in-docker.test.mjs` asserts that `--env A=1 --network n go test ./...`
  yields `networkArgs = ['--network','n']`, `envArgs = ['-e','A=1']`, `goArgs = ['go','test','./...']`,
  and that an unknown leading flag throws. RED: `Cannot find module`. GREEN: implement.

**Module and dependencies (run through the wrapper):**

```
node scripts/go-in-docker.mjs go mod init signalforge/collector-go
node scripts/go-in-docker.mjs go get github.com/twmb/franz-go/pkg/kgo@v1.22.1
node scripts/go-in-docker.mjs go get github.com/ClickHouse/clickhouse-go/v2@v2.48.0
node scripts/go-in-docker.mjs go mod tidy
```

`go.mod` must declare `go 1.27`, require both modules at the listed versions, and carry the
transitive requirements recorded by `go mod tidy`.

**GREEN, core config.** `internal/config/config.go`:

```go
type Config struct {
    KafkaBrokers       []string // KAFKA_BROKERS, comma-separated, required
    ClickHouseHost     string   // CLICKHOUSE_HOST, required
    ClickHousePort     int      // CLICKHOUSE_PORT, default 9000
    ClickHouseDatabase string   // CLICKHOUSE_DB, required
    ClickHouseUser     string   // CLICKHOUSE_USER, required
    ClickHousePassword string   // CLICKHOUSE_PASSWORD, required
}
func Load(lookup func(string) (string, bool)) (Config, error)
```

Errors (exact): `KAFKA_BROKERS is required`, `CLICKHOUSE_HOST is required`,
`CLICKHOUSE_DB is required`, `CLICKHOUSE_USER is required`, `CLICKHOUSE_PASSWORD is required`,
`CLICKHOUSE_PORT must be an integer between 1 and 65535`.

Tests written first (`internal/config/config_test.go`); they fail with `undefined: Load` until
`config.go` exists:

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

`env(m)` is a test helper returning `func(string) (string, bool)`.

```
node scripts/go-in-docker.mjs go test ./internal/config/...
```

**Expected:** `ok`.

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

`cmd/collector-go/main.go` in this task: `package main` with an empty `main` that returns, so the
image builds. Task 9 replaces it.

```
docker build -t signalforge-collector-go:task4 services/collector-go
```

**Expected:** build exits 0.

`.gitignore`: append `services/collector-go/bin/`.

**Staged files:**

```
git add services/collector-go/go.mod services/collector-go/go.sum services/collector-go/Dockerfile services/collector-go/.dockerignore
git add services/collector-go/cmd/collector-go/main.go services/collector-go/internal/config
git add scripts/go-in-docker.mjs scripts/go-in-docker.test.mjs .gitignore
git diff --cached --check
git diff --cached --stat
git commit -m "build(collector-go): add Docker-only Go workflow with pinned toolchain"
```

---

### Task 5 — ClickHouse schema, idempotent migrations, and store

**Depends on:** Task 4. **Spec:** 9, 12.4.

**Files (new):** `internal/store/store.go`, `internal/store/migrate.go`,
`internal/store/migrate_test.go`, `internal/store/migrations/0001_correlation_schema.sql`,
`internal/store/clickhouse.go`, `internal/store/fake_test.go`,
`internal/store/clickhouse_integration_test.go`.

**Migration file format.** Statements are separated by the line `-- statement-break`. The runner
embeds `migrations/*.sql` with `//go:embed`, sorts by filename, parses the version from the leading
four digits, applies every version greater than the maximum in `schema_migrations`, and inserts
`(version, name, applied_at)` after each migration's statements succeed.

**RED → GREEN, migration helpers** (`migrate_test.go`, written first):

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
    if _, err := versionFromFilename("schema.sql"); err == nil { t.Fatal("expected error") }
}
```

Expected RED: `undefined: splitStatements` (and the other helpers). GREEN: implement them.

**Schema** (`0001_correlation_schema.sql`): `CREATE TABLE IF NOT EXISTS` statements, each separated by
`-- statement-break`, for these tables. Database is `signalforge` (created by the ClickHouse image
from `CLICKHOUSE_DB`).

- `schema_migrations`: `MergeTree`, `ORDER BY version`; `version UInt32`, `name String`,
  `applied_at DateTime64(3, 'UTC')`.
- `telemetry_events`: `ReplacingMergeTree(ingested_at)`, `ORDER BY event_id`,
  `PARTITION BY toYYYYMMDD(timestamp)`; `event_id UUID`, `schema_version String`,
  `timestamp DateTime64(9, 'UTC')`, `ingested_at DateTime64(3, 'UTC')`,
  `type LowCardinality(String)`, `service LowCardinality(String)`, `service_version String`,
  `environment LowCardinality(String)`, `deployment_id String`, `trace_id String`,
  `span_id String`, `severity LowCardinality(String)`, `attributes String`.
- `deployments`: `ReplacingMergeTree(ingested_at)`, `ORDER BY deployment_id`; `deployment_id UUID`,
  `timestamp DateTime64(9, 'UTC')`, `service LowCardinality(String)`,
  `environment LowCardinality(String)`, `new_version String`, `previous_version String`,
  `initiated_by String`, `status LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `incidents`: `ReplacingMergeTree(revision)`, `ORDER BY incident_id`; `incident_id UUID`,
  `revision UInt64`, `dedup_key String`, `environment LowCardinality(String)`,
  `service LowCardinality(String)`, `deployment_id String`, `trigger_rule String`,
  `title String`, `status LowCardinality(String)`, `severity LowCardinality(String)`,
  `started_at DateTime64(9, 'UTC')`, `detected_at DateTime64(9, 'UTC')`,
  `services Array(String)`, `publication_state LowCardinality(String)`,
  `published_at DateTime64(9, 'UTC')`.
- `evidence_items`: `ReplacingMergeTree(ingested_at)`, `ORDER BY evidence_id`; `evidence_id UUID`,
  `incident_id UUID`, `source_type LowCardinality(String)`, `source_ref String`,
  `timestamp DateTime64(9, 'UTC')`, `service LowCardinality(String)`, `summary String`,
  `reliability LowCardinality(String)`, `ingested_at DateTime64(3, 'UTC')`.
- `correlation_runs`: `MergeTree`, `ORDER BY evaluated_until`; `run_id UUID`,
  `evaluated_until DateTime64(9, 'UTC')`, `created_at DateTime64(3, 'UTC')`.

**Store implementation** (`clickhouse.go`), using `clickhouse.Open(&clickhouse.Options{Addr: ...,
Auth: clickhouse.Auth{Database, Username, Password}})`. Writes use `conn.PrepareBatch` with explicit
column lists and `Send()`. Reads use these statements, all with `FINAL`:

```sql
-- FailureTraces
SELECT trace_id, deployment_id, service, min(timestamp) AS ts
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments'
  AND JSONExtractString(attributes, 'span.kind') = 'server'
  AND deployment_id != '' AND timestamp >= ?
  AND JSONExtractInt(attributes, 'http.response.status_code') = 500
GROUP BY trace_id, deployment_id, service
ORDER BY ts

-- SucceededDeployments
SELECT deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status
FROM deployments FINAL
WHERE service = 'demo-payments' AND status = 'succeeded' AND timestamp >= ?
ORDER BY timestamp

-- IncidentsByKey: latest revision per incident_id, for one dedup key
SELECT incident_id, revision, dedup_key, environment, service, deployment_id, trigger_rule, title,
       status, severity, started_at, detected_at, services, publication_state, published_at
FROM incidents FINAL WHERE dedup_key = ?

-- PendingIncidents: latest revision that is still pending
SELECT incident_id, revision, dedup_key, environment, service, deployment_id, trigger_rule, title,
       status, severity, started_at, detected_at, services, publication_state, published_at
FROM incidents FINAL WHERE publication_state = 'pending'

-- EvidenceCount
SELECT count() FROM evidence_items FINAL WHERE incident_id = ?

-- LatestEvaluatedUntil
SELECT max(evaluated_until) FROM correlation_runs
```

`MarkIncidentPublished(inc, publishedAt)` inserts one row into `incidents` with
`revision = inc.Revision + 1`, `publication_state = 'published'`, `published_at = publishedAt`, and
every other field copied from `inc` (including `detected_at`). `InsertIncidentWithEvidence` inserts
the incident row followed by the evidence rows as two insert batches. `InsertEvidence` inserts rows
with the deterministic `evidence_id`, so repeated inserts are harmless.

**Fake store** (`fake_test.go`, `package store`, shared by Tasks 8): an in-memory `Store` that
reproduces `ReplacingMergeTree` semantics. For `incidents` it keeps all revisions and returns the one
with the highest `revision` per `incident_id`; for `evidence_items` it keeps one row per
`evidence_id`; for `telemetry_events` one row per `event_id`. It has failure-injection fields
(`failRead`, `failWrite`) and counts of rows written. Its own test:

```go
func TestFakeIncidentRevisionsReplace(t *testing.T) {
    f := NewFake()
    inc := IncidentRow{IncidentID: "I", DedupKey: "k", Revision: 1, PublicationState: "pending"}
    _ = f.InsertIncidentWithEvidence(ctx, inc, nil)
    inc.Revision = 2; inc.PublicationState = "published"
    _ = f.MarkIncidentPublished(ctx, inc, time.Unix(100, 0))
    rows, _ := f.IncidentsByKey(ctx, "k")
    if len(rows) != 1 || rows[0].Revision != 2 || rows[0].PublicationState != "published" { t.Fatalf("%+v", rows) }
}
```

**Integration test** (`clickhouse_integration_test.go`): skipped unless `CLICKHOUSE_HOST` is set.
When set, it calls `MigrateUp` twice and asserts the second call applies zero versions, inserts one
`telemetry_events` row with a nanosecond timestamp, reads it back with `FINAL`, and asserts equal
nanosecond timestamps.

```
node scripts/go-in-docker.mjs go test ./internal/store/... -run 'TestSplitStatements|TestPendingSkipsApplied|TestVersionFromFilename|TestFakeIncidentRevisionsReplace'
```

**Expected:** `ok`. The integration test runs in Task 9 with the stack up.

**Staged files:**

```
git add services/collector-go/internal/store services/collector-go/go.mod services/collector-go/go.sum
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): add idempotent ClickHouse schema and revisioned store"
```

---

### Task 6 — Canonical mapping, identities, and dead-letter reasons

**Depends on:** Task 4. **Spec:** 7.4, 7.5, 8.1, 8.3, 13.1 item 3.

**Files (new):** `internal/canonical/otlp.go`, `mapping.go`, `mapping_test.go`, `identity.go`,
`identity_test.go`, `deadletter.go`, `testdata/traces.json`, `testdata/logs.json`,
`testdata/metrics.json`, `testdata/deployment.json`, `testdata/trace_missing_trace_id.json`,
`testdata/log_missing_trace_id.json`, `testdata/traces_no_service.json`.

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

**GREEN, identity.go.** `EventID(key)`: SHA-1 over the 16 namespace bytes followed by the key bytes
(RFC 4122 §4.3); set the version nibble to 5 and the variant bits to RFC 4122; format lower-case with
hyphens. `Namespace` is the constant in section 7.2. Standard library only.

**RED → GREEN, mapping tests** (`mapping_test.go`); fixtures are written first:

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
func TestLogAttributesArePreserved(t *testing.T) {
    events, reason := MapTelemetryMessage(load(t, "logs.json"))
    if reason != "" { t.Fatal(reason) }
    got := events[0]
    if got.Attributes["order_id"] != "11111111-1111-1111-1111-111111111111" { t.Fatalf("order_id lost: %v", got.Attributes) }
    if got.TraceID != "0af7651916cd43dd8448eb211c80319c" || got.Severity != "error" { t.Fatalf("%+v", got) }
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

Expected RED: `undefined: MapTelemetryMessage`.

**Mapping rules (exact):**
- Timestamp: `time.Unix(0, n).UTC()`, where `n` is `startTimeUnixNano` for spans, `timeUnixNano` for
  log records (or `observedTimeUnixNano` when that is zero), and `timeUnixNano` for metric data
  points. OTLP JSON encodes these 64-bit integers as strings; parse with `strconv.ParseInt`.
- Attribute values: `stringValue` → string; `intValue` (a string in OTLP JSON) → `float64` after
  `ParseInt`; `boolValue` → bool; `doubleValue` → `float64`; any other type → its raw JSON text.
- Trace identity: `EventID("trace|" + traceID + "|" + spanID)`. Log identity:
  `EventID("log|" + traceID + "|" + spanID + "|" + ns + "|" + sha256hex(body))`. Metric identity:
  `EventID("metric|" + service + "|" + name + "|" + sortedKV + "|" + ns)`, where `sortedKV` is the
  sorted `key=value` pairs joined by `,`. Deployment identity: `EventID("deployment|" + deploymentID)`.
- Span kind: OTLP `kind` 2 → `server`, 3 → `client`, other → `unspecified`. Status code: 0 → `unset`,
  1 → `ok`, 2 → `error`.
- Log attributes: every attribute on the record is copied unchanged (including `order_id`), plus
  `log.body`.

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

**Files (new):** `internal/ingest/backoff.go`, `backoff_test.go`, `normalizer.go`,
`normalizer_test.go`, `kafka.go`.

**RED → GREEN, backoff** (`backoff_test.go`):

```go
func TestBackoffSequence(t *testing.T) {
    b := NewBackoff()
    for i, w := range []int{1, 2, 4, 8, 16, 16} {
        got, ok := b.Next()
        if !ok || got != time.Duration(w)*time.Second { t.Fatalf("step %d: %v %v", i, got, ok) }
    }
}
func TestBackoffGivesUpAfterTwoMinutes(t *testing.T) {
    b := NewBackoff()
    var total time.Duration
    for { d, ok := b.Next(); if !ok { break }; total += d }
    if total != 2*time.Minute { t.Fatalf("total %v", total) }
}
```

GREEN: `Next()` returns the current delay, doubling up to the 16 s cap, and returns `ok=false` when
the cumulative delay has reached 2 minutes; the final delay is truncated so the total is exactly
2 minutes.

**RED → GREEN, normalizer** (`normalizer_test.go`) with in-memory fakes for `Consumer`, `Producer`,
and the fake store (Task 5):

```go
func TestValidBatchIsWrittenThenCommitted(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: NewBackoff()}
    if err := n.ProcessBatch(ctx, []Record{validTraceRecord(7)}); err != nil { t.Fatal(err) }
    if f.store.EventsWritten() != 1 || f.consumer.Committed()[0] != 7 { t.Fatalf("%+v %+v", f.store, f.consumer) }
    if len(f.producer.Sent()) != 0 { t.Fatal("valid record must not be dead-lettered") }
}
func TestInvalidRecordGoesToDeadLetterWithExactReason(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: NewBackoff()}
    _ = n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(9)})
    sent := f.producer.Sent()
    if len(sent) != 1 || sent[0].Topic != "telemetry.dead-letter.v1" { t.Fatalf("%+v", sent) }
    dl := decodeDeadLetter(t, sent[0].Value)
    if dl.Reason != "trace_id and span_id are required for trace events" || dl.SourceOffset != 9 { t.Fatalf("%+v", dl) }
    if f.store.EventsWritten() != 0 { t.Fatal("invalid record must not be stored") }
    if f.consumer.Committed()[0] != 9 { t.Fatal("dead-lettered offset must be committed") }
}
func TestWriteFailureDoesNotCommit(t *testing.T) {
    f := newFakes()
    f.store.FailWrites(true)
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: instantBackoff(3)}
    if err := n.ProcessBatch(ctx, []Record{validTraceRecord(11)}); err == nil { t.Fatal("expected failure after give-up") }
    if len(f.consumer.Committed()) != 0 { t.Fatal("offset committed despite failed write") }
}
func TestDeadLetterProduceFailureDoesNotCommit(t *testing.T) {
    f := newFakes()
    f.producer.Fail(true)
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: instantBackoff(1)}
    if err := n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(12)}); err == nil { t.Fatal("expected error") }
    if len(f.consumer.Committed()) != 0 { t.Fatal("offset committed without dead letter") }
}
func TestDeploymentRecordIsStored(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: NewBackoff()}
    _ = n.ProcessBatch(ctx, []Record{deploymentRecord(13)})
    if f.store.DeploymentsWritten() != 1 { t.Fatal("deployment not written") }
}
func TestUnexpectedTopicIsDeadLettered(t *testing.T) {
    f := newFakes()
    n := &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: NewBackoff()}
    _ = n.ProcessBatch(ctx, []Record{{Topic: "other.v1", Offset: 14, Value: []byte("{}")}})
    dl := decodeDeadLetter(t, f.producer.Sent()[0].Value)
    if dl.Reason != "unexpected source topic other.v1" { t.Fatalf("%+v", dl) }
}
```

Expected RED: `undefined: Normalizer`. GREEN: `ProcessBatch` does the following:
1. For each record, select the mapper by `Topic`: `telemetry.raw.v1` → `MapTelemetryMessage`;
   `deployments.v1` → `MapDeploymentMessage`; other → dead letter with `unexpected source topic <topic>`.
2. Collect valid events and deployments across the batch.
3. Write events with `Store.InsertEvents` and deployments with `Store.InsertDeployments` under
   the backoff. Failure after give-up returns the error.
4. Produce every dead letter to `telemetry.dead-letter.v1` with key `strconv.FormatInt(offset, 10)`
   under the same backoff. Failure after give-up returns the error.
5. Commit all offsets in the batch with `Consumer.Commit`, only after steps 3 and 4 succeed.

**Kafka adapters** (`kafka.go`, exercised by Task 12):
- `NewConsumer(brokers []string, topics []string, group string) (*kgo.Client, error)` with
  `kgo.ConsumeTopics`, `kgo.ConsumerGroup(group)`, `kgo.DisableAutoCommit()`,
  `kgo.FetchMaxWait(time.Second)`.
- `Poll` uses `client.PollFetches(ctx)`, converts records to `Record`, and returns any fetch error.
- `Commit` builds the offset map of the highest offset + 1 per partition and calls
  `client.CommitOffsetsSync`.
- `Producer` wraps a second `kgo.Client` and calls `ProduceSync` with `kgo.Record{Topic, Key, Value}`.

**Staged files:**

```
git add services/collector-go/internal/ingest
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): normalize telemetry with dead letters and at-least-once commits"
```

---

### Task 8 — Correlator and durable publisher

**Depends on:** Tasks 5, 6, 7. **Spec:** 10, 11, 12.1–12.4.

**Files (new):** `internal/correlate/rule.go`, `rule_test.go`, `dedup.go`, `dedup_test.go`,
`correlator.go`, `correlator_test.go`; `internal/publish/publisher.go`, `publisher_test.go`.

**RED → GREEN, detection** (`rule_test.go`; helper `fail(traceID, at)` builds a `store.FailureRow`
for deployment `D1`, service `demo-payments`):

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

GREEN: `DetectBurst` follows spec 10.1 exactly: for each deployment with `Status == "succeeded"` and
`Service == "demo-payments"`, filter failures to its `DeploymentID`, sort by time, collapse duplicate
`TraceID` keeping the earliest, find the smallest `i` where `F[i+2].Timestamp - F[i].Timestamp <= 30s`,
then require `dep.Timestamp <= F[i].Timestamp` and `F[i].Timestamp - dep.Timestamp <= 5min`. Output one
`Candidate` per matching deployment.

**RED → GREEN, dedup and identities** (`dedup_test.go`):

```go
func TestDedupKeyFormat(t *testing.T) {
    if got := DedupKey("local", "demo-payments", "D1", "payments-5xx-burst-after-deployment"); got != "local|demo-payments|D1|payments-5xx-burst-after-deployment" { t.Fatal(got) }
}
func TestSuppressesWithinFiveMinutesBeforeCandidate(t *testing.T) {
    if !Suppressed([]store.IncidentRow{{StartedAt: t0}}, t0.Add(4*time.Minute)) { t.Fatal("not suppressed") }
}
func TestNotSuppressedAfterFiveMinutes(t *testing.T) {
    if Suppressed([]store.IncidentRow{{StartedAt: t0}}, t0.Add(5*time.Minute+time.Second)) { t.Fatal("suppressed") }
}
func TestIncidentIDIsStable(t *testing.T) {
    if IncidentID("k", t0) != IncidentID("k", t0) { t.Fatal("unstable") }
}
```

GREEN: `Suppressed` returns true when some existing row has `StartedAt` in
`[candidateStart - 5m, candidateStart)`. `IncidentID(key, start)` is
`canonical.EventID(key + "|" + strconv.FormatInt(start.UnixNano(), 10))`. `EvidenceID` is as in section 7.2.

**RED → GREEN, correlator** (`correlator_test.go`; the fake store from Task 5). No producer is
passed to the correlator.

```go
func TestCycleCreatesPendingIncidentWithFourEvidenceRows(t *testing.T) {
    s := store.NewFake()
    seedBurst(s, t0, dep) // three failure traces and the deployment
    c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
    if err := c.RunCycle(ctx, c.Now()); err != nil { t.Fatal(err) }
    rows, _ := s.IncidentsByKey(ctx, DedupKey("local", "demo-payments", "D1", TriggerRule))
    if len(rows) != 1 { t.Fatalf("incidents: %d", len(rows)) }
    inc := rows[0]
    if inc.Revision != 1 || inc.PublicationState != "pending" || inc.Severity != "high" || inc.Status != "open" { t.Fatalf("%+v", inc) }
    if !inc.StartedAt.Equal(t0) || inc.Services[0] != "demo-payments" { t.Fatalf("%+v", inc) }
    if n, _ := s.EvidenceCount(ctx, inc.IncidentID); n != 4 { t.Fatalf("evidence: %d", n) }
}
func TestSecondCycleIsIdempotent(t *testing.T) {
    s := store.NewFake(); seedBurst(s, t0, dep)
    c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now()); _ = c.RunCycle(ctx, c.Now())
    if s.IncidentRevisionCount() != 1 || s.EvidenceRowCount() != 4 { t.Fatal("not idempotent") }
}
func TestRepairsMissingEvidenceForExistingIncident(t *testing.T) {
    s := store.NewFake(); seedBurst(s, t0, dep)
    c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now())
    s.DropEvidenceAfterFirst() // simulate a failed evidence insert
    _ = c.RunCycle(ctx, c.Now())
    if s.EvidenceRowCount() != 4 { t.Fatalf("not repaired: %d", s.EvidenceRowCount()) }
    if s.IncidentRevisionCount() != 1 { t.Fatal("repair must not create an incident revision") }
}
func TestReadFailureReturnsErrorWithoutWriting(t *testing.T) {
    s := store.NewFake(); seedBurst(s, t0, dep); s.FailRead(true)
    c := &Correlator{Store: s, Now: fixed(t0)}
    if err := c.RunCycle(ctx, c.Now()); err == nil { t.Fatal("expected error") }
    if s.IncidentRevisionCount() != 0 { t.Fatal("wrote after read failure") }
}
func TestCorrelationRunIsRecorded(t *testing.T) {
    s := store.NewFake(); seedBurst(s, t0, dep)
    c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
    _ = c.RunCycle(ctx, c.Now())
    if u, _ := s.LatestEvaluatedUntil(ctx); u.Before(t0) { t.Fatalf("%v", u) }
}
```

GREEN: `RunCycle(ctx, now)`:
1. `since := now.Add(-LookbackWindow)`; read `FailureTraces(since)` and `SucceededDeployments(since)`.
   A read error is returned immediately, with no writes.
2. `candidates := DetectBurst(failures, deployments)`.
3. For each candidate: `key := DedupKey(...)`, `id := IncidentID(key, candidate.StartedAt)`, and
   `existing := IncidentsByKey(key)`.
   - If some existing row has `IncidentID == id`: insert the four evidence rows via `InsertEvidence`
     (idempotent). No incident insert, and nothing is published.
   - Else if `Suppressed(existing, candidate.StartedAt)`: skip.
   - Else: `InsertIncidentWithEvidence(IncidentRow{... Revision: 1, PublicationState: "pending", PublishedAt: ZeroTime, DetectedAt: now}, evidence)`.
4. `InsertCorrelationRun` with `EvaluatedUntil` as in section 8.3.

**RED → GREEN, publisher** (`publisher_test.go`; fake store and fake producer):

```go
func TestPublishesPendingIncidentWithFourEvidenceAndMarksPublished(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 4)
    p := &fakeProducer{}
    pub := &Publisher{Store: s, Producer: p, Now: fixed(t0.Add(time.Minute)), Exit: noExit, Log: discardLog()}
    if err := pub.RunCycle(ctx); err != nil { t.Fatal(err) }
    if len(p.Sent()) != 1 || p.Sent()[0].Topic != "incidents.created.v1" || p.Sent()[0].Key != testIncidentID { t.Fatalf("%+v", p.Sent()) }
    rows, _ := s.IncidentsByKey(ctx, testKey)
    if len(rows) != 1 || rows[0].Revision != 2 || rows[0].PublicationState != "published" { t.Fatalf("%+v", rows) }
    if s.IncidentRevisionCount() != 2 || s.EvidenceRowCount() != 4 { t.Fatal("duplicate rows") }
}
func TestSkipsPendingIncidentWithIncompleteEvidence(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 2)
    p := &fakeProducer{}
    pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
    _ = pub.RunCycle(ctx)
    if len(p.Sent()) != 0 { t.Fatal("published before four evidence rows") }
}
func TestProduceFailureLeavesPendingAndRetriesNextCycle(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 4)
    p := &fakeProducer{}; p.FailNext(1)
    pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
    _ = pub.RunCycle(ctx)
    if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "pending" { t.Fatal("state changed after failed produce") }
    _ = pub.RunCycle(ctx)
    if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "published" || len(p.Sent()) != 1 { t.Fatalf("%+v", rows) }
}
func TestMarkFailureRetriesWithoutDuplicateIncident(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 4)
    s.FailWrite(true)
    p := &fakeProducer{}
    pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
    _ = pub.RunCycle(ctx)                 // produced, state write fails
    s.FailWrite(false)
    _ = pub.RunCycle(ctx)                 // produced again (allowed), state written
    if len(p.Sent()) != 2 { t.Fatalf("produces: %d", len(p.Sent())) }
    if s.IncidentRevisionCount() != 2 || s.EvidenceRowCount() != 4 { t.Fatal("duplicate incident or evidence rows") }
    rows, _ := s.IncidentsByKey(ctx, testKey)
    if rows[0].PublicationState != "published" { t.Fatalf("%+v", rows) }
}
func TestCrashAfterProduceRecoversOnRestartWithoutDuplicateRows(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 4)
    p := &fakeProducer{}
    var exitCode = -1
    crashing := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: func(c int) { exitCode = c }, CrashAfterProduce: true, Log: discardLog()}
    _ = crashing.RunCycle(ctx)
    if exitCode != 1 || len(p.Sent()) != 1 { t.Fatalf("exit %d, produces %d", exitCode, len(p.Sent())) }
    if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "pending" { t.Fatal("state written before exit") }
    restarted := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
    _ = restarted.RunCycle(ctx)
    if len(p.Sent()) != 2 { t.Fatalf("produces after restart: %d", len(p.Sent())) }
    if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "published" { t.Fatal("not published after restart") }
    if s.IncidentRevisionCount() != 2 || s.EvidenceRowCount() != 4 { t.Fatal("duplicate incident or evidence rows") }
    if p.Sent()[0].Key != p.Sent()[1].Key { t.Fatal("redelivery must reuse the incident_id key") }
}
func TestPublishFailHookFailsFirstNAttempts(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 4)
    p := &fakeProducer{}
    pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, FailProduceAttempts: 2, Log: discardLog()}
    _ = pub.RunCycle(ctx); _ = pub.RunCycle(ctx); _ = pub.RunCycle(ctx)
    if len(p.Sent()) != 1 { t.Fatalf("produces: %d", len(p.Sent())) }
}
func TestStoreReadFailureProducesNothing(t *testing.T) {
    s := store.NewFake(); seedPendingIncident(s, 4); s.FailRead(true)
    p := &fakeProducer{}
    pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
    if err := pub.RunCycle(ctx); err == nil { t.Fatal("expected error") }
    if len(p.Sent()) != 0 { t.Fatal("produced after read failure") }
}
```

Expected RED: `undefined: Publisher` (and `Correlator`, `DetectBurst`, `DedupKey`). GREEN: `Publisher.RunCycle`
follows section 8.4 exactly. The payload is built by `IncidentPayload` from the `IncidentRow` fields
(section 8.5). Produce uses `Producer.Produce(ctx, "incidents.created.v1", incidentID, payload)`. The
state write uses `MarkIncidentPublished(inc, now)`. `FailProduceAttempts` is decremented on each produce
call, and a call that still has budget returns an error without calling the producer. `CrashAfterProduce`
calls `Exit(1)` immediately after a successful produce and before the state write, then returns.

**Staged files:**

```
git add services/collector-go/internal/correlate services/collector-go/internal/publish
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): correlate payments 5xx bursts and publish incidents durably"
```

---

### Task 9 — Process wiring, test hooks, and Compose service

**Depends on:** Tasks 3, 4, 5, 7, 8. **Spec:** 6.1, 12.4, 13.2 precondition, 16, 18.

**Files:** `services/collector-go/cmd/collector-go/main.go` (change), `internal/config/config.go`
and `config_test.go` (change: test hooks), `services/collector-go/README.md` (change),
`infra/docker/docker-compose.yml` (change: `collector-go`), `.env.example` (change).

**RED.** Confirm the placeholder is still running:

```
docker compose -f infra/docker/docker-compose.yml up -d collector-go
docker compose -f infra/docker/docker-compose.yml logs collector-go
docker compose -f infra/docker/docker-compose.yml down
```

**Expected RED:** no log lines; the container runs `sleep infinity` in its previous form (no
normalizer, correlator, or publisher output within 30 s). Config test RED first:

```go
func TestLoadTestHookDefaults(t *testing.T) {
    c, err := Load(env(validEnv))
    if err != nil || c.IncidentPublishFailAttempts != 0 || c.IncidentCrashAfterProduce { t.Fatalf("%+v %v", c, err) }
}
func TestLoadRejectsNegativeFailAttempts(t *testing.T) {
    _, err := Load(env(withEnv(validEnv, "INCIDENT_PUBLISH_FAIL_ATTEMPTS", "-1")))
    if err == nil || err.Error() != "INCIDENT_PUBLISH_FAIL_ATTEMPTS must be a non-negative integer" { t.Fatalf("got %v", err) }
}
func TestLoadRejectsBadCrashFlag(t *testing.T) {
    _, err := Load(env(withEnv(validEnv, "INCIDENT_CRASH_AFTER_PRODUCE", "yes")))
    if err == nil || err.Error() != "INCIDENT_CRASH_AFTER_PRODUCE must be 0 or 1" { t.Fatalf("got %v", err) }
}
```

Expected RED: `c.IncidentPublishFailAttempts undefined`. GREEN: add the two fields
(`IncidentPublishFailAttempts int`, `IncidentCrashAfterProduce bool`) and the parsing with the exact
errors of section 7.2.

**GREEN, main.go.** Sequence:
1. `cfg, err := config.Load(os.LookupEnv)`; on error, print the message and exit 1.
2. Open the store; `MigrateUp(ctx)`; on error exit 1. Log `migrations applied` with the count.
3. Create the consumer (topics `telemetry.raw.v1`, `deployments.v1`, group
   `collector-go-normalizer`) and the producer.
4. Normalizer loop: `Poll`, then `ProcessBatch`. A `ProcessBatch` error exits with status 1.
5. Correlator loop: a 1 s ticker calling `RunCycle(ctx, time.Now().UTC())`. Errors are logged; the
   loop continues.
6. Publisher loop: a 1 s ticker calling `Publisher.RunCycle(ctx)` with `FailProduceAttempts` and
   `CrashAfterProduce` from the config, and `Exit: os.Exit`. Errors are logged; the loop continues.
7. SIGINT or SIGTERM cancels the context and returns.

Logging is `log/slog` JSON on stdout with the fixed event names `migrations applied`,
`batch processed`, `dead letter produced`, `incident created`, `incident suppressed`,
`incident evidence repaired`, `publish failed`, `publish state write failed`, `incident published`,
and `cycle failed`.

**Compose** (`infra/docker/docker-compose.yml`), replacing the placeholder:

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
      INCIDENT_PUBLISH_FAIL_ATTEMPTS: ${INCIDENT_PUBLISH_FAIL_ATTEMPTS:-0}
      INCIDENT_CRASH_AFTER_PRODUCE: ${INCIDENT_CRASH_AFTER_PRODUCE:-0}
    depends_on:
      redpanda-init:
        condition: service_completed_successfully
      clickhouse:
        condition: service_healthy
    restart: "no"
```

`restart: "no"` matches section 8.2: a fatal failure stops the service and is not hidden. The
acceptance script restarts it deliberately (Task 12).

`.env.example`: document the two test hooks, with a note that they are for acceptance runs only.

**Verification (GREEN):**

```
node scripts/go-in-docker.mjs go vet ./...
node scripts/go-in-docker.mjs go test ./...
docker compose -f infra/docker/docker-compose.yml up -d --build collector-go
```

Poll `docker compose -f infra/docker/docker-compose.yml ps --format json` for `collector-go`
state `running` (deadline 60 s, interval 1 s). Then:

```
docker compose -f infra/docker/docker-compose.yml logs collector-go
```

**Expected:** a `migrations applied` line with `"applied":1` on first start and no `error`-level
lines. After `docker compose -f infra/docker/docker-compose.yml restart collector-go`, the logs show
`migrations applied` with `"applied":0`.

The ClickHouse integration test (Task 5) runs against the live stack:

```
node scripts/go-in-docker.mjs --network signalforge_default --env CLICKHOUSE_HOST=clickhouse --env CLICKHOUSE_PORT=9000 --env CLICKHOUSE_DB=signalforge --env CLICKHOUSE_USER=default --env CLICKHOUSE_PASSWORD=changeme-local-only go test ./internal/store/... -run Integration
```

**Expected:** `ok`.

```
docker compose -f infra/docker/docker-compose.yml config --quiet
docker compose -f infra/docker/docker-compose.yml down
```

**Staged files:**

```
git add services/collector-go/cmd/collector-go/main.go services/collector-go/internal/config services/collector-go/README.md
git add infra/docker/docker-compose.yml .env.example
git diff --cached --check
git diff --cached --stat
git commit -m "feat(collector-go): run normalizer, correlator, and publisher in Compose"
```

---

### Task 10 — Deployment mechanism script

**Depends on:** Tasks 2, 3, 9. **Spec:** 17, 8.4.

**Files (new):** `scripts/deploy-payments.mjs`, `scripts/deploy-payments.test.mjs`.

**RED.** Create the test file first:

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
test('rejects an empty environment', () => {
  assert.throws(() => parseArgs(['--version', 'x', '--environment', '']), /--environment must not be empty/);
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

```
node --test scripts/deploy-payments.test.mjs
```

**Expected RED:** `Cannot find module './deploy-payments.mjs'`.

**GREEN.** Implement the exports with exactly the asserted behavior. `parseArgs` throws
`--version is required`, `--fault must be enabled or disabled`, or `--environment must not be empty`.
`buildDeploymentEvent` takes the timestamp as an argument so tests are exact. `main()` runs when
`import.meta.url` equals the entry script's file URL, and performs the steps of spec 17 in order, each
with `child_process.spawn` and an argument array:

1. `deploymentId = randomDeploymentId()`.
2. `docker compose -f infra/docker/docker-compose.yml up -d --force-recreate --no-deps demo-payments`
   with `env: buildComposeEnv(process.env, ...)`. Non-zero exit → exit 1 with `step compose-recreate failed`.
3. Poll `docker inspect --format {{.State.Health.Status}} signalforge-demo-payments-1` every 1 s,
   deadline 60 s, until `healthy`. Timeout → exit 1 with `step health timed out`.
4. Run `docker compose -f infra/docker/docker-compose.yml exec -T redpanda rpk topic produce deployments.v1 --key <deploymentId> --brokers redpanda:9092`
   and write `JSON.stringify(buildDeploymentEvent(...))` to its stdin, then close stdin. Non-zero exit →
   exit 1 with `step publish failed` and the `deployment_id` printed.
5. Print `deployment_id=<deploymentId>` on its own line and exit 0.

**Verification:**

```
node --test scripts/deploy-payments.test.mjs
```

**Expected:** all pass. With the stack up (Task 9), a live deploy is
`node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled`; expected exit 0 and a printed
deployment ID. The deployment event is then consumed with `consumeBounded({ topic: 'deployments.v1', num: 1, offset: 'start' })`
and must contain that ID.

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

**RED.** With the stack down:

```
node scripts/verify-faulty-deployment-incident.mjs
```

**Expected RED:** exit 1 with `precondition failed: service collector-go is not running`.

**Structure.** All waits use `pollUntil(check, { intervalMs, timeoutMs, what })`, which throws
`Timed out after <ms>ms waiting for: <what>`. Helpers:
- `compose(args, { env, input })`: `spawn('docker', ['compose', '-f', COMPOSE, ...args])`, resolves
  `{ stdout, stderr, code }`.
- `clickhouseRows(sql)`: runs
  `docker compose -f <compose> exec -T clickhouse clickhouse-client --query <sql> --format JSONEachRow`
  and parses the rows. Only the SQL of Task 5 and the statements written in these steps are used.
- `consumeBounded` from `scripts/rpk-consume-bounded.mjs` (Task 3), with a 5-second kill timer.
- `eventIdV5(key)`: the section 7.5 rule with `crypto` (SHA-1), the same algorithm as the Go
  implementation. The script checks it against the fixture value
  `EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331")` recorded in Task 6's test before
  using it.
- `setCollectorHooks({ failAttempts, crash })`: recreates `collector-go` with
  `docker compose ... up -d --force-recreate --no-deps collector-go`, passing
  `INCIDENT_PUBLISH_FAIL_ATTEMPTS` and `INCIDENT_CRASH_AFTER_PRODUCE` through `env`, then waits for
  the container to be `running` (60 s).
- `deployFaulty(version)`: runs `node scripts/deploy-payments.mjs --version <v> --fault enabled` via
  spawn and parses `deployment_id=<id>`.
- `sendOrders(n)`: sends `n` orders with fresh `randomUUID()` IDs, each to `POST http://localhost:8081/orders`
  with `item: "widget"`, `amount_cents: 500`, asserting 502 and the exact body, and returns the IDs.

**Order-to-trace resolution** (used by every scenario). The Orders log record `payment failed` carries
the attribute `order_id` (spec 7.2). Trace IDs for a list of orders:

```sql
SELECT JSONExtractString(attributes, 'order_id') AS order_id, trace_id
FROM telemetry_events FINAL
WHERE type = 'log' AND service = 'demo-orders' AND severity = 'error'
  AND JSONExtractString(attributes, 'order_id') IN ('<id1>', '<id2>', '<id3>')
```

It must return exactly one row per order (the script fails if any order has zero or several rows).

**Payments failure traces for a deployment:**

```sql
SELECT DISTINCT trace_id, min(timestamp) AS ts
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments'
  AND JSONExtractString(attributes, 'span.kind') = 'server'
  AND JSONExtractInt(attributes, 'http.response.status_code') = 500
  AND deployment_id = '<deployment_id>'
GROUP BY trace_id
ORDER BY ts
```

**Scenario A: main correlation path.**

A1. `deployFaulty('0.2.0-faulty')` → deployment `D1`. Expected: exit 0.
A2. Poll (500 ms, 30 s) until `deployments` has `D1` with status `succeeded`.
A3. `O1, O2, O3 = sendOrders(3)`.
A4. Poll (500 ms, 30 s) until the order-to-trace query returns one row for each of `O1`, `O2`, `O3`.
    Let `T(O1)`, `T(O2)`, `T(O3)` be those trace IDs. Poll (500 ms, 30 s) until the Payments failure
    traces for `D1` contain these three IDs and no other. Assert the set of Payments failure trace IDs
    equals `{T(O1), T(O2), T(O3)}` exactly. This is the order-to-trace identity: the three triggers are
    the traces of the three submitted orders.
A5. Poll (500 ms, 60 s) for exactly one row in `IncidentsByKey(<env>|demo-payments|D1|payments-5xx-burst-after-deployment)`
    (latest revision). Assert `severity = 'high'`, `status = 'open'`, `services = ['demo-payments']`,
    `started_at` equals the minimum Payments failure timestamp of A4 (to the nanosecond string), and
    `detected_at >= started_at`. Let `I1` be the incident ID.
A6. Assert exactly four `evidence_items` rows for `I1` (`EvidenceCount = 4`): one `deployment` row with
    `source_ref = D1`, and three `trace` rows whose `source_ref` set equals `{T(O1), T(O2), T(O3)}`.
A7. Poll (500 ms, 60 s) until the latest revision of `I1` has `publication_state = 'published'`. Then
    `consumeBounded({ topic: 'incidents.created.v1', num: 50, offset: 'start' })` must return exactly one
    record with key/`incident_id` `I1` (healthy path: one message).
A8. Dedup. `O4, O5, O6 = sendOrders(3)`. Resolve their traces as in A4 (against `D1`, the same
    deployment). Poll (500 ms, 60 s) until `LatestEvaluatedUntil` is at or after the newest failure
    timestamp of `T(O4)`, `T(O5)`, `T(O6)`. Assert: `IncidentsByKey` for the same dedup key returns exactly
    one incident; that incident has exactly four evidence rows; none of `T(O4)`, `T(O5)`, `T(O6)` is an
    evidence `source_ref`.
A9. Dead letter. Publish one malformed trace message to `telemetry.raw.v1` with `rpk topic produce`
    (a `resourceSpans` span with no `traceId`). Poll (500 ms, 30 s) for `telemetry.dead-letter.v1` with
    `reason = "trace_id and span_id are required for trace events"`. Assert no `telemetry_events` row exists
    for the malformed record. Send one valid order and poll (500 ms, 30 s) until its trace is in
    `telemetry_events`.
A10. Idempotency. Build one valid trace message with fixed IDs (`traceId` `0af7651916cd43dd8448eb211c80319c`,
     `spanId` `b7ad6b7169203331`, `service.name` `demo-orders`, start time now). Publish it twice to
     `telemetry.raw.v1`, then publish a sentinel with fixed IDs `traceId` `11111111111111111111111111111111`,
     `spanId` `2222222222222222`. Poll (500 ms, 30 s) until the sentinel is in `telemetry_events`. Assert the
     `FINAL` count of rows with `event_id = eventIdV5('trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331')`
     is exactly 1.

**Scenario B: failed publication, then retried without duplicates.**

B1. `setCollectorHooks({ failAttempts: 2, crash: 0 })`.
B2. `deployFaulty('0.3.0-faulty')` → `D2`. `O7, O8, O9 = sendOrders(3)`. Resolve traces; assert the
    Payments failure set for `D2` equals `{T(O7), T(O8), T(O9)}`.
B3. Poll (500 ms, 60 s) for the `D2` incident (latest revision) with `publication_state = 'published'`.
    Let `I2` be its ID. Assert:
    - the `collector-go` logs contain at least two `publish failed` lines for `I2` (the two injected failures);
    - exactly one `IncidentsByKey` row for the `D2` dedup key;
    - exactly four evidence rows for `I2`;
    - `consumeBounded({ topic: 'incidents.created.v1', num: 50, offset: 'start' })` returns at least one record
      with `incident_id` `I2`.
B4. `setCollectorHooks({ failAttempts: 0, crash: 0 })` (restores default hooks for scenario C).

**Scenario C: crash between produce and publication state, then restart.**

C1. `setCollectorHooks({ failAttempts: 0, crash: 1 })`.
C2. `deployFaulty('0.4.0-faulty')` → `D3`. `O10, O11, O12 = sendOrders(3)`. Resolve traces; assert the
    Payments failure set for `D3` equals `{T(O10), T(O11), T(O12)}`. Note: the incident is created by the
    correlator before the publisher produces, so the crash occurs after the incident and its four evidence
    rows exist.
C3. Poll (500 ms, 60 s) until the `collector-go` container state is `exited` with exit code 1
    (`docker inspect --format {{.State.Status}} {{.State.ExitCode}}`).
C4. `setCollectorHooks({ failAttempts: 0, crash: 0 })`: recreate with default hooks, which restarts the
    service.
C5. Poll (500 ms, 60 s) until the `D3` incident (latest revision) has `publication_state = 'published'`.
    Let `I3` be its ID. Assert:
    - exactly one `IncidentsByKey` row for the `D3` dedup key after `FINAL`;
    - exactly four evidence rows for `I3`;
    - `consumeBounded({ topic: 'incidents.created.v1', num: 100, offset: 'start' })` returns at least two
      records with `incident_id` `I3`. Both have key `I3`. This is the allowed at-least-once duplicate.

**Restore (always runs).**

R1. In a `finally` block: `setCollectorHooks({ failAttempts: 0, crash: 0 })`, then
    `node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled`. Each step's exit status is recorded;
    any failure here makes the run fail even if every assertion passed.

**Output.** On success, print the incident IDs `I1`, `I2`, `I3`, the deployment IDs `D1`, `D2`, `D3`, the
resolved triggers of each scenario, the four evidence rows of `I1`, and `PASS`. On failure, print
`FAIL <step>: <message>` and the last 200 `collector-go` log lines.

**Exit status:** 0 only if every assertion in A, B, and C passes and R1 succeeds.

**Verification (GREEN):**

```
docker compose -f infra/docker/docker-compose.yml up -d --build redpanda redpanda-init clickhouse otel-collector collector-go demo-orders demo-payments
```

Poll container health for `signalforge-demo-payments-1` and `signalforge-demo-orders-1` (60 s). Then:

```
node scripts/verify-faulty-deployment-incident.mjs
node scripts/verify-faulty-deployment-incident.mjs
```

**Expected:** both runs exit 0 with `PASS`, with different deployment IDs and incident IDs.

**Staged files:**

```
git add scripts/verify-faulty-deployment-incident.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "test: add faulty-deployment incident acceptance script"
```

---

### Task 12 — ADR, README, and final clean-stack validation

**Depends on:** Task 11. **Spec:** 20, all of section 13.

**Files:** `docs/decisions/0004-faulty-deployment-correlation.md` (new), `README.md` (change).

**ADR content:** Status: Accepted. Context: the spec's pipeline. Decision: the pinned values in section
3 (Go 1.27.1, the builder digest, franz-go v1.22.1, clickhouse-go v2.48.0, `protocol_version` 2.0.0 as
an explicit compatibility choice verified by Task 3, batch/queue/retry values); reading ClickHouse rather
than a normalized topic; SDK-side enrichment; a single process; the durable publisher with a `pending` →
`published` state in revisioned rows; the test hooks; the detection and dedup constants. Consequences:
spec section 14 limitations, and the at-least-once publication guarantee and its duplicate case.

**README:** a section "Faulty deployment incident correlation" with: the acceptance command; that Go is
run only in Docker (`node scripts/go-in-docker.mjs go test ./...`); the deploy command
(`node scripts/deploy-payments.mjs --version <v> --fault enabled`); the topic list; the two test hooks
and that they are for acceptance runs only; the at-least-once guarantee ("one persisted incident, at-least-
once publication; the healthy path produces one message"); the limits of spec section 14. The status line
names this slice. The Quick start and Observability sections from the completed slice remain accurate.

**Final validation (every command, in order; stop at the first failure and report it):**

1. `python scripts/validate-schemas.py` → exit 0.
2. `node --test scripts/deploy-payments.test.mjs scripts/rpk-consume-bounded.test.mjs scripts/go-in-docker.test.mjs` → all pass.
3. `npm --prefix services/demo-orders test` and `npm --prefix services/demo-orders run typecheck` → pass.
4. `npm --prefix services/demo-payments test` and `npm --prefix services/demo-payments run typecheck` → pass.
5. `node scripts/go-in-docker.mjs go vet ./...` and `node scripts/go-in-docker.mjs go test ./...` → pass.
6. `docker compose -f infra/docker/docker-compose.yml config --quiet` → exit 0.
7. `docker compose -f infra/docker/docker-compose.yml build --no-cache collector-go demo-payments demo-orders` → exit 0.
8. Start the stack (Task 11 command), wait for health, run
   `node scripts/verify-faulty-deployment-incident.mjs` twice → both exit 0.
9. `docker compose -f infra/docker/docker-compose.yml down` → exit 0.
10. `docker ps --filter name=signalforge` and `docker network ls --filter name=signalforge` print nothing.
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
| 6.1 | Component responsibilities, including publisher | 2, 3, 8, 9, 10 | Compose and build checks per task |
| 6.2 | Per-run deployment ID | 10, 11 | Deploy test (`randomDeploymentId`); acceptance A1, B2, C2 |
| 6.3 | Fault mode before validation; health 200; invalid mode fails startup | 2 | `fault.test.ts`, `config.test.ts` |
| 6.4 | Resource attributes and env defaults | 2 | `config.test.ts` |
| 7.2 | Trace-ID rule, no fabrication; order identity via log attributes | 1, 6 | `mapping_test.go` (copy, metric, missing, log attributes) |
| 7.3 | Conditional `trace_id` schema | 1 | `validate-schemas.py` valid and invalid samples |
| 7.4 | Canonical mapping | 6 | `mapping_test.go` fixtures |
| 7.5 | UUIDv5 identity | 6 | `identity_test.go` |
| 7.6 | At-least-once ingest, dead letters, backoff | 7 | `normalizer_test.go`, `backoff_test.go`; acceptance A9, A10 |
| 8.1 | Collector Kafka exporter, `otlp_json`, batch/queue/retry; protocol version proof | 3 | `rpk-consume-bounded.test.mjs`; Task 3 delivery proof |
| 8.2 | Topics incl. dead-letter and incidents | 3 | `rpk topic list`; `redpanda-init` |
| 8.3 | Dead-letter payload | 1, 7 | Schema sample; `normalizer_test.go` |
| 8.4 | Deployment payload | 10 | Deploy test (`buildDeploymentEvent`) |
| 8.5 | Incident payload; at-least-once guarantee | 8 | `publisher_test.go` (payload, key, duplicate-on-crash); acceptance A7, B3, C5 |
| 9 | ClickHouse schema, revisioned incidents, migrations, FINAL | 5 | `migrate_test.go`, fake revisions test, integration test |
| 10.1 | Detection rule | 8 | `rule_test.go` (every rejection branch) |
| 10.2 | Correlator cycle | 8, 9 | `correlator_test.go`; acceptance A8 |
| 11 | Dedup key, window, stable ID | 8 | `dedup_test.go`; acceptance A8 |
| 12.1 | Incident fields; revision 1 pending | 8 | `correlator_test.go` (fields) |
| 12.2 | Four evidence rows; repair; publisher waits for four | 8 | `correlator_test.go` (repair); `publisher_test.go` (incomplete evidence); acceptance A6 |
| 12.3 | Topic init and Compose dependencies | 3, 9 | Task 3 check; Task 9 precondition |
| 12.4 | Durable publication: pending → published, retries, crash recovery, test hooks | 5, 8, 9 | `publisher_test.go` (success, produce failure, mark failure, crash restart, hook); `config_test.go`; acceptance B and C |
| 13.1 | Contract and unit checks | 1, 2, 5, 6, 7, 8, 9 | Each task's tests |
| 13.2 | Scenario A steps 1–10; scenarios B and C; restore | 11 | Acceptance script |
| 13.3 | Polling deadlines | 11 | Named timeouts in script |
| 13.4 | Two consecutive runs; teardown | 11, 12 | Task 11 verification; Task 12 steps 8–10 |
| 16 | Docker-only Go workflow; pinned builder | 4 | `go-in-docker.test.mjs`; image build |
| 17 | Deployment mechanism | 10 | Deploy test; live deploy |
| 18 | Error handling | 7, 8, 9, 10, 11 | Owning tests listed in those tasks |

## 11. Self-review

- **Spec coverage:** every row of spec sections 6–18 maps to a task and a test in section 10,
  including the new publication requirements (12.4) and the order-to-trace identity (7.2, A4).
- **Task count:** the plan has twelve tasks: contract, Payments, Collector and Redpanda, Go workflow,
  store, canonical mapping, normalizer, correlator and publisher, wiring, deployment script, acceptance
  script, and documentation and final validation.
- **Interfaces:** `IncidentRow` (with `Revision`, `PublicationState`, `PublishedAt`), the `Store`
  methods (`PendingIncidents`, `MarkIncidentPublished`, `EvidenceCount`, `InsertEvidence`,
  `InsertIncidentWithEvidence`, `LatestEvaluatedUntil`), `Correlator` (no producer), `Publisher`
  (with test hooks), and the config test-hook names are defined once (section 7) and used unchanged
  in Tasks 5, 8, 9, and 11.
- **Test ownership:** each behavior has an owning test. Publication recovery (failed produce, failed
  state write, crash between produce and state write, restart) is covered by unit tests in Task 8 and
  by acceptance Scenarios B and C.
- **Error handling:** section 8 lists every condition with its outcome; the publisher rows match spec
  12.4 and section 18.
- **Protocol version:** `2.0.0` is consistent in the spec (section 8.1) and the plan (section 3); it is
  described as an explicit compatibility choice verified by Task 3, not as a documented requirement.
- **Scope:** no dashboard, agent, approval, replay, retention, or second detection scenario is added.
  The test hooks are documented as acceptance-only and default off.
- **Placeholder language:** none. Every version, digest, command, threshold, reason string, and
  interface name is fixed in sections 3, 7, and 8, and each task references them by name.
- **Order-identity limitation:** the acceptance assertion proves that the three triggering traces are the
  traces of the three submitted orders. The detection rule remains deployment- and time-window-based
  (spec 4 and 10.1), so it does not depend on order identity.
