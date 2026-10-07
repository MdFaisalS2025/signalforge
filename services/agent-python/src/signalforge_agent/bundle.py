"""The bounded, allowlisted evidence bundle: the only input the analyzer, and any optional provider, ever receives.

build_bundle copies a small set of allowlisted fields out of raw ClickHouse rows into immutable facts. Everything else
in the raw rows (order IDs, request bodies, header values, unrecognized log text, arbitrary attributes, deployment
metadata the diagnosis does not need, columns such as dedup_key) is never copied, so it cannot reach the canonical JSON
or the input digest. See docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 8.2.

Raw rows are the dictionaries ClickHouse JSONEachRow returns: every value is text, DateTime64(9) values print as
"YYYY-MM-DD HH:MM:SS.nnnnnnnnn", and telemetry attributes are a JSON string (a dictionary is accepted too).

This module is pure. It performs no I/O, reads no environment, calls no provider, and never logs raw input. Errors for
malformed input are ValueError with fixed messages that name a field but never repeat a value.
"""

from __future__ import annotations

import datetime
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

MAX_EVIDENCE_ROWS = 8
MAX_TRACES = 3
MAX_SPAN_ROWS = 30
MAX_LOG_ROWS = 30
MAX_BUNDLE_BYTES = 16_384

UNRECOGNIZED_LOG_MESSAGE = "[unrecognized log message omitted]"
UNRECOGNIZED_SPAN_NAME = "[unrecognized span name omitted]"

# demo-payments logs these fixed templates. Any other log body is untrusted text and is replaced, never forwarded.
KNOWN_LOG_BODIES = frozenset(
    {"request received", "request completed", "charge failed", "charge request validation failed"}
)
KNOWN_SPAN_KINDS = frozenset({"server", "client", "unspecified"})

# The constants of the detection rule: a burst is within 30 seconds and starts at most 300 seconds after the deploy.
RULE_CONSTANT_TOKENS = ("30", "300")

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_CLICKHOUSE_TIMESTAMP = re.compile(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{9})")
_API_TIMESTAMP = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z")
_SEVERITY = re.compile(r"[a-z]{1,10}")
_SPAN_NAME = re.compile(r"[A-Za-z0-9 _./:\-]{1,80}")


class BundleTooLarge(Exception):
    """The canonical bundle is larger than MAX_BUNDLE_BYTES UTF-8 bytes. It is never truncated."""


@dataclass
class RawIncidentData:
    """Raw ClickHouse rows for one incident, as the repository reads them. The bundle never mutates them."""

    incident: dict
    evidence: list
    deployment: Optional[dict]
    spans: list
    logs: list


@dataclass(frozen=True)
class IncidentFacts:
    incident_id: str
    title: str
    severity: str
    status: str
    service: str
    environment: str
    deployment_id: str
    trigger_rule: str
    started_at: str
    detected_at: str
    revision: int


@dataclass(frozen=True)
class EvidenceFact:
    evidence_id: str
    source_type: str
    source_ref: str
    timestamp: str
    service: str
    summary: str
    reliability: str


@dataclass(frozen=True)
class DeploymentFacts:
    deployment_id: str
    timestamp: str
    service: str
    environment: str
    new_version: str
    status: str


@dataclass(frozen=True)
class SpanFacts:
    timestamp: str
    span_id: str
    deployment_id: str
    kind: Optional[str]
    name: Optional[str]
    status_code: Optional[int]


@dataclass(frozen=True)
class LogFacts:
    timestamp: str
    severity: str
    body: str


@dataclass(frozen=True)
class TraceFacts:
    evidence_id: str
    trace_id: str
    spans: tuple
    logs: tuple


