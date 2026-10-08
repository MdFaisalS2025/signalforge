CREATE TABLE IF NOT EXISTS diagnoses (
    diagnosis_id UUID,
    incident_id UUID,
    diagnosis_version UInt32,
    status LowCardinality(String),
    confidence LowCardinality(String),
    failure_code LowCardinality(String),
    provider LowCardinality(String),
    model_version String,
    prompt_version String,
    analyzer_id String,
    input_digest String,
    document String,
    created_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(created_at)
ORDER BY (incident_id, diagnosis_version)
