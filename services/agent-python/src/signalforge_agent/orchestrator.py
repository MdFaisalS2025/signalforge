"""The diagnosis loop: discover published incidents, diagnose each one, and persist the result.

Each cycle asks the repository for incidents that need a diagnosis, builds the bounded evidence bundle, asks the provider
(deterministic rules only) for a document, checks it with the grounding validator, and writes one row. Failures are handled
by class (docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 8.4):

  transient   a ClickHouse failure or an unexpected error: nothing is written, the incident stays a candidate, and the loop
              retries with a backoff of 1, 2, 4, 8, 16, then 30 seconds. There is no attempt cap, so an outage loses nothing.
  result      insufficient or unknown evidence is an `abstained` row, not a failure.
  permanent   the validator rejects the document (validation_rejected), the incident rows are malformed or the incident is
              gone (invalid_incident), or the bundle is too large (bundle_too_large): one `failed` row, the dead letter,
              and the incident is not retried for this analyzer.

The loop reads and writes only through the repository. It adds no server, port, Kafka client, or provider call. Its logs are
one JSON object per line with only level, message, incident_id, attempt, and error_class, and every message is a fixed
string: no document, bundle, telemetry value, credential, or exception text can reach a log line.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

from . import ids
from .bundle import BundleTooLarge, build_bundle
from .chclient import ClickHouseClient, ClickHouseRejected, ClickHouseTransient
from .config import AgentConfig
from .health import touch_heartbeat
from .provider import DeterministicProvider, Provider
from .repository import UNKNOWN_TABLE_CODE, Candidate, DiagnosisRow, Repository
from .validator import ValidationRejected, validate

EXIT_OK = 0
EXIT_CONFIGURATION = 2
EXIT_NOT_READY = 3

READY_DEADLINE_S = 120
READY_POLL_S = 2
CLICKHOUSE_TIMEOUT_S = 10
MAX_BACKOFF_S = 30

LOG_MESSAGES = frozenset(
    {
        "agent started",
        "agent stopping",
        "waiting for the diagnoses table",
        "the diagnoses table never became ready",
        "the configured provider is not available",
        "diagnosis completed",
        "diagnosis abstained",
        "diagnosis dead-lettered: validation_rejected",
        "diagnosis dead-lettered: bundle_too_large",
        "diagnosis dead-lettered: invalid_incident",
        "diagnosis rejected: identity mismatch",
        "transient failure, will retry",
        "discovery failed, will retry",
        "heartbeat could not be written",
    }
)

# "diagnosis rejected: G1_unknown_evidence,G4_untraceable_token": the validator's fixed rule codes, never document text.
_REJECTION_MESSAGE = re.compile(r"diagnosis rejected: G[0-8]_[a-z_]+(,G[0-8]_[a-z_]+)*")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_ERROR_CLASS = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class JsonLogger:
    """One JSON object per line. Only fixed messages and the five allowed keys are accepted, so nothing else can be logged."""

    def __init__(self, sink: Callable[[str], None]) -> None:
        self._sink = sink

    def info(self, message: str, *, incident_id: Optional[str] = None, attempt: Optional[int] = None, error_class: Optional[str] = None) -> None:
        self._emit("info", message, incident_id, attempt, error_class)

    def warn(self, message: str, *, incident_id: Optional[str] = None, attempt: Optional[int] = None, error_class: Optional[str] = None) -> None:
        self._emit("warn", message, incident_id, attempt, error_class)

    def error(self, message: str, *, incident_id: Optional[str] = None, attempt: Optional[int] = None, error_class: Optional[str] = None) -> None:
        self._emit("error", message, incident_id, attempt, error_class)

    def _emit(self, level: str, message: str, incident_id: Optional[str], attempt: Optional[int], error_class: Optional[str]) -> None:
        if message not in LOG_MESSAGES and _REJECTION_MESSAGE.fullmatch(message) is None:
            raise ValueError("a log message must be one of the fixed messages")
        record: dict = {"level": level, "message": message}
        if incident_id is not None:
            if not isinstance(incident_id, str) or _UUID.fullmatch(incident_id) is None:
                raise ValueError("incident_id must be a lowercase UUID")
            record["incident_id"] = incident_id
        if attempt is not None:
            if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
                raise ValueError("attempt must be a positive integer")
            record["attempt"] = attempt
        if error_class is not None:
            if not isinstance(error_class, str) or _ERROR_CLASS.fullmatch(error_class) is None:
                raise ValueError("error_class must be a class name")
            record["error_class"] = error_class
        self._sink(json.dumps(record, separators=(",", ":")))


@dataclass(frozen=True)
class Outcome:
    """kind is "written" (status is completed, abstained, or failed), "skipped", or "transient" (error_class is the class name)."""

    kind: str
    status: Optional[str] = None
    error_class: Optional[str] = None


@dataclass(frozen=True)
class CycleResult:
    discovered: int
    written: int
    skipped: int
    transient: int
    stopped: bool


@dataclass
class Deps:
    """Everything the loop touches, injected so tests need no Docker, ClickHouse, real time, or signal."""

    repository: object
    provider: Provider
    config: AgentConfig
    log: JsonLogger
    stop: threading.Event
    now: Callable[[], datetime]
    monotonic: Callable[[], float]
    wait: Callable[[float], bool]
    touch_heartbeat: Callable[[str], None]
    attempts: dict = field(default_factory=dict)


def _stdout_sink(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def default_deps(config: AgentConfig, stop: threading.Event) -> Deps:
    """The real dependencies. Building them performs no network activity: the client connects only when it is used."""
    client = ClickHouseClient(config.clickhouse_url, config.database, config.user, config.password, CLICKHOUSE_TIMEOUT_S)
    return Deps(
        repository=Repository(client),
        provider=DeterministicProvider(),
        config=config,
        log=JsonLogger(_stdout_sink),
        stop=stop,
        now=lambda: datetime.now(timezone.utc),
        monotonic=time.monotonic,
        wait=stop.wait,
        touch_heartbeat=touch_heartbeat,
    )


def backoff_seconds(attempt: int) -> int:
    """1, 2, 4, 8, 16, then 30 seconds for every later attempt. There is no attempt cap."""
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        raise ValueError("attempt must be a positive integer")
    if attempt >= 6:
        return MAX_BACKOFF_S
    return min(MAX_BACKOFF_S, 2 ** (attempt - 1))


def _timestamp(now: datetime) -> str:
    utc = now.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def _analyzer_id(provider: Provider) -> str:
    return ids.analyzer_id(provider.name, provider.model_version, provider.prompt_version)


def _identity_matches(document: dict, provider: Provider, candidate: Candidate) -> bool:
    """The document must be for this incident and version and name the analyzer that made it.

    A document that names another analyzer would make the revision query select the same incident again every cycle.
    """
    return (
        document.get("incident_id") == candidate.incident_id
        and document.get("diagnosis_version") == candidate.next_version
        and document.get("diagnosis_id") == ids.diagnosis_id(candidate.incident_id, candidate.next_version)
        and (document.get("provider") or {}).get("name") == provider.name
        and document.get("model_version") == provider.model_version
        and document.get("prompt_version") == provider.prompt_version
    )


def _row_from_document(candidate: Candidate, document: dict) -> DiagnosisRow:
    """Every scalar column comes from the document and the identity helpers. The document is stored as canonical JSON."""
    provider_name = document["provider"]["name"]
    return DiagnosisRow(
        diagnosis_id=ids.diagnosis_id(candidate.incident_id, candidate.next_version),
        incident_id=candidate.incident_id,
        diagnosis_version=candidate.next_version,
        status=document["status"],
        confidence=document["confidence"]["value"],
        failure_code="",
        provider=provider_name,
        model_version=document["model_version"],
        prompt_version=document["prompt_version"],
        analyzer_id=ids.analyzer_id(provider_name, document["model_version"], document["prompt_version"]),
        input_digest=document["input_digest"],
        document=json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
        created_at=document["created_at"],
    )


def _dead_letter(candidate: Candidate, deps: Deps, code: str, error_class: str, now: datetime, bundle=None) -> Outcome:
    """Write the one `failed` row for a permanent failure: a code, and neither a document nor a confidence."""
    provider = deps.provider
    deps.repository.write(
        DiagnosisRow(
            diagnosis_id=ids.diagnosis_id(candidate.incident_id, candidate.next_version),
            incident_id=candidate.incident_id,
            diagnosis_version=candidate.next_version,
            status="failed",
            confidence="",
            failure_code=code,
            provider=provider.name,
            model_version=provider.model_version,
            prompt_version=provider.prompt_version,
            analyzer_id=_analyzer_id(provider),
            input_digest="" if bundle is None else ids.input_digest(bundle),
            document="",
            created_at=_timestamp(now),
        )
    )
    deps.log.warn(f"diagnosis dead-lettered: {code}", incident_id=candidate.incident_id, error_class=error_class)
    return Outcome("written", "failed")


def _diagnose(candidate: Candidate, deps: Deps) -> Outcome:
    now = deps.now()
    try:
        bundle = build_bundle(deps.repository.load_raw(candidate.incident_id))
    except BundleTooLarge:
        return _dead_letter(candidate, deps, "bundle_too_large", "BundleTooLarge", now)
    except ValueError as error:
        # Malformed incident or evidence rows, or an incident that is gone. ClickHouse errors are not ValueErrors.
        return _dead_letter(candidate, deps, "invalid_incident", type(error).__name__, now)
    except ClickHouseRejected as rejection:
        # ClickHouse refused this incident's bounded input, and asking again will not change that. Recording it keeps one
        # such incident from heading the queue forever. A missing table is different: the migration may still arrive, so
        # that case stays transient. Failures to connect and failures to write are never this branch.
        if rejection.code == UNKNOWN_TABLE_CODE:
            raise
        return _dead_letter(candidate, deps, "invalid_incident", "ClickHouseRejected", now)

    document = deps.provider.diagnose(bundle, candidate.next_version, now)
    try:
        validate(document, bundle)
    except ValidationRejected as rejection:
        deps.log.warn(f"diagnosis rejected: {','.join(rejection.codes)}", incident_id=candidate.incident_id, error_class="ValidationRejected")
        return _dead_letter(candidate, deps, "validation_rejected", "ValidationRejected", now, bundle)
    if not _identity_matches(document, deps.provider, candidate):
        deps.log.warn("diagnosis rejected: identity mismatch", incident_id=candidate.incident_id, error_class="ValidationRejected")
        return _dead_letter(candidate, deps, "validation_rejected", "ValidationRejected", now, bundle)

    deps.repository.write(_row_from_document(candidate, document))
    deps.log.info("diagnosis completed" if document["status"] == "completed" else "diagnosis abstained", incident_id=candidate.incident_id)
    return Outcome("written", document["status"])


def _transient(deps: Deps, incident_id: str, error: BaseException) -> Outcome:
    attempt = deps.attempts.get(incident_id, 0) + 1
    deps.attempts[incident_id] = attempt
    error_class = type(error).__name__
    deps.log.warn("transient failure, will retry", incident_id=incident_id, attempt=attempt, error_class=error_class)
    return Outcome("transient", error_class=error_class)


def process_incident(candidate: Candidate, deps: Deps) -> Outcome:
    """Diagnose one candidate and persist the result. Never raises for an incident-level failure."""
    try:
        if deps.repository.diagnosis_exists(candidate.incident_id, candidate.next_version):
            deps.attempts.pop(candidate.incident_id, None)
            return Outcome("skipped")
        outcome = _diagnose(candidate, deps)
    except Exception as error:  # noqa: BLE001
        # ClickHouse failures, and any unexpected error: nothing was written, so the incident stays a candidate and the
        # failure is logged by class. A bug is retried visibly rather than hidden as a dead letter or allowed to stop the loop.
        return _transient(deps, candidate.incident_id, error)
    deps.attempts.pop(candidate.incident_id, None)
    return outcome


def run_cycle(deps: Deps) -> CycleResult:
    """One pass: discover, process each incident (stopping between incidents on a stop request), touch the heartbeat."""
    config = deps.config
    discovered = written = skipped = transient = 0
    stopped = False
    try:
        candidates = deps.repository.discover(config.batch_size, config.revision_policy, _analyzer_id(deps.provider))
    except Exception as error:  # noqa: BLE001
        deps.log.warn("discovery failed, will retry", error_class=type(error).__name__)
        candidates = []
        transient += 1
    discovered = len(candidates)
    for candidate in candidates:
        if deps.stop.is_set():
            stopped = True
            break
        outcome = process_incident(candidate, deps)
        if outcome.kind == "written":
            written += 1
        elif outcome.kind == "skipped":
            skipped += 1
        else:
            transient += 1
    try:
        deps.touch_heartbeat(config.heartbeat_path)
    except OSError as error:
        # A heartbeat that cannot be written turns the health check unhealthy, which is the right signal. It must not stop the loop.
        deps.log.error("heartbeat could not be written", error_class=type(error).__name__)
    return CycleResult(discovered, written, skipped, transient, stopped)


def _wait_until_ready(deps: Deps) -> Optional[int]:
    """Probe the diagnoses table until it is readable. None when ready, 0 if stopped meanwhile, 3 after 120 seconds."""
    deadline = deps.monotonic() + READY_DEADLINE_S
    announced = False
    while True:
        try:
            ready = deps.repository.table_ready()
        except Exception as error:  # noqa: BLE001 - not ready yet, whatever the reason
            ready = False
            if not announced:
                deps.log.warn("waiting for the diagnoses table", error_class=type(error).__name__)
                announced = True
        else:
            if not ready and not announced:
                deps.log.info("waiting for the diagnoses table")
                announced = True
        if ready:
            return None
        if deps.monotonic() >= deadline:
            deps.log.error("the diagnoses table never became ready")
            return EXIT_NOT_READY
        if deps.wait(READY_POLL_S):
            return EXIT_OK


def run(config: AgentConfig, stop: threading.Event, deps: Optional[Deps] = None) -> int:
    """Run until stopped. Returns 0 after a stop, 2 for an unusable provider setting, 3 if the table never becomes ready."""
    if deps is None:
        if config.provider != "deterministic":
            JsonLogger(_stdout_sink).error("the configured provider is not available")
            return EXIT_CONFIGURATION
        deps = default_deps(config, stop)
    if stop.is_set():
        return EXIT_OK
    not_ready = _wait_until_ready(deps)
    if not_ready is not None:
        return not_ready
    deps.log.info("agent started")
    streak = 0
    while not stop.is_set():
        result = run_cycle(deps)
        if stop.is_set():
            break
        if result.transient:
            streak += 1
            delay = backoff_seconds(streak)
        else:
            streak = 0
            delay = config.poll_interval_s
        if deps.wait(delay):
            break
    deps.log.info("agent stopping")
    return EXIT_OK
