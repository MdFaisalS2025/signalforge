"""The mechanical grounding validator: a diagnosis cannot pass unless its own evidence bundle supports it.

validate() checks the contract schema first (G0). Only a schema-valid document is checked against the bundle, and every
independent failure is reported, as a sorted tuple of fixed rule codes (G1 to G8) that carries no document text:

  G1 cited evidence is not in this incident's bundle      G5 confidence is above the bundle's ceiling
  G2 a claim cites the wrong kind of rows                 G6 abstention and completion rules are inconsistent
  G3 a claim's stored facts do not support it             G7 the recommendation is unsafe
  G4 a sentence names an ID, version, or number the       G8 text is over its bound or holds markup, SQL, or control
     bundle does not hold                                      characters

The same functions that drive the deterministic analyzer (grounding.verify_claim and grounding.max_confidence) decide
G2, G3, and G5, so an optional provider can never assert more than the rules allow. The allowed-token set comes from the
bundle alone: this module adds no exceptions to it. See docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 7.5.

Pure: no I/O, environment, logging, or provider calls, and it never mutates its inputs.
"""

from __future__ import annotations

import re
import unicodedata

from .bundle import EvidenceBundle
from .contract import validate_document
from .grounding import abstain_reasons, max_confidence, verify_claim

__all__ = ["ValidationRejected", "validate"]

G0 = "G0_schema"
G1 = "G1_unknown_evidence"
G4 = "G4_untraceable_token"
G5 = "G5_confidence_exceeds_ceiling"
G6 = "G6_abstention_inconsistent"
G7 = "G7_recommendation_unsafe"
G8 = "G8_text_bound"

_CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}

# G7: a backtick, "$(", "&&", "||", a semicolon, a pipe, or one of these whole words, in any letter case. Nothing
# executes the recommendation, so a match is rejected rather than relied on.
_COMMAND = re.compile(
    r"`|\$\(|&&|\|\||;|\||\b(?:docker|kubectl|curl|wget|sudo|rm|chmod|bash|sh|powershell)\b",
    re.IGNORECASE,
)

# G4: the identifiers and numbers the spec enumerates. UUIDs and 32-hex IDs match in any letter case, so an upper-cased
# copy of a real ID is not mistaken for it. Text is stripped of each match before the next pattern runs.
_UUID = re.compile(
    r"(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])", re.IGNORECASE
)
_TRACE_ID = re.compile(r"(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])", re.IGNORECASE)
_VERSION = re.compile(r"\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)*")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")

# G8 text bounds, which mirror the schema's maxLength values.
_HYPOTHESIS_MAX = 240
_CLAIM_MAX = 280
_REASONING_MAX = 1200
_EXPLANATION_MAX = 300
_MISSING_ITEM_MAX = 160
_SUMMARY_MAX = 300
_EFFECT_MAX = 200
_NOTE_MAX = 200


class ValidationRejected(Exception):
    """The diagnosis is not grounded. codes is a sorted tuple of rule codes; the message holds codes only."""

    def __init__(self, codes) -> None:
        self.codes = tuple(codes)
        super().__init__("diagnosis rejected: " + ", ".join(self.codes))


def validate(document: dict, bundle: EvidenceBundle) -> None:
    """Return normally only for a schema-valid document that the bundle supports; otherwise raise ValidationRejected."""
    if validate_document(document):
        raise ValidationRejected((G0,))
    codes = _semantic_codes(document, bundle)
    if codes:
        raise ValidationRejected(tuple(sorted(codes)))


def _semantic_codes(document: dict, bundle: EvidenceBundle) -> set:
    """Every grounding failure of a document, without the schema check.

    This is the seam that lets tests reach rules the schema also enforces (G6, G7, and G8 bounds), because validate()
    reports G0 first for such a document.
    """
    codes: set = set()
    codes |= _citation_codes(document, bundle)
    if _untraceable_tokens(document, bundle):
        codes.add(G4)
    if _exceeds_ceiling(document, bundle):
        codes.add(G5)
    if _abstention_inconsistent(document, bundle):
        codes.add(G6)
    if _recommendation_unsafe(document, bundle):
        codes.add(G7)
    if _text_unbounded(document):
        codes.add(G8)
    return codes


def _citation_codes(document: dict, bundle: EvidenceBundle) -> set:
    """G1 for unknown evidence, else G2 or G3 from the shared claim verifier.

    A claim whose citation already fails G1 is not also checked for shape or facts, so a lone fabricated ID is a lone G1.
    A document for a different incident cannot cite this incident's evidence, so that is G1 too.
    """
    codes: set = set()
    known = bundle.evidence_ids()
    if document.get("incident_id") != bundle.incident.incident_id:
        codes.add(G1)
    for claim in document.get("supporting_claims") or []:
        cited = claim.get("evidence_ids") or []
        if any(evidence_id not in known for evidence_id in cited):
            codes.add(G1)
            continue
        codes.update(verify_claim(claim.get("kind"), cited, bundle))
    for alternative in document.get("alternative_hypotheses") or []:
        if any(evidence_id not in known for evidence_id in alternative.get("disconfirming_evidence_ids") or []):
            codes.add(G1)
    return codes


