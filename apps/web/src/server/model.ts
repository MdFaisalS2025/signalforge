// Pure rules and mapping for the dashboard API. No I/O, no clock, no environment, no framework types.
// Input rows are the ClickHouse row types from clickhouse.ts. Output shapes are the API shapes in
// docs/specs/2026-10-06-incident-dashboard.md, section 5.4.
import type { DeploymentRow, EvidenceRow, IncidentRow, RecentDeploymentRow } from './clickhouse';

export type DeploymentClass = 'healthy' | 'faulty' | 'unknown';

export interface Classification {
  class: DeploymentClass;
  label: string;
}

export interface IncidentItem {
  incident_id: string;
  revision: number;
  title: string;
  status: string;
  severity: string;
  service: string;
  environment: string;
  deployment_id: string;
  deployment_version: string | null;
  trigger_rule: string;
  started_at: string;
  detected_at: string;
  publication_state: string;
  published_at: string | null;
}

export interface DeploymentItem {
  deployment_id: string;
  timestamp: string;
  environment: string;
  new_version: string;
  status: string;
  class: DeploymentClass;
  failing_traces: number;
  incident_ids: string[];
}

export interface DeploymentDetail {
  deployment_id: string;
  timestamp: string;
  environment: string;
  new_version: string;
  previous_version: string | null;
  initiated_by: string;
  status: string;
}

export interface EvidenceItem {
  evidence_id: string;
  source_type: string;
  source_ref: string;
  timestamp: string;
  service: string;
  summary: string;
  reliability: string;
}

const TRIGGER_RULE = 'payments-5xx-burst-after-deployment';

// ClickHouse's DateTime64(9) text form, with all nine fractional digits.
const CLICKHOUSE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{9})$/;

// Converts "2026-10-03 12:00:00.000000000" to "2026-10-03T12:00:00.000000000Z". The text is rewritten, not parsed
// into a Date, so nanoseconds are never truncated or rounded.
export function toApiTimestamp(value: string): string {
  const match = CLICKHOUSE_TIMESTAMP.exec(value);
  if (!match) throw new TypeError('unexpected ClickHouse timestamp format');
  return `${match[1]}T${match[2]}.${match[3]}Z`;
}

function toApiTimestampOrNull(value: string | null): string | null {
  return value === null ? null : toApiTimestamp(value);
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

// classifyDeployment applies spec 5.3. A deployment is healthy only when it succeeded and no failure or incident
// was recorded. "No failures observed" is the label for that case. It does not claim that traffic was served.
export function classifyDeployment(input: {
  status: string;
  failingTraces: number;
  incidentCount: number;
}): Classification {
  assertCount(input.failingTraces, 'failingTraces');
  assertCount(input.incidentCount, 'incidentCount');
  if (input.status !== 'succeeded') {
    return { class: 'unknown', label: input.status };
  }
  if (input.failingTraces > 0) {
    return { class: 'faulty', label: `Faulty: ${input.failingTraces} HTTP 500 traces` };
  }
  if (input.incidentCount > 0) {
    return { class: 'faulty', label: 'Linked to an incident' };
  }
  return { class: 'healthy', label: 'No failures observed' };
}

// explainIncident returns the fixed sentence for the known rule, filled from the incident's own fields. The version
// is left out when no matching deployment was found, rather than guessed. An unknown rule gets the raw name and a
// fixed fallback sentence.
export function explainIncident(input: {
  trigger_rule: string;
  started_at: string;
  deployment_id: string;
  deployment_version: string | null;
}): string {
  if (input.trigger_rule !== TRIGGER_RULE) {
    return `${input.trigger_rule}. No explanation template for this rule.`;
  }
  const deployment =
    input.deployment_version === null ? input.deployment_id : `${input.deployment_id}, ${input.deployment_version}`;
  return `Three distinct Payments 5xx traces within 30 seconds after this deployment (${deployment}). The first trace was at ${input.started_at}.`;
}

export function toIncidentItem(row: IncidentRow, deploymentVersion: string | null): IncidentItem {
  if (!/^\d+$/.test(row.revision)) {
    throw new TypeError('revision must be a non-negative integer');
  }
  const published = row.publication_state === 'published';
  return {
    incident_id: row.incident_id,
    revision: Number(row.revision),
    title: row.title,
    status: row.status,
    severity: row.severity,
    service: row.service,
    environment: row.environment,
    deployment_id: row.deployment_id,
    deployment_version: deploymentVersion,
    trigger_rule: row.trigger_rule,
    started_at: toApiTimestamp(row.started_at),
    detected_at: toApiTimestamp(row.detected_at),
    publication_state: row.publication_state,
    published_at: published ? toApiTimestampOrNull(row.published_at) : null,
  };
}

// toDeploymentItem builds one row of the deployment timeline. The class comes from classifyDeployment, using the
// failure count and the number of linked incidents.
export function toDeploymentItem(
  row: RecentDeploymentRow,
  failingTraces: number,
  incidentIds: string[],
): DeploymentItem {
  const { class: deploymentClass } = classifyDeployment({
    status: row.status,
    failingTraces,
    incidentCount: incidentIds.length,
  });
  return {
    deployment_id: row.deployment_id,
    timestamp: toApiTimestamp(row.timestamp),
    environment: row.environment,
    new_version: row.new_version,
    status: row.status,
    class: deploymentClass,
    failing_traces: failingTraces,
    incident_ids: incidentIds,
  };
}

// toDeploymentDetail builds the deployment object inside one incident. An empty previous_version is null.
export function toDeploymentDetail(row: DeploymentRow): DeploymentDetail {
  return {
    deployment_id: row.deployment_id,
    timestamp: toApiTimestamp(row.timestamp),
    environment: row.environment,
    new_version: row.new_version,
    previous_version: row.previous_version === '' ? null : row.previous_version,
    initiated_by: row.initiated_by,
    status: row.status,
  };
}

export function toEvidenceItem(row: EvidenceRow): EvidenceItem {
  return {
    evidence_id: row.evidence_id,
    source_type: row.source_type,
    source_ref: row.source_ref,
    timestamp: toApiTimestamp(row.timestamp),
    service: row.service,
    summary: row.summary,
    reliability: row.reliability,
  };
}
