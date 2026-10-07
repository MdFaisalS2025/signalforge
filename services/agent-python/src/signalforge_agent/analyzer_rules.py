"""The deterministic, evidence-based analyzer for the known Payments faulty-deployment scenario.

analyze() reads only an EvidenceBundle (allowlisted facts) and returns a schema-valid diagnosis document. Every
sentence is a fixed template filled with identifiers, a version, and numbers the bundle holds. No log body, span name,
or evidence summary is ever copied into the output, so hostile telemetry text cannot reach it.

It makes no network call, reads no environment, and uses no model. See
docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 7.6.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .bundle import EvidenceBundle
from .grounding import abstain_reasons, format_seconds, max_confidence, verify_claim
from .ids import diagnosis_id, input_digest

MODEL = "deterministic-rules-1"
PROMPT_VERSION = "none"

_PROVIDER = {"name": "deterministic", "model": MODEL, "fallback_from": None}

_CONFIDENCE_EXPLANATION = {
    "high": "Telemetry for all three traces confirms HTTP 500 server spans that carry the incident's deployment ID.",
    "medium": "The four stored evidence rows support the diagnosis, but telemetry detail is missing or partial.",
}
_CONFIDENCE_CONDITION = {
    "high": "telemetry for all three traces corroborates the stored evidence rows",
    "medium": "telemetry detail is missing or partial, so only the stored evidence rows support the claims",
}
_ABSTAIN_EXPLANATION = (
    "The evidence is insufficient or does not match a rule this agent understands, so no cause is asserted."
)


def _created_at(now: datetime) -> str:
    """UTC text with exactly three fractional digits. Sub-millisecond precision is truncated, never rounded."""
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be a timezone-aware datetime")
    utc = now.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def _recommendation_investigate() -> dict:
    return {
        "action_type": "investigate",
        "summary": "Investigate why the incident's evidence does not meet the diagnosis requirements.",
        "parameters": {},
        "risk": "low",
        "expected_effect": "A complete, matching evidence set allows a diagnosis.",
        "rollback_note": "Nothing was changed, so there is nothing to roll back.",
        "executable": False,
        "requires_approval": True,
    }


def _recommendation_rollback(bundle: EvidenceBundle) -> dict:
    deployment = bundle.deployment
    return {
        "action_type": "rollback_deployment",
        "summary": f"Consider rolling back {deployment.service} from {deployment.new_version} to its previous known-good version.",
        "parameters": {
            "service": deployment.service,
            "deployment_id": deployment.deployment_id,
            "from_version": deployment.new_version,
        },
        "risk": "low",
        "expected_effect": "Payments requests stop returning HTTP 500 if the regression is confined to this release.",
        "rollback_note": "The previous version is not recorded in this slice, so a human must choose it.",
        "executable": False,
        "requires_approval": True,
    }


def _abstained(common: dict, reasons: list) -> dict:
    document = dict(common)
    document.update(
        {
            "status": "abstained",
            "abstain": True,
            "supporting_claims": [],
            "alternative_hypotheses": [],
            "confidence": {"value": "low", "explanation": _ABSTAIN_EXPLANATION},
            "missing_evidence": list(reasons),
            "reasoning_summary": (
                "The stored evidence does not satisfy what this agent needs to diagnose the incident, so no cause "
                f"is asserted. Missing: {'; '.join(reasons)}."
            ),
            "remediation_recommendation": _recommendation_investigate(),
        }
    )
    return document


def _verified_claims(bundle: EvidenceBundle, burst: str, delay: str) -> list:
    """The claims whose verifiers pass, in the fixed order. Each is (kind, text, cited evidence IDs)."""
    deployment = bundle.deployment
    deployment_row = next(row for row in bundle.evidence if row.source_type == "deployment")
    trace_ids = [row.evidence_id for row in bundle.evidence if row.source_type == "trace"]
    candidates = [
        (
            "deployment_succeeded",
            f"Deployment {deployment.new_version} ({deployment.deployment_id}) succeeded in {deployment.service}.",
            [deployment_row.evidence_id],
        ),
        (
            "deployment_before_failure",
            f"The first failing request came {delay} seconds after deployment {deployment.new_version} succeeded.",
            [deployment_row.evidence_id, trace_ids[0]],
        ),
        ("failure_burst", f"Three distinct Payments requests failed within {burst} seconds.", trace_ids),
        (
            "http_500_in_payments",
            "Each of the three failing requests returned HTTP 500 from demo-payments.",
            trace_ids,
        ),
        (
            "failures_share_deployment",
            f"All three failing requests carry deployment ID {deployment.deployment_id}.",
            trace_ids,
        ),
    ]
    return [
        (kind, text, ids) for kind, text, ids in candidates if verify_claim(kind, ids, bundle) == []
    ]


def analyze(bundle: EvidenceBundle, *, version: int, now: datetime) -> dict:
    """Diagnose from the bundle alone: a completed, cited diagnosis, or a safe abstention."""
    common = {
        "schema_version": "1.1",
        "diagnosis_id": diagnosis_id(bundle.incident.incident_id, version),
        "incident_id": bundle.incident.incident_id,
        "diagnosis_version": version,
        "provider": dict(_PROVIDER),
        "model_version": MODEL,
        "prompt_version": PROMPT_VERSION,
        "input_digest": input_digest(bundle),
        "created_at": _created_at(now),
    }

    reasons = abstain_reasons(bundle)
    if reasons:
        return _abstained(common, reasons)

    deployment = bundle.deployment
    burst = format_seconds(bundle.burst_duration_ns())
    delay = format_seconds(bundle.first_failure_delay_ns())
    claims = _verified_claims(bundle, burst, delay)
    verified_kinds = [kind for kind, _text, _ids in claims]
    level = max_confidence(bundle)

    deployment_row = next(row for row in bundle.evidence if row.source_type == "deployment")
    trace_ids = [row.evidence_id for row in bundle.evidence if row.source_type == "trace"]
    burst_verified = "failure_burst" in verified_kinds

    document = dict(common)
    document.update(
        {
            "status": "completed",
            "abstain": False,
            "primary_hypothesis": (
                f"Payments deployment {deployment.new_version} ({deployment.deployment_id}) introduced an HTTP 500 "
                f"regression: three distinct Payments requests failed within {burst} seconds, starting {delay} "
                "seconds after the deployment."
            ),
            "supporting_claims": [
                {"kind": kind, "claim": text, "evidence_ids": list(ids)} for kind, text, ids in claims
            ],
            "alternative_hypotheses": [
                {
                    "hypothesis": "A fault in demo-orders, the caller, caused the failures.",
                    "disconfirming_evidence_ids": list(trace_ids),
                },
                {
                    "hypothesis": "Unrelated or random Payments errors caused the failures.",
                    "disconfirming_evidence_ids": [deployment_row.evidence_id, *trace_ids] if burst_verified else [],
                },
            ],
            "confidence": {"value": level, "explanation": _CONFIDENCE_EXPLANATION[level]},
            "missing_evidence": [],
            "reasoning_summary": (
                f"Verified claims: {', '.join(verified_kinds)}. The deployment succeeded, then three distinct "
                f"Payments requests failed within {burst} seconds, the first {delay} seconds later. Confidence is "
                f"{level} because {_CONFIDENCE_CONDITION[level]}."
            ),
            "remediation_recommendation": _recommendation_rollback(bundle),
        }
    )
    return document
