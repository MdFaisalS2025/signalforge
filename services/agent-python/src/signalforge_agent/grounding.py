"""Grounding facts: the one place that says what the evidence bundle supports.

The deterministic analyzer uses these functions to decide whether to abstain, how confident it may be, and which claims
it may emit. The grounding validator (a later task) uses the very same functions to check any diagnosis, including one
from an optional provider, so an LLM can never assert more than the rules here allow.

Everything is a pure function of an EvidenceBundle. Durations are integer nanoseconds. See
docs/specs/2026-10-07-evidence-cited-diagnosis.md, sections 7.2 and 7.6.
"""

from __future__ import annotations

from typing import Optional, Sequence

from .bundle import EvidenceBundle, EvidenceFact, TraceFacts, _epoch_ns, format_seconds

__all__ = ["abstain_reasons", "max_confidence", "verify_claim", "format_seconds"]

RULE_ID = "payments-5xx-burst-after-deployment"
SERVICE = "demo-payments"

# The fixed missing-evidence messages of spec 7.6, in table order. An abstention uses only these.
MISSING_RULE = "A detection rule this agent understands"
MISSING_SHAPE = "Exactly one deployment row and three trace rows"
MISSING_DEPLOYMENT = "The deployment record for the incident"
MISSING_SUCCEEDED = "A succeeded deployment"
MISSING_TIMING = "A failure within five minutes after the deployment"

# The codes a claim check can return. They are the grounding validator's G2 and G3 rule codes.
SHAPE_CODE = "G2_kind_citation_shape"
NOT_VERIFIED_CODE = "G3_claim_not_verified"

# The detection rule's windows, in nanoseconds: failures begin at most 300 seconds after the deploy and burst within 30.
MAX_FIRST_FAILURE_DELAY_NS = 300 * 1_000_000_000
MAX_BURST_NS = 30 * 1_000_000_000


def _evidence_of(bundle: EvidenceBundle, source_type: str) -> list:
    return [row for row in bundle.evidence if row.source_type == source_type]


def _expected_shape(bundle: EvidenceBundle) -> bool:
    """Exactly one deployment row and three trace rows for three distinct traces, and nothing else."""
    traces = _evidence_of(bundle, "trace")
    return (
        len(bundle.evidence) == 4
        and len(_evidence_of(bundle, "deployment")) == 1
        and len(traces) == 3
        and len({row.source_ref for row in traces}) == 3
    )


def abstain_reasons(bundle: EvidenceBundle) -> list:
    """The fixed missing-evidence messages for every abstain condition that holds, in table order.

    An empty list means the analyzer may diagnose. The timing condition is evaluated only when a deployment record and
    at least one trace row exist, because otherwise another condition already names what is missing.
    """
    reasons = []
    if bundle.incident.trigger_rule != RULE_ID:
        reasons.append(MISSING_RULE)
    if not _expected_shape(bundle):
        reasons.append(MISSING_SHAPE)

    deployment = bundle.deployment
    if deployment is None or deployment.deployment_id != bundle.incident.deployment_id:
        reasons.append(MISSING_DEPLOYMENT)
    elif deployment.status != "succeeded":
        reasons.append(MISSING_SUCCEEDED)

    if deployment is not None and deployment.deployment_id == bundle.incident.deployment_id and bundle.traces:
        delay = bundle.first_failure_delay_ns()
        # None: the first failure is before the deployment. Zero: it is not after it. Both are "not after".
        if delay is None or delay == 0 or delay > MAX_FIRST_FAILURE_DELAY_NS:
            reasons.append(MISSING_TIMING)
    return reasons


def _corroborates(trace: TraceFacts, deployment_id: str) -> bool:
    """A server span with status 500 that carries the incident's deployment ID."""
    return any(
        span.kind == "server" and span.status_code == 500 and span.deployment_id == deployment_id
        for span in trace.spans
    )


def max_confidence(bundle: EvidenceBundle) -> str:
    """The highest confidence the evidence supports: "high", "medium", or "low" (abstention only)."""
    if abstain_reasons(bundle):
        return "low"
    deployment_id = bundle.incident.deployment_id
    if len(bundle.traces) == 3 and all(_corroborates(trace, deployment_id) for trace in bundle.traces):
        return "high"
    return "medium"


