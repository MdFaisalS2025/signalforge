import copy
import dataclasses
import json
import re
import unittest
from pathlib import Path

from signalforge_agent import repository as repository_module
from signalforge_agent.bundle import (
    MAX_EVIDENCE_ROWS,
    MAX_LOG_ROWS,
    MAX_SPAN_ROWS,
    MAX_TRACES,
    RawIncidentData,
    build_bundle,
)
from signalforge_agent.chclient import ClickHouseRejected, ClickHouseTransient
from signalforge_agent.repository import (
    SQL_DEPLOYMENT,
    SQL_DISCOVER_NEW,
    SQL_DISCOVER_REVISE,
    SQL_EVIDENCE,
    SQL_EXISTS,
    SQL_INCIDENT,
    SQL_LOGS,
    SQL_SPANS,
    SQL_TABLE_READY,
    Candidate,
    DiagnosisRow,
    Repository,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"

INCIDENT_ID = "5893b198-6ad5-5708-bb7e-a0d2ca4ca323"
OTHER_ID = "a1b2c3d4-e5f6-4789-90ab-cdef01234567"
THIRD_ID = "0f1e2d3c-4b5a-4968-8777-665544332211"
DEPLOYMENT_ID = "57d9bf44-46c0-46e9-8140-4a7b9f3694a8"
TRACE_1 = "eb4c8089a40f3ea443eb8e1943d5f748"
TRACE_2 = "3e4946423e28e19638784270ccf11595"
TRACE_3 = "c88ce7356a2a057bc0d7cec4ed43588f"

ALL_SQL = {
    "SQL_TABLE_READY": SQL_TABLE_READY,
    "SQL_DISCOVER_NEW": SQL_DISCOVER_NEW,
    "SQL_DISCOVER_REVISE": SQL_DISCOVER_REVISE,
    "SQL_INCIDENT": SQL_INCIDENT,
    "SQL_EVIDENCE": SQL_EVIDENCE,
    "SQL_DEPLOYMENT": SQL_DEPLOYMENT,
    "SQL_SPANS": SQL_SPANS,
    "SQL_LOGS": SQL_LOGS,
    "SQL_EXISTS": SQL_EXISTS,
}

# The approved statements, whitespace-normalized: spec sections 6.2, 6.3, and 8.2, and 8.3 for the existence check.
EXPECTED_SQL = {
    "SQL_TABLE_READY": "SELECT 1 FROM diagnoses LIMIT 0",
    "SQL_DISCOVER_NEW": (
        "SELECT incident_id, deployment_id, trigger_rule, detected_at FROM incidents FINAL "
        "WHERE publication_state = 'published' AND incident_id NOT IN (SELECT incident_id FROM diagnoses) "
        "ORDER BY detected_at ASC LIMIT {batch:UInt32}"
    ),
    "SQL_DISCOVER_REVISE": (
        "SELECT incident_id, latest_version FROM ( "
        "SELECT incident_id, diagnosis_version AS latest_version, analyzer_id FROM diagnoses FINAL "
        "ORDER BY diagnosis_version DESC LIMIT 1 BY incident_id ) "
        "WHERE analyzer_id != {analyzer_id:String} LIMIT {batch:UInt32}"
    ),
    "SQL_INCIDENT": (
        "SELECT incident_id, revision, title, status, severity, service, environment, deployment_id, trigger_rule, "
        "started_at, detected_at FROM incidents FINAL WHERE incident_id = {incident_id:UUID} LIMIT 1"
    ),
    "SQL_EVIDENCE": (
        "SELECT evidence_id, source_type, source_ref, timestamp, service, summary, reliability FROM evidence_items FINAL "
        "WHERE incident_id = {incident_id:UUID} ORDER BY timestamp, source_type, source_ref LIMIT 8"
    ),
    "SQL_DEPLOYMENT": (
        "SELECT deployment_id, timestamp, service, environment, new_version, status FROM deployments FINAL "
        "WHERE toString(deployment_id) = {deployment_id:String} LIMIT 1"
    ),
    "SQL_SPANS": (
        "SELECT timestamp, trace_id, span_id, deployment_id, JSONExtractRaw(attributes, 'span.kind') AS span_kind, "
        "JSONExtractRaw(attributes, 'span.name') AS span_name, "
        "JSONExtractRaw(attributes, 'http.response.status_code') AS status_code FROM telemetry_events FINAL "
        "WHERE type = 'trace' AND service = 'demo-payments' AND trace_id IN {trace_ids:Array(String)} "
        "ORDER BY timestamp, span_id LIMIT 30"
    ),
    "SQL_LOGS": (
        "SELECT timestamp, trace_id, severity, JSONExtractRaw(attributes, 'log.body') AS log_body FROM telemetry_events FINAL "
        "WHERE type = 'log' AND service = 'demo-payments' AND trace_id IN {trace_ids:Array(String)} "
        "ORDER BY timestamp, severity LIMIT 30"
    ),
    "SQL_EXISTS": (
        "SELECT count() AS n FROM diagnoses WHERE incident_id = {incident_id:UUID} "
        "AND diagnosis_version = {diagnosis_version:UInt32} LIMIT 1"
    ),
}

ALLOWED_LITERALS = {"published", "trace", "log", "demo-payments", "span.kind", "span.name", "http.response.status_code", "log.body"}

# Every statement any test sends is recorded here, and tearDownModule proves none was anything but a SELECT or the one INSERT.
EVERY_CALL = []


def normalize(sql):
    return " ".join(sql.split())


class FakeClient:
    def __init__(self, handler=None):
        self.calls = []
        self.handler = handler or (lambda sql, params: [])

    def query(self, sql, params=None):
        params = dict(params or {})
        self.calls.append(("query", sql, params))
        EVERY_CALL.append(("query", sql, params))
        result = self.handler(sql, params)
        if isinstance(result, BaseException):
            raise result
        return result

    def insert(self, table, rows):
        recorded = ("insert", table, [dict(row) for row in rows])
        self.calls.append(recorded)
        EVERY_CALL.append(recorded)

    def queries(self):
        return [call for call in self.calls if call[0] == "query"]

    def inserts(self):
        return [call for call in self.calls if call[0] == "insert"]


def tearDownModule():
    assert EVERY_CALL, "the repository tests sent nothing"
    for call in EVERY_CALL:
        if call[0] == "query":
            assert call[1] in ALL_SQL.values(), f"a statement that is not a repository constant: {call[1]!r}"
            assert call[1].lstrip().upper().startswith("SELECT"), call[1]
        else:
            assert call[0] == "insert" and call[1] == "diagnoses" and len(call[2]) == 1, call[:2]


def raw_fixture(name="faulty_deploy_full"):
    data = json.loads((FIXTURES / f"raw_{name}.json").read_text(encoding="utf-8"))
    return RawIncidentData(
        incident=data["incident"], evidence=data["evidence"], deployment=data["deployment"], spans=data["spans"], logs=data["logs"]
    )


INCIDENT_COLUMNS = ["incident_id", "revision", "title", "status", "severity", "service", "environment", "deployment_id",
                    "trigger_rule", "started_at", "detected_at"]
EVIDENCE_COLUMNS = ["evidence_id", "source_type", "source_ref", "timestamp", "service", "summary", "reliability"]
DEPLOYMENT_COLUMNS = ["deployment_id", "timestamp", "service", "environment", "new_version", "status"]


def raw_json_text(attributes, key):
    """What JSONExtractRaw returns: the raw JSON text of the value, or an empty string when the key is absent."""
    data = json.loads(attributes)
    return json.dumps(data[key]) if key in data else ""


def warehouse(raw, hostile_rows=None):
    """A handler that answers the repository's queries from a raw fixture, projecting only the columns each SELECT names."""

    def handler(sql, params):
        if sql == SQL_INCIDENT:
            if params["incident_id"] != raw.incident["incident_id"]:
                return []
            return [{column: raw.incident[column] for column in INCIDENT_COLUMNS}]
        if sql == SQL_EVIDENCE:
            rows = sorted(raw.evidence, key=lambda r: (r["timestamp"], r["source_type"], r["source_ref"]))[:8]
            return [{column: row[column] for column in EVIDENCE_COLUMNS} for row in rows]
        if sql == SQL_DEPLOYMENT:
            if raw.deployment is None or raw.deployment["deployment_id"] != params["deployment_id"]:
                return []
            return [{column: raw.deployment[column] for column in DEPLOYMENT_COLUMNS}]
        if sql == SQL_SPANS:
            wanted = set(params["trace_ids"])
            rows = sorted((r for r in raw.spans if r["trace_id"] in wanted), key=lambda r: (r["timestamp"], r["span_id"]))[:30]
            return [
                {
                    "timestamp": r["timestamp"], "trace_id": r["trace_id"], "span_id": r["span_id"], "deployment_id": r["deployment_id"],
                    "span_kind": raw_json_text(r["attributes"], "span.kind"),
                    "span_name": raw_json_text(r["attributes"], "span.name"),
                    "status_code": raw_json_text(r["attributes"], "http.response.status_code"),
                }
                for r in rows
            ]
        if sql == SQL_LOGS:
            wanted = set(params["trace_ids"])
            rows = sorted((r for r in raw.logs if r["trace_id"] in wanted), key=lambda r: (r["timestamp"], r["severity"]))[:30]
            return [
                {"timestamp": r["timestamp"], "trace_id": r["trace_id"], "severity": r["severity"],
                 "log_body": raw_json_text(r["attributes"], "log.body")}
                for r in rows
            ]
        return []

    return handler


def candidate_ids(candidates):
    return [(c.incident_id, c.next_version) for c in candidates]


class SqlConstantsTest(unittest.TestCase):
    def test_every_named_constant_exists_and_is_a_plain_string(self):
        for name, sql in ALL_SQL.items():
            with self.subTest(name=name):
                self.assertIsInstance(sql, str)
                self.assertIs(getattr(repository_module, name), sql)

    def test_every_statement_matches_the_approved_text(self):
        for name, expected in EXPECTED_SQL.items():
            with self.subTest(name=name):
                self.assertEqual(normalize(ALL_SQL[name]), expected)

    def test_every_statement_has_a_bounded_limit_that_matches_the_approved_bound(self):
        limits = {
            "SQL_TABLE_READY": "0",
            "SQL_DISCOVER_NEW": "{batch:UInt32}",
            "SQL_DISCOVER_REVISE": "{batch:UInt32}",
            "SQL_INCIDENT": "1",
            "SQL_EVIDENCE": str(MAX_EVIDENCE_ROWS),
            "SQL_DEPLOYMENT": "1",
            "SQL_SPANS": str(MAX_SPAN_ROWS),
            "SQL_LOGS": str(MAX_LOG_ROWS),
            "SQL_EXISTS": "1",
        }
        for name, expected in limits.items():
            with self.subTest(name=name):
                found = re.findall(r"LIMIT (\S+)\s*$", normalize(ALL_SQL[name]))
                self.assertEqual(found, [expected])
        self.assertEqual((MAX_EVIDENCE_ROWS, MAX_SPAN_ROWS, MAX_LOG_ROWS, MAX_TRACES), (8, 30, 30, 3))

    def test_the_latest_revision_is_read_with_final_exactly_where_the_spec_requires(self):
        for name in ("SQL_DISCOVER_NEW", "SQL_INCIDENT"):
            self.assertIn("FROM incidents FINAL", normalize(ALL_SQL[name]), name)
        self.assertIn("FROM evidence_items FINAL", normalize(SQL_EVIDENCE))
        self.assertIn("FROM deployments FINAL", normalize(SQL_DEPLOYMENT))
        for name in ("SQL_SPANS", "SQL_LOGS"):
            self.assertIn("FROM telemetry_events FINAL", normalize(ALL_SQL[name]), name)
        self.assertIn("FROM diagnoses FINAL", normalize(SQL_DISCOVER_REVISE))
        # Any row for an incident means it is handled, so the NOT IN subquery and the exact-key count do not use FINAL.
        self.assertIn("(SELECT incident_id FROM diagnoses)", normalize(SQL_DISCOVER_NEW))
        self.assertNotIn("FINAL", normalize(SQL_EXISTS))

    def test_every_external_value_uses_a_typed_placeholder_and_nothing_else_in_braces(self):
        for name, sql in ALL_SQL.items():
            with self.subTest(name=name):
                braces = re.findall(r"\{[^{}]*\}", sql)
                for brace in braces:
                    self.assertRegex(brace, r"^\{[a-z_]+:[A-Za-z0-9_()]+\}$")
                self.assertEqual(sql.count("{"), sql.count("}"))
                self.assertEqual(sql.count("{"), len(braces))

    def test_the_only_quoted_literals_are_the_fixed_constants_of_the_rule(self):
        for name, sql in ALL_SQL.items():
            with self.subTest(name=name):
                for literal in re.findall(r"'([^']*)'", sql):
                    self.assertIn(literal, ALLOWED_LITERALS)

    def test_no_statement_contains_interpolation_concatenation_or_value_syntax(self):
        for name, sql in ALL_SQL.items():
            with self.subTest(name=name):
                for needle in ("%s", "%(", "%d", "{}", "${", "format(", "concat(", "||", "VALUES", "--", "/*", ";"):
                    self.assertNotIn(needle, sql)
                self.assertNotRegex(sql, r"\bf['\"]")
                for fixture_value in (INCIDENT_ID, DEPLOYMENT_ID, TRACE_1, "0.2.0-faulty", "5893b198"):
                    self.assertNotIn(fixture_value, sql)

    def test_every_statement_is_a_select_and_none_can_write_or_change_schema(self):
        for name, sql in ALL_SQL.items():
            with self.subTest(name=name):
                self.assertTrue(sql.lstrip().startswith("SELECT"))
                for word in ("INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "TRUNCATE", "CREATE", "GRANT", "SYSTEM", "OPTIMIZE", "ATTACH", "DETACH", "RENAME"):
                    self.assertNotRegex(sql.upper(), rf"\b{word}\b")

    def test_the_revision_query_picks_the_latest_row_before_comparing_the_analyzer(self):
        text = normalize(SQL_DISCOVER_REVISE)
        inner = text[text.index("(") + 1 : text.rindex(")")]
        outer = text[text.rindex(")") + 1 :]
        self.assertIn("LIMIT 1 BY incident_id", inner)
        self.assertIn("ORDER BY diagnosis_version DESC", inner)
        self.assertNotIn("analyzer_id !=", inner, "filtering before taking the latest row would select incidents already on this analyzer")
        self.assertIn("WHERE analyzer_id != {analyzer_id:String}", outer)

    def test_the_telemetry_queries_read_only_the_allowlisted_attribute_keys(self):
        keys = re.findall(r"JSONExtractRaw\(attributes, '([^']+)'\)", normalize(SQL_SPANS) + " " + normalize(SQL_LOGS))
        self.assertEqual(sorted(keys), sorted(["span.kind", "span.name", "http.response.status_code", "log.body"]))
        self.assertNotRegex(normalize(SQL_SPANS) + normalize(SQL_LOGS), r"SELECT\s+\*|\battributes\s*[,]\s*\w|,\s*attributes\s+FROM")


class TableReadyTest(unittest.TestCase):
    def test_success_is_true_and_sends_exactly_the_probe(self):
        client = FakeClient()
        self.assertIs(Repository(client).table_ready(), True)
        self.assertEqual(client.calls, [("query", SQL_TABLE_READY, {})])

    def test_an_unknown_table_rejection_is_false(self):
        client = FakeClient(lambda sql, params: ClickHouseRejected("rejected", code=60, status=404))
        self.assertIs(Repository(client).table_ready(), False)

    def test_every_other_rejection_propagates(self):
        for code in (497, 516, 62, 81, None):
            with self.subTest(code=code):
                client = FakeClient(lambda sql, params, c=code: ClickHouseRejected("rejected", code=c, status=403))
                with self.assertRaises(ClickHouseRejected) as ctx:
                    Repository(client).table_ready()
                self.assertEqual(ctx.exception.code, code)

    def test_a_transient_failure_propagates(self):
        client = FakeClient(lambda sql, params: ClickHouseTransient("down"))
        with self.assertRaises(ClickHouseTransient):
            Repository(client).table_ready()

    def test_an_unrelated_error_propagates(self):
        client = FakeClient(lambda sql, params: RuntimeError("bug"))
        with self.assertRaises(RuntimeError):
            Repository(client).table_ready()


class DiscoverTest(unittest.TestCase):
    ANALYZER = "deterministic|deterministic-rules-1|none"

    def rows(self, *ids):
        return [{"incident_id": i, "deployment_id": DEPLOYMENT_ID, "trigger_rule": "r", "detected_at": "2026-10-07 21:49:33.681717455"} for i in ids]

    def test_first_only_sends_only_the_new_incident_query_and_returns_version_one(self):
        client = FakeClient(lambda sql, params: self.rows(INCIDENT_ID, OTHER_ID))
        found = Repository(client).discover(5, "first-only", self.ANALYZER)
        self.assertEqual(client.calls, [("query", SQL_DISCOVER_NEW, {"batch": 5})])
        self.assertEqual(candidate_ids(found), [(INCIDENT_ID, 1), (OTHER_ID, 1)])
        self.assertIsInstance(found[0], Candidate)

    def test_no_work_is_an_empty_list(self):
        self.assertEqual(Repository(FakeClient()).discover(5, "first-only", self.ANALYZER), [])

    def test_on_analyzer_change_also_sends_the_revision_query_with_the_remaining_batch(self):
        def handler(sql, params):
            if sql == SQL_DISCOVER_NEW:
                return self.rows(INCIDENT_ID, OTHER_ID)
            return [{"incident_id": THIRD_ID, "latest_version": 1}]

        client = FakeClient(handler)
        found = Repository(client).discover(5, "on-analyzer-change", self.ANALYZER)
        self.assertEqual(
            client.calls,
            [("query", SQL_DISCOVER_NEW, {"batch": 5}), ("query", SQL_DISCOVER_REVISE, {"analyzer_id": self.ANALYZER, "batch": 3})],
        )
        self.assertEqual(candidate_ids(found), [(INCIDENT_ID, 1), (OTHER_ID, 1), (THIRD_ID, 2)])

    def test_the_revision_gets_latest_plus_one_whatever_the_type_of_the_version(self):
        for latest, expected in ((1, 2), ("1", 2), (7, 8), ("41", 42)):
            with self.subTest(latest=latest):
                def handler(sql, params, latest=latest):
                    return [] if sql == SQL_DISCOVER_NEW else [{"incident_id": INCIDENT_ID, "latest_version": latest}]

                found = Repository(FakeClient(handler)).discover(5, "on-analyzer-change", self.ANALYZER)
                self.assertEqual(candidate_ids(found), [(INCIDENT_ID, expected)])

    def test_with_no_new_incidents_the_revision_query_gets_the_whole_batch(self):
        client = FakeClient(lambda sql, params: [])
        Repository(client).discover(8, "on-analyzer-change", self.ANALYZER)
        self.assertEqual(client.calls[1], ("query", SQL_DISCOVER_REVISE, {"analyzer_id": self.ANALYZER, "batch": 8}))

    def test_a_full_batch_of_new_incidents_leaves_no_room_for_revisions(self):
        client = FakeClient(lambda sql, params: self.rows(INCIDENT_ID, OTHER_ID))
        found = Repository(client).discover(2, "on-analyzer-change", self.ANALYZER)
        self.assertEqual([call[1] for call in client.calls], [SQL_DISCOVER_NEW])
        self.assertEqual(len(found), 2)

    def test_the_total_never_exceeds_the_batch(self):
        def handler(sql, params):
            if sql == SQL_DISCOVER_NEW:
                return self.rows(INCIDENT_ID)
            return [{"incident_id": OTHER_ID, "latest_version": 1}, {"incident_id": THIRD_ID, "latest_version": 3}]

        found = Repository(FakeClient(handler)).discover(3, "on-analyzer-change", self.ANALYZER)
        self.assertLessEqual(len(found), 3)

    def test_first_only_never_sends_the_revision_query_even_when_asked_repeatedly(self):
        client = FakeClient(lambda sql, params: [])
        repo = Repository(client)
        for _ in range(3):
            repo.discover(5, "first-only", self.ANALYZER)
        self.assertTrue(all(call[1] == SQL_DISCOVER_NEW for call in client.calls))

    def test_an_incident_in_both_lists_appears_once(self):
        def handler(sql, params):
            if sql == SQL_DISCOVER_NEW:
                return self.rows(INCIDENT_ID)
            return [{"incident_id": INCIDENT_ID, "latest_version": 1}]

        found = Repository(FakeClient(handler)).discover(5, "on-analyzer-change", self.ANALYZER)
        self.assertEqual(candidate_ids(found), [(INCIDENT_ID, 1)])

    def test_bad_arguments_are_rejected_before_any_query(self):
        cases = [(0, "first-only", self.ANALYZER), (21, "first-only", self.ANALYZER), (-1, "first-only", self.ANALYZER),
                 (True, "first-only", self.ANALYZER), ("5", "first-only", self.ANALYZER), (5.0, "first-only", self.ANALYZER),
                 (5, "always", self.ANALYZER), (5, "", self.ANALYZER), (5, "First-Only", self.ANALYZER),
                 (5, "first-only", ""), (5, "on-analyzer-change", None)]
        for args in cases:
            with self.subTest(args=args):
                client = FakeClient()
                with self.assertRaises(ValueError):
                    Repository(client).discover(*args)
                self.assertEqual(client.calls, [])

    def test_the_largest_batch_is_accepted(self):
        client = FakeClient()
        Repository(client).discover(20, "first-only", self.ANALYZER)
        self.assertEqual(client.calls[0][2], {"batch": 20})

    def test_a_malformed_incident_id_in_a_result_is_rejected_without_echo(self):
        client = FakeClient(lambda sql, params: self.rows("NOT-A-UUID-MARKER"))
        with self.assertRaises(ValueError) as ctx:
            Repository(client).discover(5, "first-only", self.ANALYZER)
        self.assertNotIn("MARKER", str(ctx.exception))

    def test_a_malformed_version_in_a_result_is_rejected(self):
        for latest in ("x", -1, 0, None, True, 1.5):
            with self.subTest(latest=latest):
                def handler(sql, params, latest=latest):
                    return [] if sql == SQL_DISCOVER_NEW else [{"incident_id": INCIDENT_ID, "latest_version": latest}]

                with self.assertRaises(ValueError):
                    Repository(FakeClient(handler)).discover(5, "on-analyzer-change", self.ANALYZER)

    def test_errors_from_the_client_propagate(self):
        client = FakeClient(lambda sql, params: ClickHouseTransient("down"))
        with self.assertRaises(ClickHouseTransient):
            Repository(client).discover(5, "first-only", self.ANALYZER)


class LoadRawTest(unittest.TestCase):
    def load(self, raw, incident_id=INCIDENT_ID):
        client = FakeClient(warehouse(raw))
        return Repository(client).load_raw(incident_id), client

    def test_it_issues_exactly_the_five_bounded_reads_in_order_with_typed_parameters(self):
        _loaded, client = self.load(raw_fixture())
        self.assertEqual(
            client.calls,
            [
                ("query", SQL_INCIDENT, {"incident_id": INCIDENT_ID}),
                ("query", SQL_EVIDENCE, {"incident_id": INCIDENT_ID}),
                ("query", SQL_DEPLOYMENT, {"deployment_id": DEPLOYMENT_ID}),
                ("query", SQL_SPANS, {"trace_ids": [TRACE_1, TRACE_2, TRACE_3]}),
                ("query", SQL_LOGS, {"trace_ids": [TRACE_1, TRACE_2, TRACE_3]}),
            ],
        )

    def test_the_result_is_a_raw_incident_data_in_the_shape_build_bundle_expects(self):
        loaded, _ = self.load(raw_fixture())
        self.assertIsInstance(loaded, RawIncidentData)
        self.assertEqual(set(loaded.incident), set(INCIDENT_COLUMNS))
        self.assertEqual(len(loaded.evidence), 4)
        self.assertEqual(set(loaded.deployment), set(DEPLOYMENT_COLUMNS))

    def test_the_bundle_built_from_the_repository_equals_the_bundle_built_from_the_fixture(self):
        for name in ("faulty_deploy_full", "faulty_deploy_no_telemetry", "two_traces_only", "deployment_missing",
                     "unknown_rule", "late_failure", "prompt_injection_log"):
            with self.subTest(fixture=name):
                raw = raw_fixture(name)
                loaded, _ = self.load(raw)
                self.assertEqual(build_bundle(loaded).canonical_json(), build_bundle(raw_fixture(name)).canonical_json())

    def test_unsafe_columns_and_attributes_never_leave_the_query_so_they_are_not_in_the_raw_data(self):
        loaded, _ = self.load(raw_fixture())
        text = json.dumps(dataclasses.asdict(loaded))
        for needle in ("order_id", "http.request", "RAW-BODY-MARKER", "RAW-TOKEN-MARKER", "Bearer", "initiated_by",
                       "previous_version", "dedup_key", "publication_state", "ingested_at", "STRAY-SPAN-MARKER", "http.route"):
            self.assertNotIn(needle, text)

    def test_span_and_log_rows_carry_only_the_allowlisted_attribute_keys(self):
        loaded, _ = self.load(raw_fixture())
        for span in loaded.spans:
            self.assertEqual(sorted(span), ["attributes", "deployment_id", "span_id", "timestamp", "trace_id"])
            self.assertLessEqual(set(json.loads(span["attributes"])), {"span.kind", "span.name", "http.response.status_code"})
        for log in loaded.logs:
            self.assertEqual(sorted(log), ["attributes", "severity", "timestamp", "trace_id"])
            self.assertLessEqual(set(json.loads(log["attributes"])), {"log.body"})

    def test_extra_columns_a_query_might_return_are_never_copied(self):
        def handler(sql, params):
            rows = warehouse(raw_fixture())(sql, params)
            if sql in (SQL_SPANS, SQL_LOGS):
                return [{**row, "attributes": '{"order_id":"x"}', "order_id": "SECRET-ORDER", "http_request_body": "SECRET-BODY"} for row in rows]
            return rows

        loaded = Repository(FakeClient(handler)).load_raw(INCIDENT_ID)
        self.assertNotIn("SECRET", json.dumps(dataclasses.asdict(loaded)))
        self.assertNotIn("order_id", json.dumps(dataclasses.asdict(loaded)))

    def test_raw_attribute_text_that_is_absent_or_not_json_is_dropped_not_guessed(self):
        def handler(sql, params):
            if sql == SQL_SPANS:
                return [
                    {"timestamp": "2026-10-07 21:49:30.988000000", "trace_id": TRACE_1, "span_id": "a" * 16, "deployment_id": DEPLOYMENT_ID,
                     "span_kind": "", "span_name": "", "status_code": ""},
                    {"timestamp": "2026-10-07 21:49:30.989000000", "trace_id": TRACE_1, "span_id": "b" * 16, "deployment_id": DEPLOYMENT_ID,
                     "span_kind": "server", "span_name": "{broken", "status_code": "5oo"},
                    {"timestamp": "2026-10-07 21:49:30.990000000", "trace_id": TRACE_1, "span_id": "c" * 16, "deployment_id": DEPLOYMENT_ID,
                     "span_kind": '"server"', "span_name": '"POST /payments/charge"', "status_code": "500"},
                ]
            if sql == SQL_LOGS:
                return [
                    {"timestamp": "2026-10-07 21:49:30.988000000", "trace_id": TRACE_1, "severity": "error", "log_body": ""},
                    {"timestamp": "2026-10-07 21:49:30.989000000", "trace_id": TRACE_1, "severity": "error", "log_body": "not json"},
                    {"timestamp": "2026-10-07 21:49:30.990000000", "trace_id": TRACE_1, "severity": "error", "log_body": '"charge failed"'},
                ]
            return warehouse(raw_fixture())(sql, params)

        loaded = Repository(FakeClient(handler)).load_raw(INCIDENT_ID)
        self.assertEqual([json.loads(s["attributes"]) for s in loaded.spans],
                         [{}, {}, {"span.kind": "server", "span.name": "POST /payments/charge", "http.response.status_code": 500}])
        self.assertEqual([json.loads(l["attributes"]) for l in loaded.logs], [{}, {}, {"log.body": "charge failed"}])

    def test_at_most_three_cited_trace_ids_are_followed_in_evidence_order(self):
        raw = raw_fixture()
        for n in range(3):
            extra = copy.deepcopy(raw.evidence[1])
            extra.update(evidence_id=f"00000000-0000-4000-8000-00000000010{n}", source_ref=f"{n + 1:032x}",
                         timestamp=f"2026-10-07 21:50:0{n}.000000000")
            raw.evidence.append(extra)
        loaded, client = self.load(raw)
        spans_call = next(call for call in client.queries() if call[1] == SQL_SPANS)
        self.assertEqual(spans_call[2], {"trace_ids": [TRACE_1, TRACE_2, TRACE_3]})
        text = json.dumps(client.calls)
        for n in range(3):
            self.assertNotIn(f"{n + 1:032x}", text, "an uncited-by-limit trace must never reach a query")
        self.assertEqual(len(loaded.evidence), 7)

    def test_a_trace_cited_twice_is_followed_once(self):
        raw = raw_fixture()
        duplicate = copy.deepcopy(raw.evidence[1])
        duplicate.update(evidence_id="00000000-0000-4000-8000-000000000199", timestamp="2026-10-07 21:50:00.000000000")
        raw.evidence.append(duplicate)
        _loaded, client = self.load(raw)
        spans_call = next(call for call in client.queries() if call[1] == SQL_SPANS)
        self.assertEqual(spans_call[2]["trace_ids"], [TRACE_1, TRACE_2, TRACE_3])

    def test_no_cited_traces_means_no_telemetry_queries(self):
        raw = raw_fixture()
        raw.evidence = [row for row in raw.evidence if row["source_type"] != "trace"]
        loaded, client = self.load(raw)
        self.assertEqual([call[1] for call in client.queries()], [SQL_INCIDENT, SQL_EVIDENCE, SQL_DEPLOYMENT])
        self.assertEqual((loaded.spans, loaded.logs), ([], []))

    def test_a_missing_deployment_is_none(self):
        loaded, _ = self.load(raw_fixture("deployment_missing"))
        self.assertIsNone(loaded.deployment)

    def test_an_incident_with_no_deployment_id_sends_no_deployment_query(self):
        raw = raw_fixture()
        raw.incident["deployment_id"] = ""
        loaded, client = self.load(raw)
        self.assertNotIn(SQL_DEPLOYMENT, [call[1] for call in client.queries()])
        self.assertIsNone(loaded.deployment)

    def test_an_unknown_incident_is_rejected_after_one_query_without_echo(self):
        client = FakeClient(warehouse(raw_fixture()))
        with self.assertRaises(ValueError) as ctx:
            Repository(client).load_raw(OTHER_ID)
        self.assertEqual([call[1] for call in client.calls], [SQL_INCIDENT])
        self.assertNotIn(OTHER_ID, str(ctx.exception))

    def test_a_malformed_incident_id_is_rejected_before_any_query(self):
        for bad in ("not-a-uuid", INCIDENT_ID.upper(), "", None, 5, f" {INCIDENT_ID}"):
            with self.subTest(bad=bad):
                client = FakeClient()
                with self.assertRaises(ValueError):
                    Repository(client).load_raw(bad)  # type: ignore[arg-type]
                self.assertEqual(client.calls, [])

    def test_hostile_telemetry_values_travel_only_as_parameters_never_in_sql(self):
        hostile = "x'); DROP TABLE diagnoses; --\\"
        raw = raw_fixture()
        evidence = copy.deepcopy(raw.evidence[1])
        evidence.update(source_ref=hostile)
        raw.evidence[1] = evidence
        _loaded, client = self.load(raw)
        for call in client.queries():
            self.assertIn(call[1], ALL_SQL.values())
            self.assertNotIn("DROP", call[1])
        spans_call = next(call for call in client.queries() if call[1] == SQL_SPANS)
        self.assertIn(hostile, spans_call[2]["trace_ids"])

    def test_the_read_never_exceeds_one_incident_one_deployment_eight_evidence_and_thirty_telemetry_rows(self):
        for sql, bound in ((SQL_INCIDENT, 1), (SQL_DEPLOYMENT, 1), (SQL_EVIDENCE, 8), (SQL_SPANS, 30), (SQL_LOGS, 30)):
            self.assertRegex(normalize(sql), rf"LIMIT {bound}$")

    def test_a_client_error_midway_propagates_and_stops_further_queries(self):
        def handler(sql, params):
            if sql == SQL_EVIDENCE:
                return ClickHouseTransient("down")
            return warehouse(raw_fixture())(sql, params)

        client = FakeClient(handler)
        with self.assertRaises(ClickHouseTransient):
            Repository(client).load_raw(INCIDENT_ID)
        self.assertEqual([call[1] for call in client.calls], [SQL_INCIDENT, SQL_EVIDENCE])


class DiagnosisExistsTest(unittest.TestCase):
    def test_it_uses_the_exact_key_and_returns_false_for_zero(self):
        client = FakeClient(lambda sql, params: [{"n": "0"}])
        self.assertIs(Repository(client).diagnosis_exists(INCIDENT_ID, 3), False)
        self.assertEqual(client.calls, [("query", SQL_EXISTS, {"incident_id": INCIDENT_ID, "diagnosis_version": 3})])

    def test_any_positive_count_is_true_in_either_representation(self):
        for n in (1, "1", 2, "2"):
            with self.subTest(n=n):
                self.assertIs(Repository(FakeClient(lambda sql, params, n=n: [{"n": n}])).diagnosis_exists(INCIDENT_ID, 1), True)

    def test_an_unexpected_response_is_never_read_as_not_existing(self):
        for result in ([], [{}], [{"n": "x"}], [{"n": None}], [{"n": -1}], [{"n": True}], [{"n": "1"}, {"n": "0"}]):
            with self.subTest(result=result):
                with self.assertRaises(ClickHouseTransient):
                    Repository(FakeClient(lambda sql, params, r=result: r)).diagnosis_exists(INCIDENT_ID, 1)

    def test_bad_arguments_are_rejected_before_any_query(self):
        for incident, version in (("nope", 1), (INCIDENT_ID, 0), (INCIDENT_ID, -1), (INCIDENT_ID, True), (INCIDENT_ID, "1"), (INCIDENT_ID.upper(), 1)):
            with self.subTest(incident=incident, version=version):
                client = FakeClient()
                with self.assertRaises(ValueError):
                    Repository(client).diagnosis_exists(incident, version)  # type: ignore[arg-type]
                self.assertEqual(client.calls, [])


def row(**overrides):
    base = dict(
        diagnosis_id="c03997a4-e1ef-5a94-8a2e-62d9694d7642",
        incident_id=INCIDENT_ID,
        diagnosis_version=1,
        status="completed",
        confidence="high",
        failure_code="",
        provider="deterministic",
        model_version="deterministic-rules-1",
        prompt_version="none",
        analyzer_id="deterministic|deterministic-rules-1|none",
        input_digest="sha256:" + "0" * 64,
        document='{"schema_version":"1.1"}',
        created_at="2026-10-07T21:49:41.208Z",
    )
    base.update(overrides)
    return DiagnosisRow(**base)


class WriteTest(unittest.TestCase):
    def test_the_row_has_exactly_the_columns_of_the_table_in_order_and_is_frozen(self):
        self.assertEqual(
            [field.name for field in dataclasses.fields(DiagnosisRow)],
            ["diagnosis_id", "incident_id", "diagnosis_version", "status", "confidence", "failure_code", "provider",
             "model_version", "prompt_version", "analyzer_id", "input_digest", "document", "created_at"],
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            row().status = "failed"  # type: ignore[misc]

    def test_it_always_checks_the_exact_key_first_and_inserts_exactly_one_row_when_absent(self):
        client = FakeClient(lambda sql, params: [{"n": "0"}])
        self.assertIsNone(Repository(client).write(row()))
        self.assertEqual([call[0] for call in client.calls], ["query", "insert"])
        self.assertEqual(client.calls[0], ("query", SQL_EXISTS, {"incident_id": INCIDENT_ID, "diagnosis_version": 1}))
        kind, table, rows = client.calls[1]
        self.assertEqual((kind, table, len(rows)), ("insert", "diagnoses", 1))

    def test_the_inserted_row_has_the_table_columns_and_a_clickhouse_timestamp(self):
        client = FakeClient(lambda sql, params: [{"n": "0"}])
        Repository(client).write(row())
        inserted = client.inserts()[0][2][0]
        self.assertEqual(
            list(inserted),
            ["diagnosis_id", "incident_id", "diagnosis_version", "status", "confidence", "failure_code", "provider",
             "model_version", "prompt_version", "analyzer_id", "input_digest", "document", "created_at"],
        )
        self.assertEqual(inserted["created_at"], "2026-10-07 21:49:41.208")
        self.assertEqual(inserted["diagnosis_version"], 1)
        self.assertEqual(inserted["document"], '{"schema_version":"1.1"}')

    def test_an_existing_key_means_no_insert_at_all(self):
        for n in (1, "1", 3):
            with self.subTest(n=n):
                client = FakeClient(lambda sql, params, n=n: [{"n": n}])
                Repository(client).write(row())
                self.assertEqual(client.inserts(), [])
                self.assertEqual(len(client.calls), 1)

    def test_a_second_write_of_the_same_key_never_inserts_even_with_a_different_document(self):
        stored = set()

        def handler(sql, params):
            return [{"n": "1" if (params["incident_id"], params["diagnosis_version"]) in stored else "0"}]

        class RememberingClient(FakeClient):
            def insert(self, table, rows):
                super().insert(table, rows)
                stored.add((rows[0]["incident_id"], rows[0]["diagnosis_version"]))

        client = RememberingClient(handler)
        repo = Repository(client)
        repo.write(row())
        repo.write(row())
        repo.write(row(document='{"different":true}', created_at="2026-10-08T00:00:00.000Z"))
        self.assertEqual(len(client.inserts()), 1)
        self.assertEqual(client.inserts()[0][2][0]["document"], '{"schema_version":"1.1"}')

    def test_a_different_version_of_the_same_incident_is_a_different_key(self):
        stored = {(INCIDENT_ID, 1)}
        client = FakeClient(lambda sql, params: [{"n": "1" if (params["incident_id"], params["diagnosis_version"]) in stored else "0"}])
        Repository(client).write(row(diagnosis_version=2, diagnosis_id="11111111-2222-4333-8444-555555555555"))
        self.assertEqual(len(client.inserts()), 1)
        self.assertEqual(client.calls[0][2], {"incident_id": INCIDENT_ID, "diagnosis_version": 2})

    def test_failed_and_abstained_rows_are_accepted_in_their_own_shapes(self):
        failed = row(status="failed", confidence="", failure_code="validation_rejected", document="")
        abstained = row(status="abstained", confidence="low")
        for item in (failed, abstained):
            client = FakeClient(lambda sql, params: [{"n": "0"}])
            Repository(client).write(item)
            self.assertEqual(len(client.inserts()), 1)

    def test_invalid_rows_are_rejected_before_any_query_or_insert(self):
        bad = {
            "uppercase incident": row(incident_id=INCIDENT_ID.upper()),
            "bad diagnosis id": row(diagnosis_id="nope"),
            "version zero": row(diagnosis_version=0),
            "version bool": row(diagnosis_version=True),
            "version text": row(diagnosis_version="1"),
            "unknown status": row(status="resolved"),
            "unknown confidence": row(confidence="certain"),
            "completed with a failure code": row(failure_code="validation_rejected"),
            "completed without a document": row(document=""),
            "completed without confidence": row(confidence=""),
            "failed without a code": row(status="failed", confidence="", failure_code="", document=""),
            "failed with an unknown code": row(status="failed", confidence="", failure_code="mystery", document=""),
            "failed with a document": row(status="failed", confidence="", failure_code="invalid_incident", document="{}"),
            "failed with confidence": row(status="failed", confidence="low", failure_code="invalid_incident", document=""),
            "empty analyzer id": row(analyzer_id=""),
            "naive timestamp": row(created_at="2026-10-07 21:49:41.208"),
            "wrong precision": row(created_at="2026-10-07T21:49:41.2Z"),
            "impossible date": row(created_at="2026-13-45T21:49:41.208Z"),
            "non-text document": row(document=None),
        }
        for label, item in bad.items():
            with self.subTest(case=label):
                client = FakeClient()
                with self.assertRaises(ValueError) as ctx:
                    Repository(client).write(item)
                self.assertEqual(client.calls, [])
                self.assertNotIn("SECRET", str(ctx.exception))

    def test_errors_never_echo_the_document_or_identifiers(self):
        client = FakeClient()
        with self.assertRaises(ValueError) as ctx:
            Repository(client).write(row(status="resolved", document="SECRET-DOCUMENT-TEXT"))
        self.assertNotIn("SECRET-DOCUMENT-TEXT", str(ctx.exception))
        self.assertNotIn("resolved", str(ctx.exception))

    def test_a_failed_existence_check_means_no_insert(self):
        client = FakeClient(lambda sql, params: ClickHouseTransient("down"))
        with self.assertRaises(ClickHouseTransient):
            Repository(client).write(row())
        self.assertEqual(client.inserts(), [])

    def test_an_unexpected_existence_response_means_no_insert(self):
        client = FakeClient(lambda sql, params: [])
        with self.assertRaises(ClickHouseTransient):
            Repository(client).write(row())
        self.assertEqual(client.inserts(), [])

    def test_an_insert_failure_propagates_and_nothing_is_retried_here(self):
        class FailingInsert(FakeClient):
            def insert(self, table, rows):
                super().insert(table, rows)
                raise ClickHouseTransient("down")

        client = FailingInsert(lambda sql, params: [{"n": "0"}])
        with self.assertRaises(ClickHouseTransient):
            Repository(client).write(row())
        self.assertEqual(len(client.inserts()), 1)

    def test_the_table_name_is_a_literal_inside_the_repository(self):
        client = FakeClient(lambda sql, params: [{"n": "0"}])
        Repository(client).write(row())
        self.assertEqual(client.inserts()[0][1], "diagnoses")
        self.assertEqual(repository_module.DIAGNOSES_TABLE, "diagnoses")


class PurityTest(unittest.TestCase):
    def test_the_repository_has_no_logging_environment_or_filesystem_access(self):
        import ast
        import inspect

        tree = ast.parse(inspect.getsource(repository_module))
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        imported |= {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
        self.assertFalse(imported & {"os", "sys", "logging", "socket", "subprocess", "pathlib", "urllib", "urllib.request", "random", "time"})
        called = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        self.assertFalse(called & {"open", "print", "eval", "exec"})


if __name__ == "__main__":
    unittest.main()
