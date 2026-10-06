// The only dashboard module that imports @clickhouse/client. It runs the static Task 3 queries as read-only
// requests with bound parameters. It has no write operations, no fallback credentials, and no dynamic SQL.
import { createClient } from '@clickhouse/client';
import { QUERIES } from './queries';

// Request timeout in milliseconds, from docs/specs/2026-10-06-incident-dashboard.md, section 5.1.
const REQUEST_TIMEOUT_MS = 5000;
// The largest limit any query accepts. Route validation enforces the per-endpoint caps (100 and 50); this is a
// second bound so the client never sends an unbounded LIMIT.
const MAX_LIMIT = 100;

// The public failure. Its message is fixed and carries no SQL, driver text, host, credential, or stack.
export class ClickHouseUnavailable extends Error {
  constructor() {
    super('ClickHouse is unavailable');
    this.name = 'ClickHouseUnavailable';
  }
}

// Rows as the JSONEachRow format returns them. ClickHouse quotes 64-bit integers and writes DateTime64 values in
// its own text form, so these fields are strings. The model layer (Task 5) converts them.
export interface IncidentRow {
  incident_id: string;
  revision: string;
  title: string;
  status: string;
  severity: string;
  service: string;
  environment: string;
  deployment_id: string;
  trigger_rule: string;
  started_at: string;
  detected_at: string;
  publication_state: string;
  published_at: string | null;
}

export interface EvidenceRow {
  evidence_id: string;
  source_type: string;
  source_ref: string;
  timestamp: string;
  service: string;
  summary: string;
  reliability: string;
}

export interface DeploymentRow {
  deployment_id: string;
  timestamp: string;
  service: string;
  environment: string;
  new_version: string;
  previous_version: string;
  initiated_by: string;
  status: string;
}

export interface RecentDeploymentRow {
  deployment_id: string;
  timestamp: string;
  environment: string;
  new_version: string;
  previous_version: string;
  status: string;
}

export interface FailingTraceRow {
  deployment_id: string;
  failing_traces: string;
}

export interface IncidentLinkRow {
  incident_id: string;
  deployment_id: string;
  started_at: string;
}

// Runs one parameterized SELECT and returns its rows. The production implementation wraps the ClickHouse client;
// tests substitute a fake.
export interface Transport {
  select<T>(sql: string, params: Record<string, unknown>): Promise<T[]>;
}

// Records a failure server-side. It receives the operation name and the driver's message, never configuration.
export interface Logger {
  error(message: string, meta: Record<string, unknown>): void;
}

export interface ClickHouseReader {
  listIncidents(limit: number): Promise<IncidentRow[]>;
  getIncident(incidentId: string): Promise<IncidentRow | null>;
  listEvidence(incidentId: string): Promise<EvidenceRow[]>;
  getDeployment(deploymentId: string): Promise<DeploymentRow | null>;
  listDeployments(limit: number): Promise<RecentDeploymentRow[]>;
  failingTraces(deploymentIds: string[]): Promise<FailingTraceRow[]>;
  incidentLinks(deploymentIds: string[]): Promise<IncidentLinkRow[]>;
}

const consoleLogger: Logger = {
  error(message, meta) {
    console.error(JSON.stringify({ level: 'error', message, ...meta }));
  },
};

function checkLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// createClickHouseReader is the whole read surface. Each operation maps one static query to one typed call.
export function createClickHouseReader(transport: Transport, logger: Logger = consoleLogger): ClickHouseReader {
  const run = async <T>(operation: string, sql: string, params: Record<string, unknown>): Promise<T[]> => {
    try {
      return await transport.select<T>(sql, params);
    } catch (error) {
      logger.error('clickhouse query failed', { operation, error: describe(error) });
      throw new ClickHouseUnavailable();
    }
  };

  return {
    async listIncidents(limit) {
      return run<IncidentRow>('listIncidents', QUERIES.Q1, { limit: checkLimit(limit) });
    },
    async getIncident(incidentId) {
      const rows = await run<IncidentRow>('getIncident', QUERIES.Q2, { incident_id: incidentId });
      return rows[0] ?? null;
    },
    async listEvidence(incidentId) {
      return run<EvidenceRow>('listEvidence', QUERIES.Q3, { incident_id: incidentId });
    },
    async getDeployment(deploymentId) {
      const rows = await run<DeploymentRow>('getDeployment', QUERIES.Q4, { deployment_id: deploymentId });
      return rows[0] ?? null;
    },
    async listDeployments(limit) {
      return run<RecentDeploymentRow>('listDeployments', QUERIES.Q5, { limit: checkLimit(limit) });
    },
    async failingTraces(deploymentIds) {
      return run<FailingTraceRow>('failingTraces', QUERIES.Q6, { deployment_ids: deploymentIds });
    },
    async incidentLinks(deploymentIds) {
      return run<IncidentLinkRow>('incidentLinks', QUERIES.Q7, { deployment_ids: deploymentIds });
    },
  };
}

// The four variables from docs/specs/2026-10-06-incident-dashboard.md, section 5.5. Each is required. A missing
// value is an error, never a default. The error names the variable, not its value.
export interface ClickHouseConfig {
  url: string;
  database: string;
  username: string;
  password: string;
}

export function readConfig(env: Record<string, string | undefined>): ClickHouseConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  };
  return {
    url: required('CLICKHOUSE_URL'),
    database: required('CLICKHOUSE_DATABASE'),
    username: required('CLICKHOUSE_USER'),
    password: required('CLICKHOUSE_PASSWORD'),
  };
}

// The options passed to createClient. readonly = 1 makes the session read-only at the server, in addition to the
// read-only account itself.
export function clientOptions(config: ClickHouseConfig) {
  return {
    url: config.url,
    database: config.database,
    username: config.username,
    password: config.password,
    request_timeout: REQUEST_TIMEOUT_MS,
    // The client types setting values as strings (UInt64 = string), so the read-only flag is '1'.
    clickhouse_settings: { readonly: '1' },
  };
}

// Builds the production transport from the client. Nothing is connected until a query runs.
export function createTransport(config: ClickHouseConfig): Transport {
  const client = createClient(clientOptions(config));
  return {
    async select<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
      const result = await client.query({ query: sql, query_params: params, format: 'JSONEachRow' });
      return result.json<T>();
    },
  };
}

// The reader used by the API routes. It reads configuration from the environment and fails at construction if any
// variable is missing.
export function createClickHouseReaderFromEnv(
  env: Record<string, string | undefined> = process.env,
  logger: Logger = consoleLogger,
): ClickHouseReader {
  return createClickHouseReader(createTransport(readConfig(env)), logger);
}