@dataclass(frozen=True)
class EvidenceBundle:
    incident: IncidentFacts
    evidence: tuple
    deployment: Optional[DeploymentFacts]
    traces: tuple

    def to_dict(self) -> dict:
        return {
            "incident": _fields(self.incident),
            "evidence": [_fields(row) for row in self.evidence],
            "deployment": None if self.deployment is None else _fields(self.deployment),
            "traces": [
                {
                    "evidence_id": trace.evidence_id,
                    "trace_id": trace.trace_id,
                    "spans": [_fields(span) for span in trace.spans],
                    "logs": [_fields(log) for log in trace.logs],
                }
                for trace in self.traces
            ],
        }

    def canonical_json(self) -> str:
        """Sorted keys, compact separators, real UTF-8. The same stored evidence always yields the same text."""
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def evidence_ids(self) -> frozenset:
        return frozenset(row.evidence_id for row in self.evidence)

    def burst_duration_ns(self) -> Optional[int]:
        """Last minus first failure time across the followed traces' evidence rows, in integer nanoseconds.

        None unless at least two traces are followed, because one point does not define a duration. Only retained
        evidence timestamps are used: never dropped rows, uncited traces, or telemetry.
        """
        times = self._followed_failure_ns()
        return max(times) - min(times) if len(times) >= 2 else None

    def first_failure_delay_ns(self) -> Optional[int]:
        """Deployment time to the earliest followed failure, in integer nanoseconds.

        None when there is no deployment row, no followed trace, or the first failure is not after the deployment
        instant: a negative duration is never reported.
        """
        times = self._followed_failure_ns()
        if self.deployment is None or not times:
            return None
        delay = min(times) - _epoch_ns(self.deployment.timestamp)
        return delay if delay >= 0 else None

    def _followed_failure_ns(self) -> list:
        timestamps = {row.evidence_id: row.timestamp for row in self.evidence}
        return [_epoch_ns(timestamps[trace.evidence_id]) for trace in self.traces]

    def allowed_tokens(self) -> frozenset:
        """Identifiers, timestamps, numbers, and constants a validated sentence may mention.

        Everything here comes from this bundle's retained evidence, so an identifier or timestamp the cap dropped, an
        uncited trace, a log or span time, or another incident's ID is not a token:

        - the incident, evidence, deployment, and followed-trace identifiers, and the deployment version;
        - every retained evidence timestamp, rendered exactly as in the canonical bundle (nine fractional digits, Z);
        - the evidence count, the burst duration, and the deployment-to-first-failure delay, each rendered by
          format_seconds and present only when the bundle can define it;
        - the detection-rule constants 30 and 300.
        """
        tokens = {self.incident.incident_id, str(len(self.evidence)), *RULE_CONSTANT_TOKENS}
        if self.incident.deployment_id:
            tokens.add(self.incident.deployment_id)
        for row in self.evidence:
            tokens.add(row.evidence_id)
            tokens.add(row.source_ref)
            tokens.add(row.timestamp)
        if self.deployment is not None:
            tokens.add(self.deployment.deployment_id)
            tokens.add(self.deployment.new_version)
        for trace in self.traces:
            tokens.add(trace.trace_id)
        for nanoseconds in (self.burst_duration_ns(), self.first_failure_delay_ns()):
            if nanoseconds is not None:
                tokens.add(format_seconds(nanoseconds))
        return frozenset(tokens)


def _fields(fact: Any) -> dict:
    return {name: getattr(fact, name) for name in fact.__dataclass_fields__}


def to_api_timestamp(value: str) -> str:
    """Rewrite a ClickHouse DateTime64(9) text as the API's UTC text, keeping all nine fractional digits.

    "2026-10-07 21:49:30.988000000" becomes "2026-10-07T21:49:30.988000000Z". The text is rewritten, not parsed into a
    datetime, so nanoseconds are never rounded. A value already in API form is returned unchanged. Any other value is a
    ValueError that does not repeat it.
    """
    if not isinstance(value, str):
        raise ValueError("timestamp is not text")
    match = _CLICKHOUSE_TIMESTAMP.fullmatch(value) or _API_TIMESTAMP.fullmatch(value)
    if match is None:
        raise ValueError("timestamp is not in the expected format")
    year, month, day, hour, minute, second, nanos = match.groups()
    try:
        datetime.datetime(int(year), int(month), int(day), int(hour), int(minute), int(second))
    except ValueError:
        raise ValueError("timestamp is not a valid date and time") from None
    return f"{year}-{month}-{day}T{hour}:{minute}:{second}.{nanos}Z"


