"""Deterministic identity for diagnoses, analyzers, and evidence bundles.

Pure standard-library functions. The same inputs always give the same outputs, which is what makes a diagnosis write
idempotent (docs/specs/2026-10-07-evidence-cited-diagnosis.md, sections 7.1 and 8.3).
"""

from __future__ import annotations

import hashlib
import re
import uuid

from .bundle import EvidenceBundle

# The fixed namespace shared by every deterministic identity in the system (incidents, evidence, events).
NAMESPACE = uuid.UUID("8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d")

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def diagnosis_id(incident_id: str, version: int) -> str:
    """UUIDv5(NAMESPACE, "diagnosis|<incident_id>|<version>").

    The incident ID must already be a canonical lowercase UUID, and the version a positive integer. Anything else is a
    ValueError, so two spellings of one incident can never silently produce two diagnosis IDs.
    """
    if not isinstance(incident_id, str) or _UUID.fullmatch(incident_id) is None:
        raise ValueError("incident_id must be a lowercase UUID")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("version must be a positive integer")
    return str(uuid.uuid5(NAMESPACE, f"diagnosis|{incident_id}|{version}"))


def analyzer_id(provider: str, model_version: str, prompt_version: str) -> str:
    """"<provider>|<model_version>|<prompt_version>". No part may be empty or contain the separator."""
    parts = (provider, model_version, prompt_version)
    for part in parts:
        if not isinstance(part, str) or part == "" or "|" in part:
            raise ValueError("analyzer parts must be non-empty and must not contain '|'")
    return "|".join(parts)


def input_digest(bundle: EvidenceBundle) -> str:
    """"sha256:" plus the SHA-256 of the bundle's canonical JSON, encoded as UTF-8."""
    return "sha256:" + hashlib.sha256(bundle.canonical_json().encode("utf-8")).hexdigest()
