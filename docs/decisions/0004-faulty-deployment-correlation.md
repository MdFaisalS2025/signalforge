# 4. Faulty-deployment incident correlation

## Status
Accepted

## Context
The plan's first correlation slice (plan section 9.5) needs one end-to-end path that
turns real telemetry into a persisted, evidence-linked incident. The chosen scenario is
a bad payments deployment: after `demo-payments` is deployed with fault mode enabled,
requests start failing with HTTP 500. The slice must show that the failures are
linked to that deployment, persisted once, and published for downstream consumers,
and that it survives publication failures and a process crash. The design is in
`docs/specs/2026-10-03-faulty-deployment-incident-correlation.md`, and the step plan is
in `docs/plans/2026-10-03-faulty-deployment-incident-correlation-implementation.md`.

## Decision

### Pipeline
Demo services → OpenTelemetry Collector → Redpanda (`telemetry.raw.v1`) → Go normalizer →
ClickHouse → Go correlator and publisher → Redpanda (`incidents.created.v1`).

Deployments enter through the script `scripts/deploy-payments.mjs`, which publishes to
`deployments.v1`. The service also reports the deployment identity itself: the
`deployment.id`, `service.version`, and `deployment.environment.name` resource attributes
are set from environment variables when `demo-payments` starts. This is service-side
enrichment, so telemetry carries its deployment without a join against a separate
deployment record.

### Pinned choices
- Go 1.27.1 in `services/collector-go`, built from the digest-pinned image
  `golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414`.
  Go runs only in Docker, through `scripts/go-in-docker.mjs`.
- franz-go `v1.22.1` for Kafka (with `kmsg` `v1.14.0`), with auto-commit disabled.
- clickhouse-go/v2 `v2.48.0` for the ClickHouse native protocol (port 9000).
- The Collector's Kafka exporter uses `protocol_version: 2.0.0` and `encoding: otlp_json`.
  The OTLP/JSON shape the normalizer reads is therefore tied to Collector image 0.108.0.

### ClickHouse as the correlator input
The correlator reads canonical records from ClickHouse, not from a normalized Kafka
topic. Each cycle queries `telemetry_events` and `deployments` with `FINAL`, over a
10-minute lookback. ClickHouse is already the system of record, so a second normalized
topic would add a copy with no consumer. The cost is that correlation runs against a
store that must stay queryable, which is acceptable for a single local instance.

### One collector process
One process, `collector-go`, runs the normalizer, the correlator, and the publisher.
They share one store and one configuration, and their order of work is fixed. The
process starts after `redpanda-init` completes and after ClickHouse is healthy.

### Deterministic identity and revisioned state
- Canonical event IDs and deployment-linked evidence IDs are UUIDv5 values in a fixed
  namespace. The key for a trace is `trace|<trace_id>|<span_id>`. The incident ID is
  `UUIDv5(dedup_key|<start nanoseconds>)`, and evidence IDs are
  `UUIDv5(incident_id|<source_ref>)`. Re-running the same burst yields the same IDs.
- `incidents` is a `ReplacingMergeTree(revision)`. Each change is a new revision row,
  so state never updates in place.
- Publication state moves `pending → published`. A pending revision has
  `publication_state = 'pending'` and `published_at = NULL`. The publish timestamp is
  non-null only in the published revision.

### Delivery guarantee
- **Persisted:** exactly one latest incident per dedup key, and exactly four evidence
  rows (one deployment row and three trigger-trace rows). Repeated evidence inserts
  replace themselves by ID.
- **Published:** at-least-once, keyed by `incident_id`. The publisher produces, then
  records `published`. If the process stops between those two steps, the next start
  produces the same payload again. Consumers must therefore tolerate a duplicate.
- **Healthy path:** one message per incident.

### Acceptance-only hooks
Two environment variables exist only for the acceptance script. Both default to off.
- `INCIDENT_PUBLISH_FAIL_ATTEMPTS` (non-negative integer, default `0`): the first N
  attempted produces fail without calling Kafka.
- `INCIDENT_CRASH_AFTER_PRODUCE` (`0` or `1`, default `0`): when `1`, the process exits
  with status 1 after a successful produce and before recording `published`.

### Detection rule
Three distinct `demo-payments` server spans with HTTP 500, each carrying a deployment ID,
within 30 seconds, after a succeeded deployment. The first triggering failure must be no
more than five minutes after the deployment. A repeated trace ID counts once, at its
earliest timestamp. A second candidate for the same deployment and rule is suppressed
when an existing incident started within the five minutes before it (the dedup window).

## Consequences

### Benefits
- The whole path is observable and testable locally, and each stage has a bounded
  retry or an explicit failure path.
- Replays are safe: IDs are deterministic and state is revisioned, so re-running a
  stage does not create duplicate persisted rows.

### Limits
- **Single instance only.** There is no leader election, so two correlator processes
  would both evaluate the same window. The dedup check and deterministic IDs prevent
  duplicate incident rows, but not duplicate work.
- **No retention or TTL.** ClickHouse tables and Redpanda topics grow without bound.
- **Host exposure (local development only).** The current Compose file publishes Redpanda's
  Kafka port `9092` to the host, so the host can produce to and read these topics directly.
  The pipeline does not need this. It is a local-development convenience that should not be
  carried into any shared or production deployment.
- **No consumer for incidents.** `incidents.created.v1` has no consumer in this slice. The
  acceptance script reads it bounded, and nothing downstream acts on it yet.
- **Clock assumption.** The windows use event timestamps from containers on one host,
  which are assumed to share a clock. Clock skew between the services would move the
  30-second and five-minute windows.
- **Not production.** The slice has no authentication, no TLS, no backup, and no
  monitoring of the collector process. It makes no cloud or production claim.
- **Exactly-once is not claimed.** Kafka delivery of incidents is at-least-once, as above.
