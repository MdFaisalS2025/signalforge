# collector-go

Go service that runs as one local Compose process. It normalizes telemetry and deployment events from
Redpanda into ClickHouse, correlates payment failure bursts after a deployment into incidents, and
publishes each incident durably to `incidents.created.v1`. The normalizer, correlator, and publisher
share the process, so one Compose service owns all three.

## Run

The Compose service builds from this directory and starts after `redpanda-init` completes and
ClickHouse is healthy. It migrates the schema on start (`migrations applied`, with the count of
migrations this start applied), then runs until it is stopped.

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build collector-go
docker compose -f infra/docker/docker-compose.yml logs collector-go
```

Logs are JSON on stdout. The event names are fixed: `migrations applied`, `batch processed`,
`dead letter produced`, `incident created`, `incident evidence repaired`, `incident suppressed`,
`incident published`, `publish failed`, `publish state write failed`, and `cycle failed`.

A normalizer failure exits the process with status 1. Correlator and publisher cycle failures are
logged as `cycle failed` and the process keeps running.

## Acceptance-only hooks

Two environment variables exist only for the acceptance script. Both default off, and the Compose
file passes them through from `.env` (see `.env.example`).

- `INCIDENT_PUBLISH_FAIL_ATTEMPTS` (non-negative integer, default `0`): the first N attempted incident
  produces fail without calling Kafka. The budget persists across cycles in one process.
- `INCIDENT_CRASH_AFTER_PRODUCE` (`0` or `1`, default `0`): when `1`, the process exits with status 1 after a successful produce and before the state write. The restarted process
  publishes the same incident again, so downstream consumers see at-least-once delivery.

Any other value is rejected at startup with an exact error:
`INCIDENT_PUBLISH_FAIL_ATTEMPTS must be a non-negative integer` or
`INCIDENT_CRASH_AFTER_PRODUCE must be 0 or 1`.

## Packages

- `internal/config`: reads settings from the environment through a lookup function. It is pure.
- `internal/store`: ClickHouse schema, idempotent migrations (`MigrateUpWithCount`), and the
  revisioned store. Incident revisions and evidence use `ReplacingMergeTree` with `FINAL` reads.
- `internal/canonical`: maps OTLP/JSON to canonical records with UUIDv5 identities.
- `internal/ingest`: normalizer with bounded retry, dead letters, and offset commits only after every
  required write succeeds. Kafka adapters use franz-go with auto-commit disabled.
- `internal/correlate`: detection rule, dedup, and the correlator cycle. Never publishes.
- `internal/publish`: the durable publisher. Publishes only incidents with four evidence rows, and
  marks them published only after a successful produce.

## Tests

```bash
node scripts/go-in-docker.mjs go test ./...
node scripts/go-in-docker.mjs go vet ./...
```

The ClickHouse integration tests are skipped unless `CLICKHOUSE_HOST` is set. Run them against the
Compose stack through the Docker network:

```bash
node scripts/go-in-docker.mjs --network signalforge_default --env CLICKHOUSE_HOST=clickhouse --env CLICKHOUSE_PORT=9000 --env CLICKHOUSE_DB=signalforge --env CLICKHOUSE_USER=default --env CLICKHOUSE_PASSWORD=changeme-local-only go test ./internal/store/... -run Integration
```

Go runs only in Docker through `scripts/go-in-docker.mjs`. No Go toolchain is needed on the host.
