"""The agent's only door to ClickHouse: bounded, parameterized reads and one idempotent write.

Every statement is a constant in this module, so no SQL is ever composed from a value. External values (a batch size, an
incident ID, a trace ID, an analyzer ID) travel only as typed `{name:Type}` parameters. The reads are bounded exactly as
the spec says (one incident, one deployment, eight evidence rows, thirty span rows, thirty log rows, and the cited trace IDs
capped at three), and the telemetry reads select only the allowlisted attribute keys, so unsafe attributes never leave
ClickHouse.

write() is check-then-insert. It looks for the exact key (incident_id, diagnosis_version) first and inserts exactly one row
only when it is absent. It never updates or deletes. The check and the insert are not atomic, so a single agent instance is
required (spec 8.3).

Only SELECT statements and the one INSERT INTO diagnoses are ever sent. See docs/specs/2026-10-07-evidence-cited-diagnosis.md,
sections 6.2, 6.3, 8.1, 8.2, and 8.3.
"""

from __future__ import annotations

import datetime
import json
import re
from dataclasses import dataclass
from typing import Optional

from .bundle import MAX_TRACES, RawIncidentData
from .chclient import ClickHouseRejected, ClickHouseTransient

DIAGNOSES_TABLE = "diagnoses"

# ClickHouse error code 60, UNKNOWN_TABLE: the migration that creates diagnoses has not run yet.
UNKNOWN_TABLE_CODE = 60

POLICIES = ("first-only", "on-analyzer-change")
MAX_BATCH = 20

STATUSES = ("completed", "abstained", "failed")
CONFIDENCES = ("", "low", "medium", "high")
FAILURE_CODES = ("", "validation_rejected", "invalid_incident", "bundle_too_large")

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_CREATED_AT = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{3})Z")

# Readiness: succeeds only when the table exists and the account may read it. It reads no rows.
SQL_TABLE_READY = "SELECT 1 FROM diagnoses LIMIT 0"

# Spec 6.2. Oldest published incident with no diagnosis row of any kind first.
SQL_DISCOVER_NEW = """SELECT incident_id, deployment_id, trigger_rule, detected_at
FROM incidents FINAL
WHERE publication_state = 'published'
  AND incident_id NOT IN (SELECT incident_id FROM diagnoses)
ORDER BY detected_at ASC
LIMIT {batch:UInt32}"""

# Spec 6.3. The latest row per incident is taken first, and only then is the analyzer compared.
SQL_DISCOVER_REVISE = """SELECT incident_id, latest_version
FROM (
  SELECT incident_id, diagnosis_version AS latest_version, analyzer_id
  FROM diagnoses FINAL
  ORDER BY diagnosis_version DESC
  LIMIT 1 BY incident_id
)
WHERE analyzer_id != {analyzer_id:String}
LIMIT {batch:UInt32}"""

# Spec 8.2. The bundle's sources, one bounded query each.
SQL_INCIDENT = """SELECT incident_id, revision, title, status, severity, service, environment, deployment_id, trigger_rule,
started_at, detected_at
FROM incidents FINAL
WHERE incident_id = {incident_id:UUID}
LIMIT 1"""

SQL_EVIDENCE = """SELECT evidence_id, source_type, source_ref, timestamp, service, summary, reliability
FROM evidence_items FINAL
WHERE incident_id = {incident_id:UUID}
ORDER BY timestamp, source_type, source_ref
LIMIT 8"""

SQL_DEPLOYMENT = """SELECT deployment_id, timestamp, service, environment, new_version, status
FROM deployments FINAL
WHERE toString(deployment_id) = {deployment_id:String}
LIMIT 1"""

# Only the three allowlisted attribute keys are extracted, as raw JSON text. The rest of `attributes` is never selected.
SQL_SPANS = """SELECT timestamp, trace_id, span_id, deployment_id,
  JSONExtractRaw(attributes, 'span.kind') AS span_kind,
  JSONExtractRaw(attributes, 'span.name') AS span_name,
  JSONExtractRaw(attributes, 'http.response.status_code') AS status_code
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments' AND trace_id IN {trace_ids:Array(String)}
ORDER BY timestamp, span_id
LIMIT 30"""

SQL_LOGS = """SELECT timestamp, trace_id, severity,
  JSONExtractRaw(attributes, 'log.body') AS log_body
FROM telemetry_events FINAL
WHERE type = 'log' AND service = 'demo-payments' AND trace_id IN {trace_ids:Array(String)}
ORDER BY timestamp, severity
LIMIT 30"""

# Spec 8.3 step 2. The exact key, without FINAL, so a duplicate row would be counted.
SQL_EXISTS = """SELECT count() AS n
FROM diagnoses
WHERE incident_id = {incident_id:UUID} AND diagnosis_version = {diagnosis_version:UInt32}
LIMIT 1"""


