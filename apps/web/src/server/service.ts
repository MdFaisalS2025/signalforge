// The read-only dashboard service. It composes the Task 3 validator, the Task 4 repository, and the Task 5 pure
// mappings. It has no writes, no dynamic SQL, and no fallback data. The HTTP helpers at the end turn its outcomes
// into responses, so every route shares one error mapping.
import {
  ClickHouseUnavailable,
  createClickHouseReaderFromEnv,
  type ClickHouseReader,
  type DiagnosisSummaryRow,
} from './clickhouse';
import { parseDiagnosis, UNAVAILABLE, type DiagnosisPayload } from './diagnosis';
import {
  explainIncident,
  toDeploymentDetail,
  toDeploymentItem,
  toDiagnosisSummary,
  toEvidenceItem,
  toIncidentItem,
  UNAVAILABLE_SUMMARY,
  type DeploymentDetail,
  type DeploymentItem,
  type DiagnosisSummary,
  type EvidenceItem,
  type IncidentItem,
  type IncidentListItem,
} from './model';
import { InvalidInput, parseIncidentId, parseLimit } from './validate';

// The requested incident does not exist.
export class IncidentNotFound extends Error {
  constructor() {
    super('incident not found');
    this.name = 'IncidentNotFound';
  }
}

export interface DashboardService {
  listIncidents(rawLimit: unknown): Promise<{ generated_at: string; incidents: IncidentListItem[] }>;
  getIncidentDetail(rawIncidentId: unknown): Promise<{
    generated_at: string;
    incident: IncidentItem;
    explanation: string;
    deployment: DeploymentDetail | null;
    evidence: EvidenceItem[];
    diagnosis: DiagnosisPayload | null;
  }>;
  listDeployments(rawLimit: unknown): Promise<{ generated_at: string; deployments: DeploymentItem[] }>;
}

export interface ServiceDeps {
  repo: ClickHouseReader;
  now: () => Date;
  // Receives one structured entry when the diagnosis cannot be shown. Defaults to a JSON line on stderr.
  log?: (entry: Record<string, unknown>) => void;
}

// Failure counts come back from ClickHouse as quoted 64-bit integers. Anything other than digits is an error.
function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new TypeError('failing_traces must be a non-negative integer');
  return Number(value);
}

const consoleLog = (entry: Record<string, unknown>) => console.error(JSON.stringify(entry));

