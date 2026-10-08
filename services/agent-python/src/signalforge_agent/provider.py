"""The provider interface and the deterministic provider.

A provider turns an evidence bundle into a diagnosis document. The deterministic provider is rules only: it delegates to
analyzer_rules.analyze and nothing else, so it needs no key, no network, and no model. An optional OpenAI-compatible
provider (spec section 13) is deliberately not built here. Whatever a provider returns is checked by the same grounding
validator before anything is stored.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

from .analyzer_rules import MODEL, PROMPT_VERSION, analyze


@runtime_checkable
class Provider(Protocol):
    """name, model_version, and prompt_version identify the analyzer; together they form its analyzer_id."""

    name: str
    model_version: str
    prompt_version: str

    def diagnose(self, bundle, version: int, now: datetime) -> dict: ...


class DeterministicProvider:
    name = "deterministic"
    model_version = MODEL
    prompt_version = PROMPT_VERSION

    def diagnose(self, bundle, version: int, now: datetime) -> dict:
        return analyze(bundle, version=version, now=now)