def _scanned_sentences(document: dict) -> list:
    """The fields G4 checks: the hypothesis, each claim, each alternative hypothesis, and the reasoning summary."""
    sentences = []
    if isinstance(document.get("primary_hypothesis"), str):
        sentences.append(document["primary_hypothesis"])
    sentences += [claim["claim"] for claim in document.get("supporting_claims") or [] if isinstance(claim.get("claim"), str)]
    sentences += [
        alternative["hypothesis"]
        for alternative in document.get("alternative_hypotheses") or []
        if isinstance(alternative.get("hypothesis"), str)
    ]
    if isinstance(document.get("reasoning_summary"), str):
        sentences.append(document["reasoning_summary"])
    return sentences


def _tokens_in(sentence: str, compound_tokens: list) -> set:
    """The UUIDs, 32-hex IDs, versions, and numbers in a sentence that the bundle's own tokens do not account for.

    The bundle's identifier, timestamp, and version tokens are removed first (longest first), so a real version such as
    "release-5" is matched as the whole token the bundle holds. Anything glued to one, such as "0.2.0-faulty9", leaves
    its extra digits behind and is found.
    """
    for token in compound_tokens:
        sentence = sentence.replace(token, " ")
    found: set = set()
    for pattern in (_UUID, _TRACE_ID, _VERSION):
        found.update(pattern.findall(sentence))
        sentence = pattern.sub(" ", sentence)
    found.update(_NUMBER.findall(sentence))
    return found


def _untraceable_tokens(document: dict, bundle: EvidenceBundle) -> set:
    allowed = bundle.allowed_tokens()
    # Tokens with letters or separators beyond digits and dots are identifiers, timestamps, or versions.
    compound = sorted((token for token in allowed if re.search(r"[^0-9.]", token)), key=len, reverse=True)
    found: set = set()
    for sentence in _scanned_sentences(document):
        found |= _tokens_in(sentence, compound)
    return found - allowed


def _exceeds_ceiling(document: dict, bundle: EvidenceBundle) -> bool:
    value = (document.get("confidence") or {}).get("value")
    return _CONFIDENCE_RANK.get(value, 3) > _CONFIDENCE_RANK[max_confidence(bundle)]


def _abstention_inconsistent(document: dict, bundle: EvidenceBundle) -> bool:
    """The conditional rules of spec 7.1 and 7.4, plus a completion that evidence requiring abstention cannot support."""
    abstain = document.get("abstain")
    status = document.get("status")
    claims = document.get("supporting_claims") or []
    confidence = (document.get("confidence") or {}).get("value")
    action = (document.get("remediation_recommendation") or {}).get("action_type")
    if abstain is True:
        return (
            status != "abstained"
            or "primary_hypothesis" in document
            or bool(claims)
            or not document.get("missing_evidence")
            or confidence != "low"
            or action not in ("investigate", "none")
        )
    if abstain is False:
        # "low" is reserved for abstention, and a completed diagnosis needs evidence that does not require abstaining.
        return (
            status != "completed"
            or not document.get("primary_hypothesis")
            or not claims
            or confidence == "low"
            or bool(abstain_reasons(bundle))
        )
    return True


def _recommendation_unsafe(document: dict, bundle: EvidenceBundle) -> bool:
    recommendation = document.get("remediation_recommendation") or {}
    if recommendation.get("executable") is not False or recommendation.get("requires_approval") is not True:
        return True
    action = recommendation.get("action_type")
    parameters = recommendation.get("parameters")
    if action == "rollback_deployment":
        deployment = bundle.deployment
        expected = {
            "service": bundle.incident.service,
            "deployment_id": bundle.incident.deployment_id,
            "from_version": None if deployment is None else deployment.new_version,
        }
        if parameters != expected:
            return True
    elif action in ("investigate", "none") and parameters != {}:
        return True
    for field in ("summary", "expected_effect", "rollback_note"):
        text = recommendation.get(field)
        if not isinstance(text, str) or _COMMAND.search(text):
            return True
    return False


def _text_fields(document: dict) -> list:
    """Every free-text field with its bound. A field that is present but not text is reported as over its bound."""
    fields = [
        (document.get("primary_hypothesis"), _HYPOTHESIS_MAX, "primary_hypothesis" in document),
        (document.get("reasoning_summary"), _REASONING_MAX, True),
        ((document.get("confidence") or {}).get("explanation"), _EXPLANATION_MAX, True),
    ]
    fields += [(claim.get("claim"), _CLAIM_MAX, True) for claim in document.get("supporting_claims") or []]
    fields += [(alt.get("hypothesis"), _HYPOTHESIS_MAX, True) for alt in document.get("alternative_hypotheses") or []]
    fields += [(item, _MISSING_ITEM_MAX, True) for item in document.get("missing_evidence") or []]
    recommendation = document.get("remediation_recommendation") or {}
    fields += [
        (recommendation.get("summary"), _SUMMARY_MAX, True),
        (recommendation.get("expected_effect"), _EFFECT_MAX, True),
        (recommendation.get("rollback_note"), _NOTE_MAX, True),
    ]
    return [(text, bound) for text, bound, present in fields if present]


def _text_unbounded(document: dict) -> bool:
    for text, bound in _text_fields(document):
        if not isinstance(text, str) or len(text) > bound:
            return True
        if any(unicodedata.category(char) == "Cc" for char in text):
            return True
        if "<" in text or ">" in text or "SELECT" in text or "Code:" in text:
            return True
    return False