export function createDashboardService({ repo, now, log = consoleLog }: ServiceDeps): DashboardService {
  const generatedAt = () => now().toISOString();

  // A diagnosis read may fail without taking the rest of the response with it. A lost connection is still a 503,
  // as for every other read. Any other failure is logged by class only (never the message, which can hold SQL or
  // document text) and the caller shows the diagnosis as unavailable.
  async function diagnosisOr<T>(operation: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ClickHouseUnavailable) throw error;
      const errorClass = error instanceof Error ? error.name : 'unknown';
      log({ level: 'error', message: 'diagnosis unavailable', operation, error_class: errorClass });
      return fallback;
    }
  }

  // Looks up each distinct deployment once. A missing deployment maps to a null version.
  async function deploymentVersions(deploymentIds: string[]): Promise<Map<string, string | null>> {
    const versions = new Map<string, string | null>();
    for (const id of new Set(deploymentIds)) {
      const row = await repo.getDeployment(id);
      versions.set(id, row?.new_version ?? null);
    }
    return versions;
  }

  return {
    async listIncidents(rawLimit) {
      const limit = parseLimit(rawLimit, { fallback: 20, max: 100 });
      const rows = await repo.listIncidents(limit);
      const versions = await deploymentVersions(rows.map((row) => row.deployment_id));
      const summaries = new Map<string, DiagnosisSummary>();
      // null means the read failed (not that nothing was found), so every incident shows an unavailable diagnosis
      // rather than a pending one. A connectivity failure still propagates as 503 from diagnosisOr.
      const summaryRows =
        rows.length === 0
          ? []
          : await diagnosisOr<DiagnosisSummaryRow[] | null>(
              'listIncidents',
              () => repo.latestDiagnoses(rows.map((row) => row.incident_id)),
              null,
            );
      for (const summaryRow of summaryRows ?? []) summaries.set(summaryRow.incident_id, toDiagnosisSummary(summaryRow));
      const incidents = rows
        .map((row): IncidentListItem => ({
          ...toIncidentItem(row, versions.get(row.deployment_id) ?? null),
          diagnosis: summaryRows === null ? UNAVAILABLE_SUMMARY : (summaries.get(row.incident_id) ?? null),
        }))
        // Fixed-width UTC text, so a plain string comparison orders by time, newest first.
        .sort((a, b) => (a.detected_at < b.detected_at ? 1 : a.detected_at > b.detected_at ? -1 : 0));
      return { generated_at: generatedAt(), incidents };
    },

    async getIncidentDetail(rawIncidentId) {
      const incidentId = parseIncidentId(rawIncidentId);
      const row = await repo.getIncident(incidentId);
      if (row === null) throw new IncidentNotFound();

      const deploymentRow = await repo.getDeployment(row.deployment_id);
      const deploymentVersion = deploymentRow?.new_version ?? null;
      const incident = toIncidentItem(row, deploymentVersion);
      const evidence = (await repo.listEvidence(incidentId)).map(toEvidenceItem);
      // Validated against this response's own evidence, so a citation can never point outside what is shown.
      const diagnosis = await diagnosisOr<DiagnosisPayload | null>(
        'getIncidentDetail',
        async () => {
          const stored = await repo.latestDiagnosis(incidentId);
          return stored === null
            ? null
            : parseDiagnosis(stored, incidentId, evidence.map((item) => item.evidence_id));
        },
        UNAVAILABLE,
      );

      return {
        generated_at: generatedAt(),
        incident,
        explanation: explainIncident({
          trigger_rule: incident.trigger_rule,
          started_at: incident.started_at,
          deployment_id: incident.deployment_id,
          deployment_version: deploymentVersion,
        }),
        deployment: deploymentRow === null ? null : toDeploymentDetail(deploymentRow),
        evidence,
        diagnosis,
      };
    },

    async listDeployments(rawLimit) {
      const limit = parseLimit(rawLimit, { fallback: 10, max: 50 });
      const rows = await repo.listDeployments(limit);
      if (rows.length === 0) return { generated_at: generatedAt(), deployments: [] };

      const ids = rows.map((row) => row.deployment_id);
      const failures = new Map<string, number>();
      for (const failure of await repo.failingTraces(ids)) {
        failures.set(failure.deployment_id, parseCount(failure.failing_traces));
      }
      const links = new Map<string, string[]>();
      for (const link of await repo.incidentLinks(ids)) {
        const linked = links.get(link.deployment_id) ?? [];
        linked.push(link.incident_id);
        links.set(link.deployment_id, linked);
      }

      return {
        generated_at: generatedAt(),
        deployments: rows.map((row) =>
          toDeploymentItem(row, failures.get(row.deployment_id) ?? 0, links.get(row.deployment_id) ?? []),
        ),
      };
    },
  };
}

// The service the routes use. It is created on the first request, so importing a route module never reads the
// environment or opens a connection. Tests replace it with installDashboardService.
let installed: DashboardService | undefined;

export function installDashboardService(service: DashboardService | undefined): void {
  installed = service;
}

export function getDashboardService(): DashboardService {
  if (installed === undefined) {
    installed = createDashboardService({ repo: createClickHouseReaderFromEnv(), now: () => new Date() });
  }
  return installed;
}

// ---- HTTP mapping ----
// Every response is no-store. Error bodies are fixed JSON. Internal details go to the server log, not to clients.

const NO_STORE = 'no-store';
// The API contract (spec 5.4) names this exact value. Response.json alone omits the charset.
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Cache-Control': NO_STORE, 'Content-Type': JSON_CONTENT_TYPE },
  });
}

export function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { Allow: 'GET', 'Cache-Control': NO_STORE, 'Content-Type': JSON_CONTENT_TYPE },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof InvalidInput) {
    return jsonResponse({ error: 'invalid_input', field: error.field }, 400);
  }
  if (error instanceof IncidentNotFound) {
    return jsonResponse({ error: 'incident_not_found' }, 404);
  }
  if (error instanceof ClickHouseUnavailable) {
    return jsonResponse({ error: 'clickhouse_unavailable' }, 503);
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: 'error', message: 'unhandled dashboard error', error: detail }));
  return jsonResponse({ error: 'internal_error' }, 500);
}
