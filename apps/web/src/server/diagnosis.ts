// Read-side validation of a stored diagnosis, from docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 9.
// The agent validates a diagnosis before it writes one, but the dashboard never trusts a stored document: it checks
// the row, the document against the v1.1 contract (contracts/events/diagnosis.schema.json), the incident, and every
// citation again before anything reaches a client. Any violation gives { state: 'unavailable' } and nothing else,
// so a bad document can never leak a field, a message, or a partial result. Text is returned as data and is never
// interpreted here.
import type { DiagnosisRow } from './clickhouse';

export interface SchemaViolation {
  path: string;
  keyword: string;
}

// A diagnosis document that passed every check, plus the state the dashboard shows (equal to its status).
export type DiagnosisView = Record<string, unknown> & { state: 'completed' | 'abstained' };

// A failed attempt. Only these four fields are ever exposed: there is no document, and no message.
export interface FailedDiagnosis {
  state: 'failed';
  diagnosis_version: number;
  failure_code: string;
  created_at: string;
}

export interface UnavailableDiagnosis {
  state: 'unavailable';
}

export type DiagnosisPayload = DiagnosisView | FailedDiagnosis | UnavailableDiagnosis;

export const UNAVAILABLE: UnavailableDiagnosis = Object.freeze({ state: 'unavailable' }) as UnavailableDiagnosis;

const FAILURE_CODES = ['validation_rejected', 'invalid_incident', 'bundle_too_large'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DOCUMENT_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const ROW_TIME = /^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3})$/;

const CLAIM_KINDS = [
  'deployment_succeeded',
  'deployment_before_failure',
  'failure_burst',
  'http_500_in_payments',
  'failures_share_deployment',
];
const CONFIDENCES = ['low', 'medium', 'high'];
const ACTIONS = ['rollback_deployment', 'investigate', 'none'];
const PROVIDERS = ['deterministic', 'openai-compatible'];

const TOP_LEVEL = [
  'schema_version',
  'diagnosis_id',
  'incident_id',
  'diagnosis_version',
  'status',
  'abstain',
  'primary_hypothesis',
  'supporting_claims',
  'alternative_hypotheses',
  'confidence',
  'missing_evidence',
  'reasoning_summary',
  'remediation_recommendation',
  'provider',
  'model_version',
  'prompt_version',
  'input_digest',
  'created_at',
];
const REQUIRED = TOP_LEVEL.filter((key) => key !== 'primary_hypothesis');

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (object: Obj, key: string) => Object.prototype.hasOwnProperty.call(object, key);
// JSON Schema counts characters as code points, not UTF-16 units.
const length = (text: string) => [...text].length;

