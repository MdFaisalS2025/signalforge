"""The diagnosis contract (version 1.1): schema lookup and document validation.

The schema is contracts/events/diagnosis.schema.json, the single source of truth shared with the repository's
sample validation. Errors are exposed as stable values (a JSON Pointer and the failing keyword) so callers and tests
do not depend on jsonschema's traversal order or message wording.

Format keywords are annotations only here: the schema enforces UUIDs, the digest, and the timestamp with explicit
patterns, so validation needs no optional format-checker packages and gives the same answer everywhere.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Mapping, Optional

from jsonschema import Draft202012Validator

SCHEMA_RELATIVE_PATH = Path("contracts") / "events" / "diagnosis.schema.json"


@dataclass(frozen=True, order=True)
class ContractError:
    """One contract violation: where it is (RFC 6901 JSON Pointer; "" is the document root) and which keyword failed."""

    path: str
    keyword: str


def json_pointer(parts: Iterable[object]) -> str:
    """Build an RFC 6901 JSON Pointer. "~" is escaped before "/", so "~1" is never read back as a slash."""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def find_schema(start: Path) -> Path:
    """Search upward from start (a directory, or a file whose directory is used) for the diagnosis schema."""
    start = start.resolve()
    directory = start.parent if start.is_file() else start
    for candidate_dir in (directory, *directory.parents):
        candidate = candidate_dir / SCHEMA_RELATIVE_PATH
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"{SCHEMA_RELATIVE_PATH.as_posix()} was not found above {directory}")


def schema_path(env: Optional[Mapping[str, str]] = None) -> Path:
    """AGENT_SCHEMA_PATH when set and non-empty (it must name an existing file), else the repository's schema.

    The default search starts at this module, never at the current directory, so it works from any working
    directory. An empty AGENT_SCHEMA_PATH counts as unset, matching how Compose passes an unset reference.
    """
    source = os.environ if env is None else env
    configured = source.get("AGENT_SCHEMA_PATH")
    if configured:
        path = Path(configured)
        if not path.is_file():
            raise FileNotFoundError("AGENT_SCHEMA_PATH does not name an existing file")
        return path
    return find_schema(Path(__file__).resolve().parent)


@lru_cache(maxsize=4)
def _validator(path: str) -> Draft202012Validator:
    schema = json.loads(Path(path).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate_document(doc: dict) -> list[ContractError]:
    """Validate a diagnosis document. An empty list means it satisfies the contract.

    The result is de-duplicated and sorted by (path, keyword): a rule that fails several times at one place, such as
    several missing required properties, is reported once, and the order never depends on traversal.
    """
    validator = _validator(str(schema_path()))
    errors = {ContractError(json_pointer(error.absolute_path), str(error.validator)) for error in validator.iter_errors(doc)}
    return sorted(errors)
