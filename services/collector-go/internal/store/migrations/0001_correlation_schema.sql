CREATE TABLE IF NOT EXISTS schema_migrations (
    version UInt32,
    name String,
    applied_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY version
-- statement-break
CREATE TABLE IF NOT EXISTS telemetry_events (
    event_id UUID,
    schema_version String,
    timestamp DateTime64(9, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    type LowCardinality(String),
    service LowCardinality(String),
    service_version String,
    environment LowCardinality(String),
    deployment_id String,
    trace_id String,
    span_id String,
    severity LowCardinality(String),
    attributes String
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY event_id
-- statement-break
CREATE TABLE IF NOT EXISTS deployments (
    deployment_id UUID,
    timestamp DateTime64(9, 'UTC'),
    service LowCardinality(String),
    environment LowCardinality(String),
    new_version String,
    previous_version String,
    initiated_by String,
    status LowCardinality(String),
    ingested_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY deployment_id
-- statement-break
CREATE TABLE IF NOT EXISTS incidents (
    incident_id UUID,
    revision UInt64,
    dedup_key String,
    environment LowCardinality(String),
    service LowCardinality(String),
    deployment_id String,
    trigger_rule String,
    title String,
    status LowCardinality(String),
    severity LowCardinality(String),
    started_at DateTime64(9, 'UTC'),
    detected_at DateTime64(9, 'UTC'),
    services Array(String),
    publication_state LowCardinality(String),
    published_at Nullable(DateTime64(9, 'UTC'))
) ENGINE = ReplacingMergeTree(revision)
ORDER BY incident_id
-- statement-break
CREATE TABLE IF NOT EXISTS evidence_items (
    evidence_id UUID,
    incident_id UUID,
    source_type LowCardinality(String),
    source_ref String,
    timestamp DateTime64(9, 'UTC'),
    service LowCardinality(String),
    summary String,
    reliability LowCardinality(String),
    ingested_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY evidence_id
-- statement-break
CREATE TABLE IF NOT EXISTS correlation_runs (
    run_id UUID,
    evaluated_until DateTime64(9, 'UTC'),
    created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY evaluated_until