// schemaViolations checks one document against the v1.1 schema and lists every violation as the JSON pointer of the
// failing value and the schema keyword that failed. It mirrors the keywords the schema uses: type, const, enum,
// pattern, minLength, maxLength, minimum, minItems, maxItems, uniqueItems, maxProperties, required,
// additionalProperties, not, and the if/then rules on abstain and action_type.
export function schemaViolations(document: unknown): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  const fail = (path: string, keyword: string) => out.push({ path, keyword });

  function string(path: string, value: unknown, options: { min?: number; max?: number; pattern?: RegExp; values?: string[] } = {}) {
    if (typeof value !== 'string') return fail(path, 'type');
    if (options.min !== undefined && length(value) < options.min) fail(path, 'minLength');
    if (options.max !== undefined && length(value) > options.max) fail(path, 'maxLength');
    if (options.pattern && !options.pattern.test(value)) fail(path, 'pattern');
    if (options.values && !options.values.includes(value)) fail(path, 'enum');
  }

  function array(path: string, value: unknown, min: number, max: number, unique: boolean): value is unknown[] {
    if (!Array.isArray(value)) {
      fail(path, 'type');
      return false;
    }
    if (value.length < min) fail(path, 'minItems');
    if (value.length > max) fail(path, 'maxItems');
    if (unique && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail(path, 'uniqueItems');
    return true;
  }

  function object(path: string, value: unknown, allowed: string[], required: string[]): value is Obj {
    if (!isObject(value)) {
      fail(path, 'type');
      return false;
    }
    if (Object.keys(value).some((key) => !allowed.includes(key))) fail(path, 'additionalProperties');
    if (required.some((key) => !has(value, key))) fail(path, 'required');
    return true;
  }

  function uuidList(path: string, value: unknown, min: number, max: number) {
    if (!array(path, value, min, max, true)) return;
    value.forEach((item, index) => string(`${path}/${index}`, item, { pattern: UUID }));
  }

  if (!object('', document, TOP_LEVEL, REQUIRED)) return out;
  const doc = document;

  if (has(doc, 'schema_version') && doc.schema_version !== '1.1') fail('/schema_version', typeof doc.schema_version === 'string' ? 'const' : 'type');
  if (has(doc, 'diagnosis_id')) string('/diagnosis_id', doc.diagnosis_id, { pattern: UUID });
  if (has(doc, 'incident_id')) string('/incident_id', doc.incident_id, { pattern: UUID });
  if (has(doc, 'diagnosis_version')) {
    const version = doc.diagnosis_version;
    if (typeof version !== 'number' || !Number.isInteger(version)) fail('/diagnosis_version', 'type');
    else if (version < 1) fail('/diagnosis_version', 'minimum');
  }
  if (has(doc, 'status')) string('/status', doc.status, { values: ['completed', 'abstained'] });
  if (has(doc, 'abstain') && typeof doc.abstain !== 'boolean') fail('/abstain', 'type');
  if (has(doc, 'primary_hypothesis')) string('/primary_hypothesis', doc.primary_hypothesis, { min: 1, max: 240 });

  if (has(doc, 'supporting_claims') && array('/supporting_claims', doc.supporting_claims, 0, 6, false)) {
    (doc.supporting_claims as unknown[]).forEach((claim, index) => {
      const at = `/supporting_claims/${index}`;
      if (!object(at, claim, ['kind', 'claim', 'evidence_ids'], ['kind', 'claim', 'evidence_ids'])) return;
      if (has(claim, 'kind')) string(`${at}/kind`, claim.kind, { values: CLAIM_KINDS });
      if (has(claim, 'claim')) string(`${at}/claim`, claim.claim, { min: 1, max: 280 });
      if (has(claim, 'evidence_ids')) uuidList(`${at}/evidence_ids`, claim.evidence_ids, 1, 8);
    });
  }

  if (has(doc, 'alternative_hypotheses') && array('/alternative_hypotheses', doc.alternative_hypotheses, 0, 3, false)) {
    (doc.alternative_hypotheses as unknown[]).forEach((alternative, index) => {
      const at = `/alternative_hypotheses/${index}`;
      const keys = ['hypothesis', 'disconfirming_evidence_ids'];
      if (!object(at, alternative, keys, keys)) return;
      if (has(alternative, 'hypothesis')) string(`${at}/hypothesis`, alternative.hypothesis, { min: 1, max: 240 });
      if (has(alternative, 'disconfirming_evidence_ids')) uuidList(`${at}/disconfirming_evidence_ids`, alternative.disconfirming_evidence_ids, 0, 8);
    });
  }

  if (has(doc, 'confidence') && object('/confidence', doc.confidence, ['value', 'explanation'], ['value', 'explanation'])) {
    if (has(doc.confidence, 'value')) string('/confidence/value', doc.confidence.value, { values: CONFIDENCES });
    if (has(doc.confidence, 'explanation')) string('/confidence/explanation', doc.confidence.explanation, { min: 1, max: 300 });
  }

  if (has(doc, 'missing_evidence') && array('/missing_evidence', doc.missing_evidence, 0, 5, false)) {
    (doc.missing_evidence as unknown[]).forEach((item, index) => string(`/missing_evidence/${index}`, item, { min: 1, max: 160 }));
  }
  if (has(doc, 'reasoning_summary')) string('/reasoning_summary', doc.reasoning_summary, { min: 1, max: 1200 });

  if (has(doc, 'remediation_recommendation')) {
    const at = '/remediation_recommendation';
    const keys = ['action_type', 'summary', 'parameters', 'risk', 'expected_effect', 'rollback_note', 'executable', 'requires_approval'];
    const recommendation = doc.remediation_recommendation;
    if (object(at, recommendation, keys, keys)) {
      if (has(recommendation, 'action_type')) string(`${at}/action_type`, recommendation.action_type, { values: ACTIONS });
      if (has(recommendation, 'summary')) string(`${at}/summary`, recommendation.summary, { min: 1, max: 300 });
      if (has(recommendation, 'risk')) string(`${at}/risk`, recommendation.risk, { values: CONFIDENCES });
      if (has(recommendation, 'expected_effect')) string(`${at}/expected_effect`, recommendation.expected_effect, { min: 1, max: 200 });
      if (has(recommendation, 'rollback_note')) string(`${at}/rollback_note`, recommendation.rollback_note, { min: 1, max: 200 });
      if (has(recommendation, 'executable') && recommendation.executable !== false) {
        fail(`${at}/executable`, typeof recommendation.executable === 'boolean' ? 'const' : 'type');
      }
      if (has(recommendation, 'requires_approval') && recommendation.requires_approval !== true) {
        fail(`${at}/requires_approval`, typeof recommendation.requires_approval === 'boolean' ? 'const' : 'type');
      }
      if (has(recommendation, 'parameters')) {
        const parameters = recommendation.parameters;
        const names = ['service', 'deployment_id', 'from_version'];
        if (object(`${at}/parameters`, parameters, names, [])) {
          if (has(parameters, 'service')) string(`${at}/parameters/service`, parameters.service, { min: 1, max: 80 });
          if (has(parameters, 'deployment_id')) string(`${at}/parameters/deployment_id`, parameters.deployment_id, { pattern: UUID });
          if (has(parameters, 'from_version')) string(`${at}/parameters/from_version`, parameters.from_version, { min: 1, max: 80 });
          if (recommendation.action_type === 'rollback_deployment' && names.some((name) => !has(parameters, name))) {
            fail(`${at}/parameters`, 'required');
          }
          if ((recommendation.action_type === 'investigate' || recommendation.action_type === 'none') && Object.keys(parameters).length > 0) {
            fail(`${at}/parameters`, 'maxProperties');
          }
        }
      }
    }
  }

  if (has(doc, 'provider') && object('/provider', doc.provider, ['name', 'model', 'fallback_from'], ['name', 'model', 'fallback_from'])) {
    if (has(doc.provider, 'name')) string('/provider/name', doc.provider.name, { values: PROVIDERS });
    if (has(doc.provider, 'model')) string('/provider/model', doc.provider.model, { min: 1, max: 80 });
    const fallback = doc.provider.fallback_from;
    if (has(doc.provider, 'fallback_from') && fallback !== null && !(typeof fallback === 'string' && PROVIDERS.includes(fallback))) {
      fail('/provider/fallback_from', 'enum');
    }
  }

  if (has(doc, 'model_version')) string('/model_version', doc.model_version, { min: 1, max: 80 });
  if (has(doc, 'prompt_version')) string('/prompt_version', doc.prompt_version, { min: 1, max: 80 });
  if (has(doc, 'input_digest')) string('/input_digest', doc.input_digest, { pattern: DIGEST });
  if (has(doc, 'created_at')) {
    string('/created_at', doc.created_at, { pattern: DOCUMENT_TIME });
    if (typeof doc.created_at === 'string' && DOCUMENT_TIME.test(doc.created_at) && Number.isNaN(Date.parse(doc.created_at))) {
      fail('/created_at', 'format');
    }
  }

  // The abstain rules. Each applies only when abstain has exactly the value that triggers it.
  const claims = Array.isArray(doc.supporting_claims) ? doc.supporting_claims : undefined;
  if (doc.abstain === false) {
    if (!has(doc, 'primary_hypothesis')) fail('', 'required');
    if (has(doc, 'status') && doc.status !== 'completed') fail('/status', 'const');
    if (claims && claims.length < 1) fail('/supporting_claims', 'minItems');
  }
  if (doc.abstain === true) {
    if (has(doc, 'status') && doc.status !== 'abstained') fail('/status', 'const');
    if (has(doc, 'primary_hypothesis')) fail('/primary_hypothesis', 'not');
    if (claims && claims.length > 0) fail('/supporting_claims', 'maxItems');
    if (Array.isArray(doc.missing_evidence) && doc.missing_evidence.length < 1) fail('/missing_evidence', 'minItems');
    if (isObject(doc.confidence) && has(doc.confidence, 'value') && doc.confidence.value !== 'low') fail('/confidence/value', 'const');
    if (isObject(doc.remediation_recommendation) && has(doc.remediation_recommendation, 'action_type')) {
      const action = doc.remediation_recommendation.action_type;
      if (action !== 'investigate' && action !== 'none') fail('/remediation_recommendation/action_type', 'enum');
    }
  }

  return out;
}

