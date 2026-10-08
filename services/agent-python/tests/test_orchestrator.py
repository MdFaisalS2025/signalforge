import ast
import contextlib
import copy
import inspect
import io
import json
import os
import re
import signal
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

from signalforge_agent import __main__ as cli
from signalforge_agent import health as health_module
from signalforge_agent import orchestrator as orchestrator_module
from signalforge_agent import provider as provider_module
from signalforge_agent.analyzer_rules import analyze
from signalforge_agent.bundle import RawIncidentData, build_bundle
from signalforge_agent.chclient import ClickHouseRejected, ClickHouseTransient
from signalforge_agent.config import load
from signalforge_agent.health import heartbeat_is_fresh, touch_heartbeat
from signalforge_agent.ids import analyzer_id, diagnosis_id, input_digest
from signalforge_agent.orchestrator import (
    LOG_MESSAGES,
    CycleResult,
    Deps,
    JsonLogger,
    Outcome,
    backoff_seconds,
    process_incident,
    run,
    run_cycle,
)
from signalforge_agent.provider import DeterministicProvider, Provider
from signalforge_agent.repository import Candidate
from signalforge_agent.validator import validate

FIXTURES = Path(__file__).resolve().parent / "fixtures"

NOW = datetime(2026, 10, 7, 21, 49, 41, 208000, tzinfo=timezone.utc)

I1 = "5893b198-6ad5-5708-bb7e-a0d2ca4ca323"
I2 = "a1b2c3d4-e5f6-4789-90ab-cdef01234567"
I3 = "0f1e2d3c-4b5a-4968-8777-665544332211"
DOCUMENTED_V1 = "c03997a4-e1ef-5a94-8a2e-62d9694d7642"
FABRICATED_EVIDENCE = "00000000-0000-4000-8000-000000000000"

PASSWORD = "pw-SECRET-orch-1"
PROVIDER_KEY = "key-SECRET-orch-2"
BASE_ENV = {"CLICKHOUSE_URL": "http://clickhouse:8123", "CLICKHOUSE_USER": "agent_writer", "CLICKHOUSE_PASSWORD": PASSWORD}

ALLOWED_LOG_KEYS = {"level", "message", "incident_id", "attempt", "error_class"}
LOG_LEVELS = {"info", "warn", "error"}
REJECTION_MESSAGE = re.compile(r"^diagnosis rejected: (G[0-8]_[a-z_]+)(,G[0-8]_[a-z_]+)*$")

DETERMINISTIC_ID = "deterministic|deterministic-rules-1|none"


def config_for(**overrides):
    return load({**BASE_ENV, **overrides})


def raw_fixture(name="faulty_deploy_full", incident_id=I1):
    data = json.loads((FIXTURES / f"raw_{name}.json").read_text(encoding="utf-8"))
    raw = RawIncidentData(incident=data["incident"], evidence=data["evidence"], deployment=data["deployment"], spans=data["spans"], logs=data["logs"])
    raw.incident["incident_id"] = incident_id
    return raw


class FakeRepo:
    """An in-memory stand-in for the repository, with the same discovery semantics as the SQL."""

    def __init__(self, incidents=None):
        self.raw = dict(incidents or {})
        self.rows = []
        self.ready = True
        self.ready_calls = 0
        self.discover_calls = []
        self.load_calls = []
        self.exists_calls = 0
        self.write_calls = 0
        self.load_failures = []
        self.write_failures = []
        self.discover_failures = []

    @staticmethod
    def _next(failures):
        if failures:
            failure = failures.pop(0)
            if failure is not None:
                raise failure

    def table_ready(self):
        self.ready_calls += 1
        result = self.ready() if callable(self.ready) else self.ready
        if isinstance(result, BaseException):
            raise result
        return result

    def discover(self, limit, policy, analyzer):
        self.discover_calls.append((limit, policy, analyzer))
        self._next(self.discover_failures)
        have = {row.incident_id for row in self.rows}
        found = [Candidate(incident, 1) for incident in self.raw if incident not in have][:limit]
        if policy == "on-analyzer-change" and len(found) < limit:
            latest = {}
            for row in self.rows:
                if row.incident_id not in latest or row.diagnosis_version > latest[row.incident_id].diagnosis_version:
                    latest[row.incident_id] = row
            for incident, row in latest.items():
                if row.analyzer_id != analyzer and incident in self.raw:
                    found.append(Candidate(incident, row.diagnosis_version + 1))
        return found[:limit]

    def load_raw(self, incident_id):
        self.load_calls.append(incident_id)
        self._next(self.load_failures)
        if incident_id not in self.raw:
            raise ValueError("the incident was not found")
        return copy.deepcopy(self.raw[incident_id])

    def diagnosis_exists(self, incident_id, version):
        self.exists_calls += 1
        return any(r.incident_id == incident_id and r.diagnosis_version == version for r in self.rows)

    def write(self, row):
        self.write_calls += 1
        self._next(self.write_failures)
        if self.diagnosis_exists(row.incident_id, row.diagnosis_version):
            return
        self.rows.append(row)


class FakeTime:
    """A fake clock and sleeper. wait() advances time instead of sleeping and reports whether a stop was requested."""

    def __init__(self, stop, stop_when=None):
        self.t = 0.0
        self.waits = []
        self.stop = stop
        self.stop_when = stop_when

    def monotonic(self):
        return self.t

    def wait(self, seconds):
        self.waits.append(seconds)
        self.t += seconds
        if self.stop_when is not None and self.stop_when():
            self.stop.set()
        return self.stop.is_set()


class Sink:
    def __init__(self):
        self.lines = []

    def __call__(self, line):
        self.lines.append(line)

    def records(self):
        return [json.loads(line) for line in self.lines]