_NANOS_PER_SECOND = 1_000_000_000
_NANOS_PER_TENTH = 100_000_000
_EPOCH_ORDINAL = datetime.date(1970, 1, 1).toordinal()


def _epoch_ns(api_timestamp: str) -> int:
    """Whole nanoseconds since 1970-01-01T00:00:00Z for an API timestamp. Integer arithmetic only: no floats."""
    match = _API_TIMESTAMP.fullmatch(api_timestamp)
    if match is None:
        raise ValueError("timestamp is not in the API format")
    year, month, day, hour, minute, second, nanos = (int(part) for part in match.groups())
    days = datetime.date(year, month, day).toordinal() - _EPOCH_ORDINAL
    seconds = ((days * 24 + hour) * 60 + minute) * 60 + second
    return seconds * _NANOS_PER_SECOND + nanos


def format_seconds(nanoseconds: int) -> str:
    """Render a non-negative duration in integer nanoseconds as seconds with one decimal, rounding half up.

    Pure integer arithmetic, so the result is exact for any size and never depends on float behavior or on banker's
    rounding: 4_552_000_000 is "4.6", 4_550_000_000 is "4.6", 102_000_000 is "0.1", and 0 is "0.0". The analyzer and
    the token set both use this one function, so a sentence and its allowed numbers always agree.
    """
    if isinstance(nanoseconds, bool) or not isinstance(nanoseconds, int) or nanoseconds < 0:
        raise ValueError("nanoseconds must be a non-negative integer")
    tenths = (nanoseconds + _NANOS_PER_TENTH // 2) // _NANOS_PER_TENTH
    return f"{tenths // 10}.{tenths % 10}"


def _text(row: Mapping, key: str, kind: str) -> str:
    value = row.get(key) if isinstance(row, Mapping) else None
    if not isinstance(value, str):
        raise ValueError(f"{kind}.{key} is missing or not text")
    return value


def _timestamp(row: Mapping, key: str, kind: str) -> str:
    try:
        return to_api_timestamp(_text(row, key, kind))
    except ValueError:
        raise ValueError(f"{kind}.{key} is missing or not a valid timestamp") from None


def _uuid(row: Mapping, key: str, kind: str) -> str:
    value = _text(row, key, kind)
    if _UUID.fullmatch(value) is None:
        raise ValueError(f"{kind}.{key} is not a lowercase UUID")
    return value


def _revision(row: Mapping) -> int:
    value = row.get("revision")
    if isinstance(value, bool):
        raise ValueError("incident.revision is not a non-negative integer")
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return int(value)
    raise ValueError("incident.revision is not a non-negative integer")


def _attributes(row: Mapping) -> dict:
    """The telemetry attributes as a dictionary. Anything unreadable is treated as no attributes, never an error."""
    value = row.get("attributes")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def _span_kind(attributes: dict) -> Optional[str]:
    value = attributes.get("span.kind")
    return value if isinstance(value, str) and value in KNOWN_SPAN_KINDS else None


def _span_name(attributes: dict) -> Optional[str]:
    value = attributes.get("span.name")
    if value is None:
        return None
    if isinstance(value, str) and _SPAN_NAME.fullmatch(value):
        return value
    return UNRECOGNIZED_SPAN_NAME


def _status_code(attributes: dict) -> Optional[int]:
    value = attributes.get("http.response.status_code")
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    if isinstance(value, int) and 100 <= value <= 599:
        return value
    return None


def _log_body(attributes: dict) -> str:
    value = attributes.get("log.body")
    return value if isinstance(value, str) and value in KNOWN_LOG_BODIES else UNRECOGNIZED_LOG_MESSAGE


def _incident_facts(row: Mapping) -> IncidentFacts:
    return IncidentFacts(
        incident_id=_uuid(row, "incident_id", "incident"),
        title=_text(row, "title", "incident"),
        severity=_text(row, "severity", "incident"),
        status=_text(row, "status", "incident"),
        service=_text(row, "service", "incident"),
        environment=_text(row, "environment", "incident"),
        deployment_id=_text(row, "deployment_id", "incident"),
        trigger_rule=_text(row, "trigger_rule", "incident"),
        started_at=_timestamp(row, "started_at", "incident"),
        detected_at=_timestamp(row, "detected_at", "incident"),
        revision=_revision(row),
    )


def _evidence_fact(row: Mapping, incident_id: str) -> EvidenceFact:
    if "incident_id" in row and row["incident_id"] != incident_id:
        raise ValueError("evidence belongs to a different incident")
    return EvidenceFact(
        evidence_id=_uuid(row, "evidence_id", "evidence"),
        source_type=_text(row, "source_type", "evidence"),
        source_ref=_text(row, "source_ref", "evidence"),
        timestamp=_timestamp(row, "timestamp", "evidence"),
        service=_text(row, "service", "evidence"),
        summary=_text(row, "summary", "evidence"),
        reliability=_text(row, "reliability", "evidence"),
    )


def _deployment_facts(row: Optional[Mapping]) -> Optional[DeploymentFacts]:
    if row is None:
        return None
    return DeploymentFacts(
        deployment_id=_text(row, "deployment_id", "deployment"),
        timestamp=_timestamp(row, "timestamp", "deployment"),
        service=_text(row, "service", "deployment"),
        environment=_text(row, "environment", "deployment"),
        new_version=_text(row, "new_version", "deployment"),
        status=_text(row, "status", "deployment"),
    )


def _span_facts(row: Mapping) -> SpanFacts:
    attributes = _attributes(row)
    return SpanFacts(
        timestamp=_timestamp(row, "timestamp", "span"),
        span_id=_text(row, "span_id", "span"),
        deployment_id=_text(row, "deployment_id", "span"),
        kind=_span_kind(attributes),
        name=_span_name(attributes),
        status_code=_status_code(attributes),
    )


def _log_facts(row: Mapping) -> LogFacts:
    severity = row.get("severity")
    return LogFacts(
        timestamp=_timestamp(row, "timestamp", "log"),
        severity=severity if isinstance(severity, str) and _SEVERITY.fullmatch(severity) else "unknown",
        body=_log_body(_attributes(row)),
    )


def _followed_trace_refs(evidence: tuple) -> list:
    """The cited trace IDs, in evidence order, each once, at most MAX_TRACES. Returns (trace_id, evidence_id) pairs."""
    followed: list = []
    seen: set = set()
    for row in evidence:
        if row.source_type != "trace" or row.source_ref in seen:
            continue
        seen.add(row.source_ref)
        followed.append((row.source_ref, row.evidence_id))
        if len(followed) == MAX_TRACES:
            break
    return followed


def _rows_for(rows: list, trace_id: str) -> list:
    return [row for row in rows if isinstance(row, Mapping) and row.get("trace_id") == trace_id]


def build_bundle(raw: RawIncidentData) -> EvidenceBundle:
    """Build the bundle from raw rows. Raises ValueError for malformed rows and BundleTooLarge for an oversized bundle."""
    incident = _incident_facts(raw.incident)
    evidence = tuple(
        sorted(
            (_evidence_fact(row, incident.incident_id) for row in raw.evidence),
            key=lambda fact: (fact.timestamp, fact.source_type, fact.source_ref, fact.evidence_id),
        )[:MAX_EVIDENCE_ROWS]
    )

    traces = []
    for trace_id, evidence_id in _followed_trace_refs(evidence):
        spans = sorted(
            (_span_facts(row) for row in _rows_for(raw.spans, trace_id)),
            key=lambda fact: (fact.timestamp, fact.span_id),
        )[:MAX_SPAN_ROWS]
        logs = sorted(
            (_log_facts(row) for row in _rows_for(raw.logs, trace_id)),
            key=lambda fact: (fact.timestamp, fact.severity, fact.body),
        )[:MAX_LOG_ROWS]
        traces.append(TraceFacts(evidence_id=evidence_id, trace_id=trace_id, spans=tuple(spans), logs=tuple(logs)))

    bundle = EvidenceBundle(
        incident=incident,
        evidence=evidence,
        deployment=_deployment_facts(raw.deployment),
        traces=tuple(traces),
    )
    if len(bundle.canonical_json().encode("utf-8")) > MAX_BUNDLE_BYTES:
        raise BundleTooLarge("the canonical evidence bundle exceeds the size limit")
    return bundle
