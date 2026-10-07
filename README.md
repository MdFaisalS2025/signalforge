# SignalForge

AI incident response and observability platform: turns raw operational telemetry
into evidence-linked incident diagnoses and safe, human-approved remediation
workflows.

**Status: Orders → Payments observability slice, the faulty-deployment incident-correlation
slice, and the incident dashboard implemented.** Two demo services (`demo-orders`, `demo-payments`) run in Docker Compose and
export traces, metrics, and logs over OTLP/HTTP to the OpenTelemetry Collector. A faulty payments
deployment now produces one persisted, evidence-linked incident (see
[Faulty deployment incident correlation](#faulty-deployment-incident-correlation)), and a read-only
dashboard at `http://localhost:3000` (bound to localhost only) shows it. The agent, the API, and
remediation are still placeholder scaffolding. The overall plan is in
[`SignalForge_Project_Plan.docx`](SignalForge_Project_Plan.docx).

## Problem and user workflow

Incident response is fragmented across dashboards, trace explorers, deploy
histories, and runbooks. SignalForge correlates telemetry into an incident
timeline, retrieves relevant operational knowledge, and produces a structured,
evidence-cited diagnosis. It recommends a remediation but never executes an
impactful action without explicit human approval. Every incident scenario can be
replayed to measure whether future changes improve or regress diagnostic quality.

See the full plan for problem framing, target users, architecture, and the
8-week MVP delivery schedule.

## Non-goals (MVP)

- Replacing a commercial observability suite or supporting unrestricted production
  workloads.
- Executing arbitrary shell commands, database writes, or infrastructure changes.
- Training a foundation model or building a general-purpose autonomous SRE agent.
- Multiple cloud providers, enterprise tenancy, or high availability in the first
  release.
- Live customer data — all demo telemetry and runbooks are synthetic or
  project-owned.

## Definition of done (MVP)

See section 20 of the project plan. In short: three demo services emitting
correlated OpenTelemetry data; Redpanda, ClickHouse, Temporal, the Go and Python
services, and the dashboard running together via Docker Compose; each required
failure scenario producing a correlated incident with cited evidence; every
remediation allowlisted, reversible, and blocked until human approval; replay
evaluation measuring correctness, evidence relevance, false positives, safety
refusal, and latency; automated tests and CI passing; and documentation a
stranger can follow without private guidance.

## Repository structure

```
apps/
  web/                # Next.js operator dashboard
services/
  api/                # Operator API / backend-for-frontend
  collector-go/       # Normalization and correlation (Go)
  agent-python/       # Retrieval, diagnosis, validation (Python)
  remediation/        # Allowlisted action executor
  demo-orders/        # Instrumented sample service
  demo-payments/
  demo-inventory/
contracts/
  events/             # JSON Schema event contracts + samples
  api/
workflows/
  temporal/           # Workflow and activity definitions
runbooks/              # Versioned operational knowledge (synthetic)
evals/
  scenarios/          # Fault manifests and expected results
  graders/
  reports/            # Generated scorecards (gitignored)
infra/
  docker/             # Local Compose environment
  kubernetes/         # Production extension (not in MVP)
  helm/
  terraform/
observability/
  otel-collector/
  prometheus/
  grafana/
docs/
  architecture/
  decisions/          # Architecture decision records
  demo/
scripts/               # Setup, reset, replay, validation
```

## Prerequisites

- Docker with Compose v2 (`docker compose version`). Docker Desktop must be
  running; `docker compose` cannot reach the engine otherwise.
- Node.js 24 and npm, to build and test the services on the host.
- Python 3 (`python`), for schema validation.

## Quick start: Orders → Payments slice

Start only the services this slice needs:

```bash
docker compose -f infra/docker/docker-compose.yml up -d demo-orders demo-payments otel-collector
```

Wait until `demo-orders` and `demo-payments` report `healthy`:

```bash
docker compose -f infra/docker/docker-compose.yml ps
```

Stop the stack when you are done:

```bash
docker compose -f infra/docker/docker-compose.yml down
```

Running `docker compose ... up -d` without service names starts every service in the
file. Redpanda, ClickHouse, Temporal, Prometheus, and Grafana are real images that
the slice does not use. `agent-python`, `remediation`, `api`, and `demo-inventory` are
placeholder containers (`sleep infinity`).

## Endpoints

| Service | Host URL | Notes |
|---|---|---|
| `demo-orders` | `http://localhost:8081` | `POST /orders`, `GET /health` |
| `demo-payments` | `http://localhost:8082` | `POST /payments/charge`, `GET /health` (called only by Orders) |
| Temporal UI | `http://localhost:8084` | Host port moved from 8081 to avoid the Orders port. Not exercised by this slice. |
| OTLP/HTTP receiver | `http://localhost:4318` | Collector; traces at `/v1/traces`, metrics at `/v1/metrics`, logs at `/v1/logs` |

## Place an order

Send a valid request with a UUID `order_id`:

```bash
curl -X POST http://localhost:8081/orders -H "Content-Type: application/json" -d '{"order_id":"11111111-2222-4333-8444-555555555555","item":"widget","amount_cents":500}'
```

PowerShell equivalent:

```powershell
$body = @{ order_id = '11111111-2222-4333-8444-555555555556'; item = 'widget'; amount_cents = 500 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:8081/orders' -ContentType 'application/json' -Body $body
```

On success the response is HTTP `201`:

```json
{"order_id":"11111111-2222-4333-8444-555555555555","status":"created","payment_status":"approved"}
```

Invalid input returns HTTP `400` with `{"error":"invalid_request","message":"..."}`
(for example, a malformed `order_id` or a non-positive `amount_cents`).

## Observability

Both services export all three signals to the Collector over OTLP/HTTP:

- **Traces:** one trace per order, containing the Orders inbound server span,
  the Orders outbound client span to Payments, and the Payments inbound server span,
  in that parent-child order.
- **Metrics:** `http_requests_total` and `http_request_duration_seconds`, labelled
  with `route`, `method`, and `status_code`. Order IDs and trace IDs are never metric labels.
- **Logs:** structured JSON lines on stdout (`request received`,
  `request completed`, `payment failed`), each carrying `order_id`, `trace_id`, and
  `span_id`. The same records are also exported to the Collector as OTLP log records.

The Collector's `debug` exporter prints everything it receives at `detailed` verbosity:

```bash
docker compose -f infra/docker/docker-compose.yml logs otel-collector
```

## Verify the slice

Run the bootstrap-order check first. It builds nothing itself, so build
`demo-orders` first. It starts its own disposable Payments stub and Orders process,
so it does not need the Compose stack:

```bash
npm --prefix services/demo-orders run build
node scripts/verify-bootstrap-order.mjs
```

It passes when a valid, non-zero `traceparent` reaches the Payments stub and the
Orders stdout log line for the request carries a `trace_id` matching it.

The full acceptance script needs the stack from the Quick start running (all three
services healthy). It sends a successful order and checks the three-span trace,
the OTLP logs from both services, and the `http_requests_total` metric from both.
Then it runs the failure demonstration below:

```bash
node scripts/verify-orders-payments-slice.mjs
```

Each run uses fresh order IDs and only considers logs and Collector output
written after the test starts, so repeated runs do not depend on earlier output.
The script restarts `demo-payments` even if an assertion fails. On failure it prints
the Orders, Payments, and Collector logs for the failing test's time window.

## Failure demonstration (Payments unavailable)

To see the failure path by hand:

```bash
docker compose -f infra/docker/docker-compose.yml stop demo-payments
```

Send an order with a new UUID `order_id` as shown above. Orders returns HTTP `502`:

```json
{"order_id":"<your-order-id>","status":"failed","reason":"payment_unavailable"}
```

In the trace for that request, the Orders server span has status `Error` with the
message `payment unavailable`, and exactly one outbound attempt to Payments is recorded.
The Orders logs contain a `payment failed` error record for the same trace.

Restore the service and wait for it to become healthy:

```bash
docker compose -f infra/docker/docker-compose.yml start demo-payments
docker compose -f infra/docker/docker-compose.yml ps
```

## Faulty deployment incident correlation

This slice runs a faulty `demo-payments` deployment and produces one incident linked to its evidence.
The pipeline is demo services → OpenTelemetry Collector → Redpanda (`telemetry.raw.v1`) → Go normalizer
(`collector-go`) → ClickHouse → Go correlator and publisher (`collector-go`) → Redpanda
(`incidents.created.v1`). The decision and its limits are recorded in
[ADR 0004](docs/decisions/0004-faulty-deployment-correlation.md).

Start the slice:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build redpanda redpanda-init clickhouse otel-collector collector-go demo-orders demo-payments
```

Deploy a faulty version. This recreates `demo-payments` with fault mode enabled, waits until it is
healthy, and publishes a succeeded event to `deployments.v1`. It prints `deployment_id=<uuid>`:

```bash
node scripts/deploy-payments.mjs --version 0.2.0-faulty --fault enabled
```

Run the acceptance check. It deploys faulty versions, sends orders, and checks ClickHouse and Kafka. It
prints the deployment and incident IDs and `PASS`, and it restores `demo-payments` to version `0.1.0` when
it finishes:

```bash
node scripts/verify-faulty-deployment-incident.mjs
```

Go runs only through Docker. No Go toolchain is needed on the host:

```bash
node scripts/go-in-docker.mjs go test ./...
```

### Topics

| Topic | Produced by | Consumed by |
|---|---|---|
| `telemetry.raw.v1` | OpenTelemetry Collector (OTLP/JSON) | `collector-go` normalizer |
| `deployments.v1` | `scripts/deploy-payments.mjs` | `collector-go` normalizer |
| `telemetry.dead-letter.v1` | `collector-go` normalizer, for invalid or unexpected records | Nothing in this slice |
| `incidents.created.v1` | `collector-go` publisher, keyed by `incident_id` | Nothing in this slice; the acceptance script reads it |

### Acceptance-only hooks

Two environment variables exist only for the acceptance script. Both default to off, and the
Compose file reads them from `.env` (see `.env.example`). Setting either one makes `collector-go`
fail on purpose, so leave both at `0` for normal use.

- `INCIDENT_PUBLISH_FAIL_ATTEMPTS` (default `0`): the first N attempted incident publications fail
  before Kafka is called.
- `INCIDENT_CRASH_AFTER_PRODUCE` (default `0`; `1` enables it): the process exits after a successful
  incident produce and before it records the incident as published.

### Delivery guarantee

- Each incident is persisted once. There is exactly one latest incident for a burst, with exactly four
  evidence rows: one for the deployment and one for each of the three triggering traces.
- Incident messages are delivered at least once. A crash after a successful produce can publish the same
  message again after restart, with the same `incident_id` as its key. Consumers must tolerate that
  duplicate.
- On the healthy path, one message is produced per incident.

### Limits

- A single `collector-go` instance is supported. Two instances would both evaluate the same windows.
- Nothing is retained or expired. ClickHouse tables and Redpanda topics grow without limit.
- The Compose file publishes Redpanda's Kafka port `9092` to the host. This is a local-development
  exposure, not a production setting.
- No consumer acts on `incidents.created.v1` in this slice.
- The 30-second burst window and the five-minute windows assume the containers share a clock.
- This is a local demo. It has no authentication, TLS, backups, or monitoring, and it is not a cloud
  or production deployment. Exactly-once Kafka delivery is not claimed.

## Faulty deployment dashboard

A read-only dashboard at `http://localhost:3000` (published on `127.0.0.1` only, because it has no authentication) shows the incidents the correlator created, the
deployment each one is linked to, its four evidence items, and a timeline of recent Payments
deployments. The design is in
[docs/specs/2026-10-06-incident-dashboard.md](docs/specs/2026-10-06-incident-dashboard.md).

The dashboard is read-only. The browser never talks to ClickHouse: the Next.js server reads it through a
server-side layer that uses a read-only ClickHouse account (`dashboard_reader`). Demo data stays in the
ClickHouse volumes, so incidents from earlier runs remain until you deliberately remove those volumes.
`docker compose down` without `-v` keeps them.

Run these from the repository root, in order.

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

Running the demo twice on the same stack creates a second deployment and a second incident, because
deduplication is keyed by deployment. The new incident has the same shape as the first.

**Teardown** keeps volumes:

```bash
docker compose -f infra/docker/docker-compose.yml down
```

### Dashboard acceptance

With the stack running and at least one incident present, run the dashboard acceptance check:

```bash
node scripts/verify-incident-dashboard.mjs
```

It is read-only and finishes within 60 seconds. It prints one line per check and exits `0` only if all pass.
It checks health, the incident list, the newest incident's four evidence rows, the faulty deployment
classification, that `POST`, `PUT`, `PATCH`, and `DELETE` are refused, that the reader account cannot write,
that the incidents page renders, and that no response leaks SQL or driver errors. To also compare the
evidence with known trace IDs, add `--expected-traces <id>,<id>,<id>`.

## Scope and limits

This is a local demo of observability for one synchronous request path, not a
production deployment. Specifically:

- Orders calls Payments once per request. There are no retries, circuit breakers,
  or timeouts beyond the 3-second client timeout (`PAYMENTS_TIMEOUT_MS`).
- Payments always approves a valid charge. It has no failure branch, so the only
  failure the demo produces is Payments being stopped.
- There is no authentication, persistence, or message queue in this slice. Orders
  and Payments hold no state.
- Telemetry goes to a Collector that prints it. Nothing stores or queries traces,
  metrics, or logs yet.
- There is no production deployment, Kubernetes, or cloud configuration.

## Validation

Run the schema validator (no containers needed):

```bash
python scripts/validate-schemas.py
```

Validate the Compose file:

```bash
docker compose -f infra/docker/docker-compose.yml config --quiet
```

Run the unit tests and type checks for each service:

```bash
npm --prefix services/demo-orders test
npm --prefix services/demo-orders run typecheck
npm --prefix services/demo-payments test
npm --prefix services/demo-payments run typecheck
```

## Event contracts

Normalized event and entity schemas live in `contracts/events/*.schema.json`,
with one matching sample under `contracts/events/samples/`. Schemas follow the
field conventions in plan section 10.2: UTC timestamps, globally unique
identifiers, an explicit `schema_version`, and no secrets or raw credentials.

## Architecture decisions

See `docs/decisions/`. Each ADR links back to the project plan section it
implements or deviates from.

## Roadmap

The full 8-week MVP delivery plan and the post-MVP production extension roadmap
(Kubernetes, Helm, Terraform, CI/CD, RBAC) are in `SignalForge_Project_Plan.docx`,
sections 17 and 18.