class AlternateProvider:
    """A second analyzer identity that delegates to the deterministic analyzer."""

    name = "deterministic"
    model_version = "deterministic-rules-2"
    prompt_version = "none"

    def diagnose(self, bundle, version, now):
        document = analyze(bundle, version=version, now=now)
        document["model_version"] = self.model_version
        document["provider"]["model"] = self.model_version
        return document


class FabricatingProvider(DeterministicProvider):
    def diagnose(self, bundle, version, now):
        document = super().diagnose(bundle, version, now)
        document["supporting_claims"][0]["evidence_ids"] = [FABRICATED_EVIDENCE]
        return document


class MislabelledProvider(DeterministicProvider):
    """Claims one analyzer identity but writes a document naming another."""

    def diagnose(self, bundle, version, now):
        document = super().diagnose(bundle, version, now)
        document["model_version"] = "something-else"
        document["provider"]["model"] = "something-else"
        return document


class WrongVersionProvider(DeterministicProvider):
    def diagnose(self, bundle, version, now):
        return super().diagnose(bundle, version + 1, now)


class RaisingProvider(DeterministicProvider):
    def __init__(self, error):
        self.error = error

    def diagnose(self, bundle, version, now):
        raise self.error


class StoppingProvider(DeterministicProvider):
    def __init__(self, stop):
        self.stop = stop

    def diagnose(self, bundle, version, now):
        self.stop.set()
        return super().diagnose(bundle, version, now)


def make_deps(repo, *, provider=None, config=None, stop=None, stop_when=None, touches=None, sink=None, **config_env):
    stop = stop or threading.Event()
    fake = FakeTime(stop, stop_when)
    sink = sink if sink is not None else Sink()
    touches = touches if touches is not None else []
    deps = Deps(
        repository=repo,
        provider=provider or DeterministicProvider(),
        config=config or config_for(**config_env),
        log=JsonLogger(sink),
        stop=stop,
        now=lambda: NOW,
        monotonic=fake.monotonic,
        wait=fake.wait,
        touch_heartbeat=touches.append,
    )
    deps.fake_time = fake
    deps.sink = sink
    deps.touches = touches
    return deps


def candidate(incident_id=I1, version=1):
    return Candidate(incident_id, version)


def row_document(row):
    return json.loads(row.document)


class ProviderTest(unittest.TestCase):
    def test_the_deterministic_provider_has_the_documented_identity_and_delegates_only_to_the_analyzer(self):
        provider = DeterministicProvider()
        self.assertEqual((provider.name, provider.model_version, provider.prompt_version), ("deterministic", "deterministic-rules-1", "none"))
        bundle = build_bundle(raw_fixture())
        self.assertEqual(provider.diagnose(bundle, 1, NOW), analyze(bundle, version=1, now=NOW))

    def test_it_satisfies_the_provider_protocol(self):
        self.assertIsInstance(DeterministicProvider(), Provider)

    def test_the_provider_module_has_no_network_or_provider_client_code(self):
        tree = ast.parse(inspect.getsource(provider_module))
        imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imported |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        self.assertFalse(imported & {"urllib", "urllib.request", "http", "http.client", "socket", "ssl", "requests", "openai", "subprocess", "os"})
        self.assertFalse([name for name in dir(provider_module) if "openai" in name.lower() or "compatible" in name.lower()])