@dataclass(frozen=True)
class Candidate:
    incident_id: str
    next_version: int


@dataclass(frozen=True)
class DiagnosisRow:
    """One row of the diagnoses table (spec 8.1). created_at is the contract timestamp, YYYY-MM-DDTHH:MM:SS.mmmZ."""

    diagnosis_id: str
    incident_id: str
    diagnosis_version: int
    status: str
    confidence: str
    failure_code: str
    provider: str
    model_version: str
    prompt_version: str
    analyzer_id: str
    input_digest: str
    document: str
    created_at: str


_ABSENT = object()


def _incident_uuid(value: object, what: str) -> str:
    if not isinstance(value, str) or _UUID.fullmatch(value) is None:
        raise ValueError(f"{what} is not a lowercase UUID")
    return value


def _positive_version(value: object, what: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{what} is not a positive integer")
    if isinstance(value, int) and value >= 1:
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit() and int(value) >= 1:
        return int(value)
    raise ValueError(f"{what} is not a positive integer")


def _raw_json(text: object) -> object:
    """The value inside a JSONExtractRaw result, or _ABSENT when the key was missing, null, or not valid JSON."""
    if not isinstance(text, str) or text == "":
        return _ABSENT
    try:
        value = json.loads(text)
    except ValueError:
        return _ABSENT
    return _ABSENT if value is None else value


def _attributes(row: dict, columns: tuple) -> str:
    attributes = {}
    for key, column in columns:
        value = _raw_json(row.get(column))
        if value is not _ABSENT:
            attributes[key] = value
    return json.dumps(attributes, separators=(",", ":"), ensure_ascii=False)


def _span_row(row: dict) -> dict:
    # Built from named columns only, so nothing else a query might return can be carried along.
    return {
        "timestamp": row.get("timestamp"),
        "trace_id": row.get("trace_id"),
        "span_id": row.get("span_id"),
        "deployment_id": row.get("deployment_id"),
        "attributes": _attributes(
            row, (("span.kind", "span_kind"), ("span.name", "span_name"), ("http.response.status_code", "status_code"))
        ),
    }


def _log_row(row: dict) -> dict:
    return {
        "timestamp": row.get("timestamp"),
        "trace_id": row.get("trace_id"),
        "severity": row.get("severity"),
        "attributes": _attributes(row, (("log.body", "log_body"),)),
    }


def _insert_values(row: DiagnosisRow) -> dict:
    """Validate a row and return the dictionary to insert. Errors name the field and never repeat a value."""
    if not isinstance(row, DiagnosisRow):
        raise ValueError("row must be a DiagnosisRow")
    _incident_uuid(row.diagnosis_id, "diagnosis_id")
    _incident_uuid(row.incident_id, "incident_id")
    if isinstance(row.diagnosis_version, bool) or not isinstance(row.diagnosis_version, int) or row.diagnosis_version < 1:
        raise ValueError("diagnosis_version is not a positive integer")
    if row.status not in STATUSES:
        raise ValueError("status is not an allowed value")
    if row.confidence not in CONFIDENCES:
        raise ValueError("confidence is not an allowed value")
    if row.failure_code not in FAILURE_CODES:
        raise ValueError("failure_code is not an allowed value")
    for name in ("provider", "model_version", "prompt_version", "analyzer_id", "input_digest", "document"):
        if not isinstance(getattr(row, name), str):
            raise ValueError(f"{name} is not text")
    if not row.analyzer_id:
        raise ValueError("analyzer_id is empty")
    if row.status == "failed":
        # The dead letter: a code, and neither a document nor a confidence.
        if row.failure_code == "" or row.document != "" or row.confidence != "":
            raise ValueError("a failed row needs a failure code and no document or confidence")
    elif row.failure_code != "" or row.document == "" or row.confidence == "":
        raise ValueError("a completed or abstained row needs a document and a confidence and no failure code")

    match = _CREATED_AT.fullmatch(row.created_at) if isinstance(row.created_at, str) else None
    if match is None:
        raise ValueError("created_at is not a contract timestamp")
    stamp = f"{match.group(1)} {match.group(2)}"
    try:
        datetime.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S.%f")
    except ValueError:
        raise ValueError("created_at is not a valid timestamp") from None

    return {
        "diagnosis_id": row.diagnosis_id,
        "incident_id": row.incident_id,
        "diagnosis_version": row.diagnosis_version,
        "status": row.status,
        "confidence": row.confidence,
        "failure_code": row.failure_code,
        "provider": row.provider,
        "model_version": row.model_version,
        "prompt_version": row.prompt_version,
        "analyzer_id": row.analyzer_id,
        "input_digest": row.input_digest,
        "document": row.document,
        "created_at": stamp,
    }


class Repository:
    """Reads the evidence an incident needs and writes diagnosis rows, through an injected ClickHouse client."""

    def __init__(self, client) -> None:
        self._client = client

    def table_ready(self) -> bool:
        """True when diagnoses can be read. False only for an unknown-table rejection; anything else propagates."""
        try:
            self._client.query(SQL_TABLE_READY)
        except ClickHouseRejected as rejection:
            if rejection.code == UNKNOWN_TABLE_CODE:
                return False
            raise
        return True

    def discover(self, limit: int, policy: str, analyzer_id: str) -> list:
        """The incidents to diagnose next, oldest first, at most `limit` in total.

        New incidents (no diagnosis row at all) get version 1. Under on-analyzer-change, any room left in the batch goes
        to incidents whose latest row has a different analyzer, each at latest + 1.
        """
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_BATCH:
            raise ValueError(f"limit must be an integer from 1 to {MAX_BATCH}")
        if policy not in POLICIES:
            raise ValueError("policy is not a known revision policy")
        if not isinstance(analyzer_id, str) or not analyzer_id:
            raise ValueError("analyzer_id must be a non-empty string")

        candidates = [
            Candidate(_incident_uuid(row.get("incident_id"), "an incident ID in a result"), 1)
            for row in self._client.query(SQL_DISCOVER_NEW, {"batch": limit})
        ]
        if policy == "on-analyzer-change" and len(candidates) < limit:
            seen = {candidate.incident_id for candidate in candidates}
            revisions = self._client.query(
                SQL_DISCOVER_REVISE, {"analyzer_id": analyzer_id, "batch": limit - len(candidates)}
            )
            for row in revisions:
                incident_id = _incident_uuid(row.get("incident_id"), "an incident ID in a result")
                latest = _positive_version(row.get("latest_version"), "a latest version in a result")
                if incident_id not in seen:
                    seen.add(incident_id)
                    candidates.append(Candidate(incident_id, latest + 1))
        return candidates[:limit]

    def load_raw(self, incident_id: str) -> RawIncidentData:
        """The bounded raw rows for one incident, in the shape build_bundle expects."""
        _incident_uuid(incident_id, "incident_id")
        incidents = self._client.query(SQL_INCIDENT, {"incident_id": incident_id})
        if not incidents:
            raise ValueError("the incident was not found")
        incident = dict(incidents[0])
        evidence = [dict(row) for row in self._client.query(SQL_EVIDENCE, {"incident_id": incident_id})]

        deployment: Optional[dict] = None
        deployment_id = incident.get("deployment_id")
        if isinstance(deployment_id, str) and deployment_id:
            found = self._client.query(SQL_DEPLOYMENT, {"deployment_id": deployment_id})
            deployment = dict(found[0]) if found else None

        trace_ids: list = []
        for row in evidence:
            reference = row.get("source_ref")
            if row.get("source_type") == "trace" and isinstance(reference, str) and reference not in trace_ids:
                trace_ids.append(reference)
                if len(trace_ids) == MAX_TRACES:
                    break

        spans: list = []
        logs: list = []
        if trace_ids:
            spans = [_span_row(row) for row in self._client.query(SQL_SPANS, {"trace_ids": trace_ids})]
            logs = [_log_row(row) for row in self._client.query(SQL_LOGS, {"trace_ids": trace_ids})]
        return RawIncidentData(incident=incident, evidence=evidence, deployment=deployment, spans=spans, logs=logs)

    def diagnosis_exists(self, incident_id: str, version: int) -> bool:
        """Whether any row exists for exactly (incident_id, diagnosis_version)."""
        _incident_uuid(incident_id, "incident_id")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ValueError("version must be a positive integer")
        rows = self._client.query(SQL_EXISTS, {"incident_id": incident_id, "diagnosis_version": version})
        if len(rows) != 1:
            raise ClickHouseTransient("the existence check returned an unexpected reply")
        count = rows[0].get("n")
        if isinstance(count, bool):
            raise ClickHouseTransient("the existence check returned an unexpected reply")
        if isinstance(count, str) and count.isascii() and count.isdigit():
            count = int(count)
        if not isinstance(count, int) or count < 0:
            # An unreadable answer must never be taken as "not there", or a row could be inserted twice.
            raise ClickHouseTransient("the existence check returned an unexpected reply")
        return count > 0

    def write(self, row: DiagnosisRow) -> None:
        """Insert the row unless its key already exists. Never updates or deletes."""
        values = _insert_values(row)
        if self.diagnosis_exists(row.incident_id, row.diagnosis_version):
            return
        self._client.insert(DIAGNOSES_TABLE, [values])