def _resolve(bundle: EvidenceBundle, evidence_ids: Sequence[str]) -> list:
    """The distinct cited rows the bundle holds. An ID the bundle does not hold is simply unresolved here."""
    by_id = {row.evidence_id: row for row in bundle.evidence}
    return [by_id[evidence_id] for evidence_id in dict.fromkeys(evidence_ids) if evidence_id in by_id]


def _trace_for(bundle: EvidenceBundle, row: EvidenceFact) -> Optional[TraceFacts]:
    return next((trace for trace in bundle.traces if trace.evidence_id == row.evidence_id), None)


def _says_http_500(row: EvidenceFact) -> bool:
    return row.service == SERVICE and row.summary == f"{SERVICE} returned HTTP 500 for trace {row.source_ref}"


def _deployment_succeeded(bundle: EvidenceBundle, rows: list) -> bool:
    deployment = bundle.deployment
    return (
        deployment is not None
        and deployment.status == "succeeded"
        and deployment.service == SERVICE
        and deployment.deployment_id == bundle.incident.deployment_id
        and rows[0].source_ref == deployment.deployment_id
    )


def _deployment_before_failure(bundle: EvidenceBundle, rows: list) -> bool:
    if bundle.deployment is None:
        return False
    deployed = _epoch_ns(bundle.deployment.timestamp)
    failures = [_epoch_ns(row.timestamp) for row in rows if row.source_type == "trace"]
    return all(failure > deployed for failure in failures) and min(failures) - deployed <= MAX_FIRST_FAILURE_DELAY_NS


def _failure_burst(rows: list) -> bool:
    times = [_epoch_ns(row.timestamp) for row in rows]
    return len({row.source_ref for row in rows}) == 3 and max(times) - min(times) <= MAX_BURST_NS


def _http_500(bundle: EvidenceBundle, rows: list) -> bool:
    for row in rows:
        if not _says_http_500(row):
            return False
        trace = _trace_for(bundle, row)
        # Telemetry detail is optional. When it exists it must agree: a server span with status 500.
        if trace is not None and trace.spans and not any(
            span.kind == "server" and span.status_code == 500 for span in trace.spans
        ):
            return False
    return True


def _share_deployment(bundle: EvidenceBundle, rows: list) -> bool:
    for row in rows:
        trace = _trace_for(bundle, row)
        if trace is None or not trace.spans:
            return False
        if any(span.deployment_id != bundle.incident.deployment_id for span in trace.spans):
            return False
    return True


def verify_claim(kind: str, evidence_ids: Sequence[str], bundle: EvidenceBundle) -> list:
    """Check one claim against the bundle. An empty list means it is verified.

    Returns [G2_kind_citation_shape] when the cited rows are not the shape the kind requires, and
    [G3_claim_not_verified] when the shape is right but the stored facts do not support the claim. Cited IDs the bundle
    does not hold are not resolved here (the validator reports them as unknown evidence); they cannot help satisfy a
    shape, so a claim that needs them fails the shape check.
    """
    rows = _resolve(bundle, evidence_ids)
    deployment_rows = [row for row in rows if row.source_type == "deployment"]
    trace_rows = [row for row in rows if row.source_type == "trace"]
    only_traces = len(trace_rows) == len(rows)

    if kind == "deployment_succeeded":
        shaped = len(rows) == 1 and len(deployment_rows) == 1
        verified = shaped and _deployment_succeeded(bundle, rows)
    elif kind == "deployment_before_failure":
        shaped = len(rows) >= 2 and len(deployment_rows) == 1 and len(trace_rows) == len(rows) - 1
        verified = shaped and _deployment_before_failure(bundle, rows)
    elif kind == "failure_burst":
        every_trace_row = {row.evidence_id for row in _evidence_of(bundle, "trace")}
        shaped = len(trace_rows) == 3 and only_traces and {row.evidence_id for row in rows} == every_trace_row
        verified = shaped and _failure_burst(trace_rows)
    elif kind == "http_500_in_payments":
        shaped = len(rows) >= 1 and only_traces
        verified = shaped and _http_500(bundle, trace_rows)
    elif kind == "failures_share_deployment":
        shaped = len(rows) >= 2 and only_traces
        verified = shaped and _share_deployment(bundle, trace_rows)
    else:
        return [SHAPE_CODE]

    if not shaped:
        return [SHAPE_CODE]
    return [] if verified else [NOT_VERIFIED_CODE]