class BackoffTest(unittest.TestCase):
    def test_the_sequence_is_exactly_1_2_4_8_16_then_30(self):
        self.assertEqual([backoff_seconds(n) for n in range(1, 8)], [1, 2, 4, 8, 16, 30, 30])

    def test_the_delay_never_exceeds_30_even_for_huge_attempt_counts(self):
        for attempt in (8, 50, 1_000, 10**9, 10**30):
            self.assertEqual(backoff_seconds(attempt), 30)

    def test_the_result_is_an_integer_and_bad_attempts_are_rejected(self):
        self.assertIsInstance(backoff_seconds(3), int)
        for bad in (0, -1, True, 1.5, "1", None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    backoff_seconds(bad)  # type: ignore[arg-type]


class CompletedRowTest(unittest.TestCase):
    def test_a_candidate_becomes_a_completed_row_whose_document_passes_the_validator(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo)
        outcome = process_incident(candidate(), deps)
        self.assertEqual(outcome, Outcome("written", "completed"))
        self.assertEqual(len(repo.rows), 1)
        row = repo.rows[0]
        document = row_document(row)
        validate(document, build_bundle(raw_fixture()))
        self.assertEqual(row.diagnosis_id, DOCUMENTED_V1)
        self.assertEqual(document["diagnosis_id"], DOCUMENTED_V1)

    def test_every_scalar_column_is_derived_from_the_document_and_the_identity_helpers(self):
        repo = FakeRepo({I1: raw_fixture()})
        process_incident(candidate(), make_deps(repo))
        row = repo.rows[0]
        document = row_document(row)
        bundle = build_bundle(raw_fixture())
        self.assertEqual(document, analyze(bundle, version=1, now=NOW))
        self.assertEqual(
            (row.incident_id, row.diagnosis_version, row.status, row.confidence, row.failure_code),
            (I1, 1, document["status"], document["confidence"]["value"], ""),
        )
        self.assertEqual((row.provider, row.model_version, row.prompt_version), ("deterministic", "deterministic-rules-1", "none"))
        self.assertEqual(row.analyzer_id, analyzer_id("deterministic", "deterministic-rules-1", "none"))
        self.assertEqual(row.analyzer_id, DETERMINISTIC_ID)
        self.assertEqual(row.input_digest, input_digest(bundle))
        self.assertEqual(row.input_digest, document["input_digest"])
        self.assertEqual(row.created_at, "2026-10-07T21:49:41.208Z")
        self.assertEqual(row.diagnosis_id, diagnosis_id(I1, 1))

    def test_the_stored_document_is_canonical_json_so_a_rewrite_is_byte_identical(self):
        repo = FakeRepo({I1: raw_fixture()})
        process_incident(candidate(), make_deps(repo))
        text = repo.rows[0].document
        self.assertEqual(text, json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"), ensure_ascii=False))

    def test_a_cycle_writes_every_discovered_incident_in_order(self):
        repo = FakeRepo({I1: raw_fixture(incident_id=I1), I2: raw_fixture(incident_id=I2), I3: raw_fixture(incident_id=I3)})
        result = run_cycle(make_deps(repo))
        self.assertEqual([r.incident_id for r in repo.rows], [I1, I2, I3])
        self.assertEqual([r.diagnosis_id for r in repo.rows], [diagnosis_id(i, 1) for i in (I1, I2, I3)])
        self.assertIsInstance(result, CycleResult)
        self.assertEqual((result.discovered, result.written, result.transient, result.stopped), (3, 3, 0, False))

    def test_the_discovery_batch_and_policy_come_from_the_configuration(self):
        repo = FakeRepo()
        run_cycle(make_deps(repo, AGENT_BATCH_SIZE="7", AGENT_REVISION_POLICY="on-analyzer-change"))
        self.assertEqual(repo.discover_calls, [(7, "on-analyzer-change", DETERMINISTIC_ID)])

    def test_rerunning_the_same_cycle_writes_nothing_new(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo)
        first = run_cycle(deps)
        second = run_cycle(deps)
        self.assertEqual((first.written, second.written, second.discovered), (1, 0, 0))
        self.assertEqual(len(repo.rows), 1)
        self.assertEqual(repo.write_calls, 1)

    def test_an_already_diagnosed_candidate_is_skipped_without_analysis_or_a_write(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo)
        process_incident(candidate(), deps)
        loads, writes = len(repo.load_calls), repo.write_calls
        outcome = process_incident(candidate(), deps)
        self.assertEqual(outcome, Outcome("skipped"))
        self.assertEqual((len(repo.load_calls), repo.write_calls), (loads, writes))


class TransientTest(unittest.TestCase):
    def test_a_transient_failure_on_load_writes_nothing_and_the_next_cycle_retries(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.load_failures = [ClickHouseTransient("down")]
        deps = make_deps(repo)
        first = run_cycle(deps)
        self.assertEqual(repo.rows, [])
        self.assertEqual((first.written, first.transient), (0, 1))
        second = run_cycle(deps)
        self.assertEqual(len(repo.rows), 1)
        self.assertEqual((second.written, second.transient), (1, 0))

    def test_a_transient_failure_on_write_writes_nothing_and_the_next_cycle_retries(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.write_failures = [ClickHouseTransient("down")]
        deps = make_deps(repo)
        outcome = process_incident(candidate(), deps)
        self.assertEqual(outcome.kind, "transient")
        self.assertEqual(repo.rows, [])
        self.assertEqual(run_cycle(deps).written, 1)
        self.assertEqual(len(repo.rows), 1)

    def test_the_outcome_names_the_error_class_only(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.load_failures = [ClickHouseTransient(f"cannot connect with {PASSWORD}")]
        outcome = process_incident(candidate(), make_deps(repo))
        self.assertEqual(outcome, Outcome("transient", error_class="ClickHouseTransient"))
        self.assertNotIn(PASSWORD, repr(outcome))

    def test_a_rejection_from_the_server_is_retried_never_dead_lettered(self):
        for code in (60, 497, 516, None):
            with self.subTest(code=code):
                repo = FakeRepo({I1: raw_fixture()})
                repo.load_failures = [ClickHouseRejected("rejected", code=code, status=403)]
                outcome = process_incident(candidate(), make_deps(repo))
                self.assertEqual(outcome.kind, "transient")
                self.assertEqual(outcome.error_class, "ClickHouseRejected")
                self.assertEqual(repo.rows, [])

    def test_an_unexpected_exception_is_retried_visibly_never_dead_lettered_or_fatal(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo, provider=RaisingProvider(RuntimeError(f"bug with {PASSWORD}")))
        outcome = process_incident(candidate(), deps)
        self.assertEqual(outcome, Outcome("transient", error_class="RuntimeError"))
        self.assertEqual(repo.rows, [])
        self.assertTrue(all(PASSWORD not in line for line in deps.sink.lines))

    def test_a_failed_discovery_is_a_transient_cycle_and_still_touches_the_heartbeat(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.discover_failures = [ClickHouseTransient("down")]
        deps = make_deps(repo)
        result = run_cycle(deps)
        self.assertEqual((result.discovered, result.written, result.transient), (0, 0, 1))
        self.assertEqual(len(deps.touches), 1)
        self.assertEqual(run_cycle(deps).written, 1)

    def test_the_attempt_counter_grows_per_incident_and_resets_after_success(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.load_failures = [ClickHouseTransient("down")] * 3
        deps = make_deps(repo)
        for _ in range(3):
            process_incident(candidate(), deps)
        warnings = [r for r in deps.sink.records() if r["message"] == "transient failure, will retry"]
        self.assertEqual([r["attempt"] for r in warnings], [1, 2, 3])
        self.assertEqual({r["incident_id"] for r in warnings}, {I1})
        process_incident(candidate(), deps)
        self.assertEqual(deps.attempts, {})

    def test_the_loop_backs_off_1_2_4_8_16_30_30_then_returns_to_the_poll_interval(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.load_failures = [ClickHouseTransient("down")] * 7
        stop = threading.Event()
        deps = make_deps(repo, stop=stop, stop_when=lambda: bool(repo.rows))
        self.assertEqual(run(deps.config, stop, deps), 0)
        self.assertEqual(deps.fake_time.waits, [1, 2, 4, 8, 16, 30, 30, 2])
        self.assertEqual(len(repo.rows), 1)
        self.assertEqual(len(deps.touches), 8)
        self.assertEqual(len(repo.load_calls), 8)

    def test_a_long_outage_never_stops_retrying_and_never_writes_a_row(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.load_failures = [ClickHouseTransient("down")] * 40
        stop = threading.Event()
        deps = make_deps(repo, stop=stop, stop_when=lambda: len(deps.fake_time.waits) >= 40)
        run(deps.config, stop, deps)
        self.assertEqual(repo.rows, [])
        self.assertEqual(deps.fake_time.waits[:8], [1, 2, 4, 8, 16, 30, 30, 30])
        self.assertTrue(all(w == 30 for w in deps.fake_time.waits[5:]))


class PermanentFailureTest(unittest.TestCase):
    def assert_dead_letter(self, row, code, incident_id=I1):
        self.assertEqual((row.status, row.failure_code, row.document, row.confidence), ("failed", code, "", ""))
        self.assertEqual((row.incident_id, row.diagnosis_version, row.diagnosis_id), (incident_id, 1, diagnosis_id(incident_id, 1)))
        self.assertEqual(row.analyzer_id, DETERMINISTIC_ID)
        self.assertEqual(row.created_at, "2026-10-07T21:49:41.208Z")

    def test_a_validator_rejection_creates_exactly_one_failed_row_and_is_not_retried(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo, provider=FabricatingProvider())
        outcome = process_incident(candidate(), deps)
        self.assertEqual(outcome, Outcome("written", "failed"))
        self.assertEqual(len(repo.rows), 1)
        self.assert_dead_letter(repo.rows[0], "validation_rejected")
        self.assertEqual(repo.rows[0].input_digest, input_digest(build_bundle(raw_fixture())))
        # The failed row is the dead letter: the unchanged analyzer never sees this incident again.
        again = run_cycle(deps)
        self.assertEqual((again.discovered, again.written), (0, 0))
        self.assertEqual(len(repo.rows), 1)

    def test_the_rejection_codes_are_logged_and_not_stored(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo, provider=FabricatingProvider())
        process_incident(candidate(), deps)
        messages = [r["message"] for r in deps.sink.records()]
        self.assertIn("diagnosis rejected: G1_unknown_evidence", messages)
        self.assertNotIn("G1", repo.rows[0].document)

    def test_a_document_that_names_another_identity_is_dead_lettered_not_retried_forever(self):
        for label, provider in (("analyzer", MislabelledProvider()), ("version", WrongVersionProvider())):
            with self.subTest(case=label):
                repo = FakeRepo({I1: raw_fixture()})
                deps = make_deps(repo, provider=provider, AGENT_REVISION_POLICY="on-analyzer-change")
                process_incident(candidate(), deps)
                self.assertEqual(len(repo.rows), 1)
                self.assert_dead_letter(repo.rows[0], "validation_rejected")
                self.assertIn("diagnosis rejected: identity mismatch", [r["message"] for r in deps.sink.records()])

    def test_a_bundle_that_is_too_large_creates_exactly_one_failed_row(self):
        raw = raw_fixture()
        raw.evidence[1]["summary"] += "é" * 9_000
        repo = FakeRepo({I1: raw})
        deps = make_deps(repo)
        outcome = process_incident(candidate(), deps)
        self.assertEqual(outcome, Outcome("written", "failed"))
        self.assertEqual(len(repo.rows), 1)
        self.assert_dead_letter(repo.rows[0], "bundle_too_large")
        self.assertEqual(repo.rows[0].input_digest, "")
        self.assertEqual(run_cycle(deps).discovered, 0)

    def test_malformed_incident_input_creates_exactly_one_failed_row(self):
        for label, mutate in (
            ("missing field", lambda raw: raw.incident.pop("trigger_rule")),
            ("bad timestamp", lambda raw: raw.incident.update(started_at="not a timestamp")),
            ("bad evidence", lambda raw: raw.evidence[1].pop("summary")),
            ("bad deployment", lambda raw: raw.deployment.pop("new_version")),
        ):
            with self.subTest(case=label):
                raw = raw_fixture()
                mutate(raw)
                repo = FakeRepo({I1: raw})
                outcome = process_incident(candidate(), make_deps(repo))
                self.assertEqual(outcome, Outcome("written", "failed"))
                self.assertEqual(len(repo.rows), 1)
                self.assert_dead_letter(repo.rows[0], "invalid_incident")
                self.assertEqual(repo.rows[0].input_digest, "")

    def test_an_incident_that_cannot_be_found_is_invalid_not_transient(self):
        repo = FakeRepo({})
        outcome = process_incident(candidate(I2), make_deps(repo))
        self.assertEqual(outcome, Outcome("written", "failed"))
        self.assert_dead_letter(repo.rows[0], "invalid_incident", incident_id=I2)

    def test_a_dead_letter_write_that_fails_transiently_is_retried(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.write_failures = [ClickHouseTransient("down")]
        deps = make_deps(repo, provider=FabricatingProvider())
        self.assertEqual(process_incident(candidate(), deps).kind, "transient")
        self.assertEqual(repo.rows, [])
        self.assertEqual(process_incident(candidate(), deps), Outcome("written", "failed"))
        self.assertEqual(len(repo.rows), 1)

    def test_a_permanent_failure_row_has_the_columns_the_table_requires(self):
        repo = FakeRepo({I1: raw_fixture()})
        process_incident(candidate(), make_deps(repo, provider=FabricatingProvider()))
        row = repo.rows[0]
        self.assertEqual((row.provider, row.model_version, row.prompt_version), ("deterministic", "deterministic-rules-1", "none"))


class AbstentionTest(unittest.TestCase):
    def test_insufficient_or_unknown_evidence_is_an_abstained_row_never_a_failed_one(self):
        for fixture in ("two_traces_only", "deployment_missing", "unknown_rule", "late_failure"):
            with self.subTest(fixture=fixture):
                repo = FakeRepo({I1: raw_fixture(fixture)})
                outcome = process_incident(candidate(), make_deps(repo))
                self.assertEqual(outcome, Outcome("written", "abstained"))
                row = repo.rows[0]
                self.assertEqual((row.status, row.confidence, row.failure_code), ("abstained", "low", ""))
                self.assertNotEqual(row.document, "")
                document = row_document(row)
                self.assertTrue(document["abstain"])
                validate(document, build_bundle(raw_fixture(fixture)))

    def test_an_abstained_incident_is_not_diagnosed_again_under_the_same_analyzer(self):
        repo = FakeRepo({I1: raw_fixture("unknown_rule")})
        deps = make_deps(repo)
        run_cycle(deps)
        self.assertEqual(run_cycle(deps).discovered, 0)
        self.assertEqual(len(repo.rows), 1)


class RevisionTest(unittest.TestCase):
    def test_a_new_analyzer_writes_version_two_and_keeps_version_one(self):
        repo = FakeRepo({I1: raw_fixture()})
        first = make_deps(repo, AGENT_REVISION_POLICY="on-analyzer-change")
        run_cycle(first)
        self.assertEqual([r.diagnosis_version for r in repo.rows], [1])
        v1 = repo.rows[0]

        second = make_deps(repo, provider=AlternateProvider(), AGENT_REVISION_POLICY="on-analyzer-change")
        result = run_cycle(second)
        self.assertEqual(result.written, 1)
        self.assertEqual([r.diagnosis_version for r in repo.rows], [1, 2])
        self.assertIs(repo.rows[0], v1)
        v2 = repo.rows[1]
        self.assertEqual(v2.diagnosis_id, diagnosis_id(I1, 2))
        self.assertNotEqual(v2.diagnosis_id, v1.diagnosis_id)
        self.assertEqual(v2.analyzer_id, "deterministic|deterministic-rules-2|none")
        self.assertEqual(row_document(v2)["diagnosis_version"], 2)
        self.assertEqual(repo.discover_calls[-1], (5, "on-analyzer-change", "deterministic|deterministic-rules-2|none"))

    def test_the_same_analyzer_never_revises_and_a_second_pass_is_quiet(self):
        repo = FakeRepo({I1: raw_fixture()})
        deps = make_deps(repo, provider=AlternateProvider(), AGENT_REVISION_POLICY="on-analyzer-change")
        run_cycle(deps)
        self.assertEqual(run_cycle(deps).discovered, 0)
        self.assertEqual(len(repo.rows), 1)

    def test_first_only_never_revises_even_for_a_different_analyzer(self):
        repo = FakeRepo({I1: raw_fixture()})
        run_cycle(make_deps(repo))
        result = run_cycle(make_deps(repo, provider=AlternateProvider()))
        self.assertEqual((result.discovered, result.written), (0, 0))
        self.assertEqual(len(repo.rows), 1)

    def test_a_new_analyzer_also_re_attempts_a_failed_incident(self):
        repo = FakeRepo({I1: raw_fixture()})
        run_cycle(make_deps(repo, provider=FabricatingProvider(), AGENT_REVISION_POLICY="on-analyzer-change"))
        self.assertEqual(repo.rows[0].status, "failed")
        run_cycle(make_deps(repo, provider=AlternateProvider(), AGENT_REVISION_POLICY="on-analyzer-change"))
        self.assertEqual([(r.diagnosis_version, r.status) for r in repo.rows], [(1, "failed"), (2, "completed")])


class StopTest(unittest.TestCase):
    def test_a_stop_request_ends_the_cycle_after_the_current_incident_not_mid_incident(self):
        repo = FakeRepo({I1: raw_fixture(incident_id=I1), I2: raw_fixture(incident_id=I2), I3: raw_fixture(incident_id=I3)})
        stop = threading.Event()
        deps = make_deps(repo, provider=StoppingProvider(stop), stop=stop)
        result = run_cycle(deps)
        self.assertTrue(result.stopped)
        self.assertEqual([r.incident_id for r in repo.rows], [I1], "the incident in progress finished and was written")
        self.assertEqual(repo.load_calls, [I1], "no further incident was started")
        self.assertEqual(len(deps.touches), 1)

    def test_the_loop_returns_zero_after_a_stop_without_another_cycle(self):
        repo = FakeRepo({I1: raw_fixture(incident_id=I1), I2: raw_fixture(incident_id=I2)})
        stop = threading.Event()
        deps = make_deps(repo, provider=StoppingProvider(stop), stop=stop)
        self.assertEqual(run(deps.config, stop, deps), 0)
        self.assertEqual(len(repo.rows), 1)
        self.assertEqual(len(repo.discover_calls), 1)

    def test_a_stop_requested_before_the_start_returns_zero_at_once(self):
        repo = FakeRepo({I1: raw_fixture()})
        stop = threading.Event()
        stop.set()
        deps = make_deps(repo, stop=stop)
        self.assertEqual(run(deps.config, stop, deps), 0)
        self.assertEqual((repo.rows, repo.discover_calls), ([], []))

    def test_a_stop_during_the_wait_between_cycles_ends_the_loop(self):
        repo = FakeRepo()
        stop = threading.Event()
        deps = make_deps(repo, stop=stop, stop_when=lambda: len(deps.fake_time.waits) >= 3)
        self.assertEqual(run(deps.config, stop, deps), 0)
        self.assertEqual(deps.fake_time.waits, [2, 2, 2])
        self.assertEqual(len(deps.touches), 3)


class HeartbeatTest(unittest.TestCase):
    def test_a_cycle_with_no_work_still_touches_the_heartbeat(self):
        deps = make_deps(FakeRepo(), AGENT_HEARTBEAT_PATH="/tmp/fake-heartbeat")
        result = run_cycle(deps)
        self.assertEqual((result.discovered, result.written), (0, 0))
        self.assertEqual(deps.touches, ["/tmp/fake-heartbeat"])

    def test_every_complete_cycle_touches_it_once_whatever_happened(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.load_failures = [ClickHouseTransient("down")]
        deps = make_deps(repo)
        run_cycle(deps)
        run_cycle(deps)
        run_cycle(deps)
        self.assertEqual(len(deps.touches), 3)

    def test_a_heartbeat_that_cannot_be_written_is_logged_and_does_not_stop_the_loop(self):
        def broken(path):
            raise OSError("read-only file system")

        deps = make_deps(FakeRepo())
        deps.touch_heartbeat = broken
        run_cycle(deps)
        records = deps.sink.records()
        self.assertEqual([r["message"] for r in records], ["heartbeat could not be written"])
        self.assertEqual(records[0]["error_class"], "OSError")

    def test_a_real_file_is_created_and_refreshed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "heartbeat")
            self.assertFalse(os.path.exists(path))
            touch_heartbeat(path)
            self.assertTrue(os.path.exists(path))
            os.utime(path, (1_000, 1_000))
            touch_heartbeat(path)
            self.assertGreater(os.stat(path).st_mtime, 1_000_000)


class HealthcheckTest(unittest.TestCase):
    def fresh(self, age, poll):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "heartbeat")
            touch_heartbeat(path)
            os.utime(path, (5_000, 5_000))
            return heartbeat_is_fresh(path, poll, now=5_000 + age)

    def test_a_missing_file_is_not_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIs(heartbeat_is_fresh(os.path.join(tmp, "nope"), 2, now=1.0), False)

    def test_the_threshold_is_the_larger_of_10_seconds_and_three_poll_intervals(self):
        cases = [(2, 10), (3, 10), (4, 12), (5, 15), (10, 30), (60, 180)]
        for poll, threshold in cases:
            with self.subTest(poll=poll):
                self.assertIs(self.fresh(0, poll), True)
                self.assertIs(self.fresh(threshold, poll), True, "exactly at the threshold is still fresh")
                self.assertIs(self.fresh(threshold + 1, poll), False)
                self.assertIs(self.fresh(threshold + 0.01, poll), False)

    def test_a_far_future_timestamp_is_not_trusted(self):
        self.assertIs(self.fresh(-1_000, 2), False)
        self.assertIs(self.fresh(-1, 2), True)

    def test_the_default_clock_is_the_real_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "heartbeat")
            touch_heartbeat(path)
            self.assertIs(heartbeat_is_fresh(path, 2), True)
            os.utime(path, (1_000, 1_000))
            self.assertIs(heartbeat_is_fresh(path, 2), False)

    def test_healthcheck_exits_zero_only_when_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "heartbeat")
            env = {**BASE_ENV, "AGENT_HEARTBEAT_PATH": path}
            self.assertEqual(cli.main(["healthcheck"], env=env, stderr=io.StringIO(), install_signals=False), 1)
            touch_heartbeat(path)
            self.assertEqual(cli.main(["healthcheck"], env=env, stderr=io.StringIO(), install_signals=False), 0)
            os.utime(path, (1_000, 1_000))
            self.assertEqual(cli.main(["healthcheck"], env=env, stderr=io.StringIO(), install_signals=False), 1)


class StartupTest(unittest.TestCase):
    def test_run_exits_3_when_the_table_never_becomes_ready_within_120_fake_seconds(self):
        repo = FakeRepo({I1: raw_fixture()})
        repo.ready = False
        stop = threading.Event()
        deps = make_deps(repo, stop=stop)
        self.assertEqual(run(deps.config, stop, deps), 3)
        self.assertGreaterEqual(deps.fake_time.t, 120)
        self.assertLess(deps.fake_time.t, 130)
        self.assertGreater(repo.ready_calls, 30)
        self.assertEqual((repo.discover_calls, repo.rows), ([], []))
        self.assertTrue(any(r["message"] == "the diagnoses table never became ready" for r in deps.sink.records()))

    def test_run_proceeds_as_soon_as_the_table_becomes_ready(self):
        repo = FakeRepo({I1: raw_fixture()})
        answers = [False, False, False, True]
        repo.ready = lambda: answers.pop(0) if answers else True
        stop = threading.Event()
        deps = make_deps(repo, stop=stop, stop_when=lambda: bool(repo.rows))
        self.assertEqual(run(deps.config, stop, deps), 0)
        self.assertEqual(len(repo.rows), 1)
        self.assertLess(deps.fake_time.waits[0], 10)
        self.assertEqual(repo.ready_calls, 4)

    def test_a_not_yet_migrated_server_and_connection_errors_count_as_not_ready(self):
        for failure in (ClickHouseRejected("no table", code=60, status=404), ClickHouseTransient("down"), ClickHouseRejected("denied", code=497, status=403)):
            with self.subTest(failure=type(failure).__name__):
                repo = FakeRepo()
                repo.ready = lambda f=failure: f
                stop = threading.Event()
                deps = make_deps(repo, stop=stop)
                self.assertEqual(run(deps.config, stop, deps), 3)

    def test_the_readiness_probe_only_uses_the_repository(self):
        repo = FakeRepo()
        stop = threading.Event()
        deps = make_deps(repo, stop=stop, stop_when=lambda: True)
        run(deps.config, stop, deps)
        self.assertGreaterEqual(repo.ready_calls, 1)

    def test_an_unimplemented_provider_is_a_startup_error_with_exit_code_2(self):
        config = config_for(
            AGENT_PROVIDER="openai-compatible",
            AGENT_PROVIDER_BASE_URL="http://localhost:8000",
            AGENT_PROVIDER_MODEL="some-model",
            AGENT_PROVIDER_API_KEY=PROVIDER_KEY,
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            self.assertEqual(run(config, threading.Event()), 2)
        self.assertNotIn(PROVIDER_KEY, out.getvalue())
        self.assertNotIn(PASSWORD, out.getvalue())
        for line in out.getvalue().splitlines():
            self.assertLessEqual(set(json.loads(line)), ALLOWED_LOG_KEYS)

    def test_default_dependencies_are_built_without_any_network_activity(self):
        config = config_for()
        deps = orchestrator_module.default_deps(config, threading.Event())
        from signalforge_agent.repository import Repository

        self.assertIsInstance(deps.repository, Repository)
        self.assertIsInstance(deps.provider, DeterministicProvider)
        self.assertIs(deps.config, config)
        self.assertEqual(deps.now().tzinfo, timezone.utc)


class LoggingTest(unittest.TestCase):
    def busy_run(self):
        repo = FakeRepo({
            I1: raw_fixture(incident_id=I1),
            I2: raw_fixture("unknown_rule", incident_id=I2),
            I3: raw_fixture(incident_id=I3),
        })
        repo.load_failures = [ClickHouseTransient(f"cannot connect with {PASSWORD}")]
        repo.write_failures = [None, ClickHouseRejected(f"rejected {PASSWORD}", code=497, status=403)]
        repo.discover_failures = [None, None, ClickHouseTransient(f"down {PASSWORD}")]
        stop = threading.Event()
        deps = make_deps(repo, stop=stop, stop_when=lambda: len(deps.fake_time.waits) >= 6)
        run(deps.config, stop, deps)
        # A dead letter and a rejection too.
        malformed = raw_fixture(incident_id="11111111-2222-4333-8444-555555555555")
        malformed.incident.pop("title")
        repo.raw["11111111-2222-4333-8444-555555555555"] = malformed
        repo.raw["22222222-3333-4444-8555-666666666666"] = raw_fixture(incident_id="22222222-3333-4444-8555-666666666666")
        stop2 = threading.Event()
        deps2 = make_deps(repo, provider=FabricatingProvider(), stop=stop2, sink=deps.sink, stop_when=lambda: True)
        deps2.sink = deps.sink
        run(deps2.config, stop2, deps2)
        return repo, deps

    def test_every_line_is_one_json_object_with_only_the_allowed_keys(self):
        _repo, deps = self.busy_run()
        self.assertGreater(len(deps.sink.lines), 5)
        for line in deps.sink.lines:
            self.assertNotIn("\n", line)
            record = json.loads(line)
            self.assertIsInstance(record, dict)
            self.assertLessEqual(set(record), ALLOWED_LOG_KEYS)
            self.assertIn(record["level"], LOG_LEVELS)
            self.assertIsInstance(record["message"], str)
            if "incident_id" in record:
                self.assertRegex(record["incident_id"], r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
            if "attempt" in record:
                self.assertIsInstance(record["attempt"], int)
                self.assertGreaterEqual(record["attempt"], 1)
            if "error_class" in record:
                self.assertRegex(record["error_class"], r"^[A-Za-z_][A-Za-z0-9_]*$")

    def test_every_message_is_one_of_the_fixed_messages(self):
        _repo, deps = self.busy_run()
        for record in deps.sink.records():
            message = record["message"]
            self.assertTrue(message in LOG_MESSAGES or REJECTION_MESSAGE.match(message), message)

    def test_the_logger_refuses_an_unknown_message_or_key(self):
        logger = JsonLogger(Sink())
        with self.assertRaises(ValueError):
            logger.info("some new free text with a document")
        with self.assertRaises(TypeError):
            logger.info("agent started", document="x")  # type: ignore[call-arg]
        with self.assertRaises(ValueError):
            logger.info("agent started", incident_id="not a uuid")
        with self.assertRaises(ValueError):
            logger.info("agent started", error_class="Bad Class; DROP")

    def test_no_document_bundle_telemetry_or_secret_ever_reaches_a_log_line(self):
        repo, deps = self.busy_run()
        text = "\n".join(deps.sink.lines)
        raw = raw_fixture()
        forbidden = [PASSWORD, PROVIDER_KEY, DEPLOYMENT_ID_FOR_LEAKS, "Payments deployment", "0.2.0-faulty", "introduced an HTTP 500",
                     "returned HTTP 500 for trace", "deployment_succeeded", "reasoning_summary", "primary_hypothesis",
                     "supporting_claims", "evidence_ids", "sha256:", "charge failed", "request received", "POST /payments/charge",
                     "order_id", "http.request", "RAW-BODY-MARKER", "Bearer"]
        forbidden += [row["source_ref"] for row in raw.evidence if row["source_type"] == "trace"]
        forbidden += [row["summary"] for row in raw.evidence]
        for needle in forbidden:
            with self.subTest(needle=needle[:40]):
                self.assertNotIn(needle, text)
        for row in repo.rows:
            if row.document:
                self.assertNotIn(row.document[:60], text)

    def test_no_secret_in_the_configuration_is_ever_logged(self):
        config = config_for(
            AGENT_PROVIDER="openai-compatible",
            AGENT_PROVIDER_BASE_URL="https://api.example.test/v1",
            AGENT_PROVIDER_MODEL="some-model",
            AGENT_PROVIDER_API_KEY=PROVIDER_KEY,
            AGENT_PROVIDER_ALLOW_EXTERNAL="yes",
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            run(config, threading.Event())
        self.assertNotIn(PROVIDER_KEY, out.getvalue())
        self.assertNotIn(PASSWORD, out.getvalue())
        self.assertNotIn("api.example.test", out.getvalue())


DEPLOYMENT_ID_FOR_LEAKS = "57d9bf44-46c0-46e9-8140-4a7b9f3694a8"


class CliTest(unittest.TestCase):
    def call(self, argv, env=None, **kwargs):
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(argv, env=BASE_ENV if env is None else env, stdout=out, stderr=err, install_signals=False, **kwargs)
        return code, out.getvalue(), err.getvalue()

    def test_run_dispatches_to_run_with_the_loaded_configuration_and_a_stop_event(self):
        seen = {}

        def fake_run(config, stop):
            seen.update(config=config, stop=stop)
            return 7

        code, _out, _err = self.call(["run"], run_fn=fake_run)
        self.assertEqual(code, 7)
        self.assertEqual(seen["config"].user, "agent_writer")
        self.assertIsInstance(seen["stop"], threading.Event)
        self.assertFalse(seen["stop"].is_set())

    def test_healthcheck_dispatches_to_the_health_function(self):
        seen = {}

        def fake_health(config):
            seen["config"] = config
            return 0

        code, *_ = self.call(["healthcheck"], healthcheck_fn=fake_health)
        self.assertEqual(code, 0)
        self.assertEqual(seen["config"].heartbeat_path, "/tmp/agent-heartbeat")

    def test_exactly_two_commands_are_supported(self):
        for argv in ([], ["bogus"], ["run", "extra"], ["healthcheck", "--now"], ["RUN"], ["--help"], ["run", "healthcheck"], [""]):
            with self.subTest(argv=argv):
                called = []
                code, out, err = self.call(argv, run_fn=lambda c, s: called.append("run") or 0, healthcheck_fn=lambda c: called.append("health") or 0)
                self.assertEqual(code, 2)
                self.assertEqual(called, [])
                self.assertIn("usage: python -m signalforge_agent {run|healthcheck}", err)
                self.assertEqual(out, "")

    def test_a_configuration_error_is_exit_2_for_run_and_never_echoes_a_value(self):
        env = {**BASE_ENV, "AGENT_POLL_INTERVAL_S": "SENTINEL-bad-value"}
        called = []
        code, out, err = self.call(["run"], env=env, run_fn=lambda c, s: called.append(1) or 0)
        self.assertEqual(code, 2)
        self.assertEqual(called, [])
        for line in err.splitlines():
            record = json.loads(line)
            self.assertLessEqual(set(record), ALLOWED_LOG_KEYS)
        self.assertIn("AGENT_POLL_INTERVAL_S", err)
        self.assertNotIn("SENTINEL", err + out)
        self.assertNotIn(PASSWORD, err + out)

    def test_a_missing_required_setting_is_exit_2_for_run(self):
        code, _out, err = self.call(["run"], env={"CLICKHOUSE_USER": "u", "CLICKHOUSE_PASSWORD": PASSWORD})
        self.assertEqual(code, 2)
        self.assertIn("CLICKHOUSE_URL", err)
        self.assertNotIn(PASSWORD, err)

    def test_a_configuration_error_is_unhealthy_exit_1_for_the_healthcheck(self):
        code, _out, err = self.call(["healthcheck"], env={})
        self.assertEqual(code, 1)
        self.assertNotIn(PASSWORD, err)

    def test_the_signal_handlers_set_the_stop_event(self):
        stop = threading.Event()
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            cli._install_signal_handlers(stop)
            for sig in (signal.SIGTERM, signal.SIGINT):
                stop.clear()
                signal.getsignal(sig)(sig, None)
                self.assertTrue(stop.is_set())
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)

    def test_main_reads_the_process_environment_only_when_no_environment_is_given(self):
        before = dict(os.environ)
        os.environ.update(BASE_ENV)
        try:
            out, err = io.StringIO(), io.StringIO()
            code = cli.main(["run"], stdout=out, stderr=err, install_signals=False, run_fn=lambda c, s: 5)
            self.assertEqual(code, 5)
        finally:
            os.environ.clear()
            os.environ.update(before)


class SafetyTest(unittest.TestCase):
    MODULES = (orchestrator_module, provider_module, health_module, cli)

    def imports_of(self, module):
        tree = ast.parse(inspect.getsource(module))
        names = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        names |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        return names

    def test_no_new_module_adds_a_server_a_socket_a_kafka_client_or_a_provider_client(self):
        banned = {"socket", "ssl", "http", "http.server", "http.client", "urllib", "urllib.request", "subprocess", "asyncio",
                  "socketserver", "wsgiref", "requests", "openai", "kafka", "confluent_kafka", "aiohttp"}
        for module in self.MODULES:
            with self.subTest(module=module.__name__):
                self.assertFalse(self.imports_of(module) & banned, self.imports_of(module) & banned)

    def test_no_new_module_starts_a_thread_or_a_listener(self):
        for module in self.MODULES:
            source = inspect.getsource(module)
            with self.subTest(module=module.__name__):
                for needle in ("Thread(", "serve_forever", ".listen(", "HTTPServer", "bind("):
                    self.assertNotIn(needle, source)

    def test_the_only_writer_is_the_repository_write_method(self):
        source = inspect.getsource(orchestrator_module)
        self.assertIn("repository.write(", source)
        for needle in (".insert(", "INSERT", "DELETE", "UPDATE", "DROP", "ALTER", "TRUNCATE"):
            self.assertNotIn(needle, source)

    def test_the_diagnosis_loop_reads_the_environment_nowhere(self):
        for module in (orchestrator_module, provider_module):
            self.assertNotIn("os.environ", inspect.getsource(module))
            self.assertNotIn("getenv", inspect.getsource(module))


if __name__ == "__main__":
    unittest.main()