// Every evidence ID a valid document cites, supporting and disconfirming. Call it only after schemaViolations is empty.
function citedIds(doc: Obj): string[] {
  const ids: string[] = [];
  for (const claim of doc.supporting_claims as Array<{ evidence_ids: string[] }>) ids.push(...claim.evidence_ids);
  for (const alt of doc.alternative_hypotheses as Array<{ disconfirming_evidence_ids: string[] }>) {
    ids.push(...alt.disconfirming_evidence_ids);
  }
  return ids;
}

// ClickHouse writes DateTime64(3) as "YYYY-MM-DD HH:MM:SS.mmm" in UTC. The API uses the contract form with a T and a Z.
function rowTimeToApi(value: string): string | null {
  const match = ROW_TIME.exec(value);
  if (match === null) return null;
  const text = `${match[1]}T${match[2]}Z`;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

// parseDiagnosis turns the latest stored row into what the API may show. The result is exactly one of: a completed or
// abstained document (every check passed), the four-field failed shape, or { state: 'unavailable' }. It never throws
// and never returns part of a rejected document.
//   row          the Q8 row, treated as untrusted
//   incidentId   the incident the response is about; the document must be for it
//   evidenceIds  the evidence IDs in the same response; every citation must be one of them
export function parseDiagnosis(row: DiagnosisRow, incidentId: string, evidenceIds: Iterable<string>): DiagnosisPayload {
  try {
    return parse(row, incidentId, evidenceIds);
  } catch {
    return UNAVAILABLE;
  }
}

function parse(row: DiagnosisRow, incidentId: string, evidenceIds: Iterable<string>): DiagnosisPayload {
  if (!isObject(row)) return UNAVAILABLE;
  const { diagnosis_version: version, status, confidence, failure_code: failureCode, document, created_at: createdAt } = row;
  if (!Number.isSafeInteger(version) || version < 1) return UNAVAILABLE;
  if (typeof confidence !== 'string' || typeof failureCode !== 'string' || typeof document !== 'string' || typeof createdAt !== 'string') {
    return UNAVAILABLE;
  }

  if (status === 'failed') {
    const time = rowTimeToApi(createdAt);
    if (time === null || !FAILURE_CODES.includes(failureCode) || document !== '' || confidence !== '') return UNAVAILABLE;
    return { state: 'failed', diagnosis_version: version, failure_code: failureCode, created_at: time };
  }

  if (status !== 'completed' && status !== 'abstained') return UNAVAILABLE;
  if (failureCode !== '') return UNAVAILABLE;

  const parsed: unknown = JSON.parse(document);
  if (!isObject(parsed) || schemaViolations(parsed).length > 0) return UNAVAILABLE;
  if (parsed.incident_id !== incidentId) return UNAVAILABLE;
  if (parsed.diagnosis_version !== version || parsed.status !== status) return UNAVAILABLE;
  if ((parsed.confidence as Obj).value !== confidence) return UNAVAILABLE;

  const known = new Set(evidenceIds);
  if (!citedIds(parsed).every((id) => known.has(id))) return UNAVAILABLE;

  return { ...parsed, state: status };
}
