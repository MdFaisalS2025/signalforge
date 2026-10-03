# SignalForge

AI incident response and observability platform: turns raw operational telemetry
into evidence-linked incident diagnoses and safe, human-approved remediation
workflows.

**Status: Orders → Payments observability slice implemented.** Two demo services
(`demo-orders`, `demo-payments`) run in Docker Compose and export traces, metrics,
and logs over OTLP/HTTP to the OpenTelemetry Collector. The rest of the platform
(incident correlation, the agent, the dashboard, and remediation) is still
placeholder scaffolding. The overall plan is in
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
the slice does not use. `collector-go`, `agent-python`, `remediation`, `api`, `web`,
and `demo-inventory` are placeholder containers (`sleep infinity`).

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
