// ClickHouse read queries for the dashboard, from docs/specs/2026-10-06-incident-dashboard.md, section 5.2.
// Every external value is a typed named parameter ({name:Type}). The strings are constants: no interpolation,
// no concatenation, and no value from a request is ever placed in SQL text. All incident and evidence reads use
// FINAL, as the correlator does.

// The incident columns Q1 and Q2 select. Kept for reference and tests. Each query repeats this list literally,
// because a query must not be built by interpolation.
export const INCIDENT_COLUMNS = `incident_id, revision, title, status, severity, service, environment, deployment_id,
trigger_rule, started_at, detected_at, publication_state, published_at`;

// Parameter types, by query. A route must supply exactly these.
export interface QueryParams {
  Q1: { limit: number };
  Q2: { incident_id: string };
  Q3: { incident_id: string };
  Q4: { deployment_id: string };
  Q5: { limit: number };
  Q6: { deployment_ids: string[] };
  Q7: { deployment_ids: string[] };
  Q8: { incident_id: string };
  Q9: { incident_ids: string[] };
}

export type QueryName = keyof QueryParams;

export const QUERIES = Object.freeze({
  // Incident list, newest first.
  Q1: `SELECT incident_id, revision, title, status, severity, service, environment, deployment_id,
trigger_rule, started_at, detected_at, publication_state, published_at
FROM incidents FINAL
ORDER BY detected_at DESC
LIMIT {limit:UInt32}`,

  // One incident, by ID.
  Q2: `SELECT incident_id, revision, title, status, severity, service, environment, deployment_id,
trigger_rule, started_at, detected_at, publication_state, published_at
FROM incidents FINAL
WHERE incident_id = {incident_id:UUID}`,

  // Evidence rows for one incident.
  Q3: `SELECT evidence_id, source_type, source_ref, timestamp, service, summary, reliability
FROM evidence_items FINAL
WHERE incident_id = {incident_id:UUID}
ORDER BY timestamp, source_type, source_ref`,

  // The deployment row with a given ID. The incident stores this ID as a String, so the comparison casts the UUID.
  Q4: `SELECT deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status
FROM deployments FINAL
WHERE toString(deployment_id) = {deployment_id:String}`,

  // Recent Payments deployments, newest first.
  Q5: `SELECT deployment_id, timestamp, environment, new_version, previous_version, status
FROM deployments FINAL
WHERE service = 'demo-payments'
ORDER BY timestamp DESC
LIMIT {limit:UInt32}`,

  // Distinct failing traces per deployment. The inner filter is the correlator's failure rule
  // (failureTracesSQL in services/collector-go/internal/store/clickhouse.go).
  Q6: `SELECT deployment_id, uniqExact(trace_id) AS failing_traces
FROM (
SELECT trace_id, deployment_id
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments'
AND JSONExtractString(attributes, 'span.kind') = 'server'
AND deployment_id != ''
AND JSONExtractInt(attributes, 'http.response.status_code') = 500
GROUP BY trace_id, deployment_id
)
WHERE deployment_id IN {deployment_ids:Array(String)}
GROUP BY deployment_id`,

  // Incidents linked to a set of deployments.
  Q7: `SELECT incident_id, deployment_id, started_at
FROM incidents FINAL
WHERE deployment_id IN {deployment_ids:Array(String)}`,

  // The latest diagnosis for one incident, from docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 9.1.
  // At most one row: the highest diagnosis_version. The caller validates the document before it is shown.
  Q8: `SELECT diagnosis_version, status, confidence, failure_code, document, created_at
FROM diagnoses FINAL
WHERE incident_id = {incident_id:UUID}
ORDER BY diagnosis_version DESC
LIMIT 1`,

  // The latest diagnosis summary for each incident in a list page: one row per incident, no document. The caller
  // passes at most 100 IDs (the incident-list cap), so the result has at most 100 rows.
  Q9: `SELECT incident_id, diagnosis_version, status, confidence
FROM diagnoses FINAL
WHERE incident_id IN {incident_ids:Array(UUID)}
ORDER BY diagnosis_version DESC
LIMIT 1 BY incident_id`,
} satisfies Record<QueryName, string>);
