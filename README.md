# SignalForge

AI incident response and observability platform: turns raw operational telemetry
into evidence-linked incident diagnoses and safe, human-approved remediation
workflows.

**Status: Week 1 scaffold.** No services are implemented yet. This repository
currently contains the monorepo skeleton, a Docker Compose base for local
dependencies, event contracts, and architecture decision records, per the Week 1
milestone in [`SignalForge_Project_Plan.docx`](SignalForge_Project_Plan.docx).

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

## Quick start (local dependencies only)

The services above are currently placeholder containers (`sleep infinity`) — this
starts the wiring for Redpanda, ClickHouse, Temporal, the OpenTelemetry Collector,
Prometheus, and Grafana, not a working product yet.

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d
```

Validate the environment file is in place and sample events conform to their
schemas:

```bash
python3 scripts/validate-schemas.py
```

Tear down:

```bash
docker compose -f infra/docker/docker-compose.yml down -v
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
