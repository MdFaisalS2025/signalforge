"""Live ClickHouse checks for the repository, run as the agent account only.

Skipped unless AGENT_IT_CLICKHOUSE_URL is set. Run it against the Compose stack (migration 2 and the agent_writer account
applied):

    node scripts/py-in-docker.mjs --network signalforge_default --env AGENT_IT_CLICKHOUSE_URL=http://clickhouse:8123 \
        --env AGENT_IT_USER=agent_writer --env AGENT_IT_PASSWORD=changeme-local-only \
        python -m unittest tests.test_repository_integration -v

The account has no delete permission, so the one probe row this module writes is intentionally retained. It belongs to a
reserved incident ID that no real incident can have, so neither the dashboard nor the demo flow can reach it.
"""

import json
import os
import unittest
from datetime import datetime, timezone

from signalforge_agent.analyzer_rules import analyze
from signalforge_agent.bundle import build_bundle
from signalforge_agent.chclient import ClickHouseClient
from signalforge_agent.ids import diagnosis_id
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
from signalforge_agent.validator import validate

URL = os.environ.get("AGENT_IT_CLICKHOUSE_URL")

# Reserved, fixed, and never an incident: the probe row for the idempotency check.
PROBE_INCIDENT_ID = "00000000-0000-4000-8000-0000000d1a60"
PROBE_ANALYZER = "deterministic|integration-probe|none"
PROBE_DOCUMENT = json.dumps(
    {"probe": "repository integration test; reserved incident, not a real incident"}, separators=(",", ":")
)

TRICKY_STRINGS = ["plain", "it's", "back\\slash", "both\\'", "'", "\\", "a,b", "[x]", "tab\there", "line\nbreak", "cr\rhere",
                  "'); DROP TABLE x; --", "unicode é中", ""]


def probe_row(**overrides):
    values = dict(
        diagnosis_id=diagnosis_id(PROBE_INCIDENT_ID, 1),
        incident_id=PROBE_INCIDENT_ID,
        diagnosis_version=1,
        status="abstained",
        confidence="low",
        failure_code="",
        provider="deterministic",
        model_version="integration-probe",
        prompt_version="none",
        analyzer_id=PROBE_ANALYZER,
        input_digest="sha256:" + "0" * 64,
        document=PROBE_DOCUMENT,
        created_at="2026-10-07T00:00:00.000Z",
    )
    values.update(overrides)
    return DiagnosisRow(**values)


@unittest.skipUnless(URL, "AGENT_IT_CLICKHOUSE_URL is not set; live ClickHouse repository checks skipped")
class RepositoryIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.user = os.environ.get("AGENT_IT_USER", "")
        cls.client = ClickHouseClient(
            URL, os.environ.get("AGENT_IT_DATABASE", "signalforge"), cls.user, os.environ.get("AGENT_IT_PASSWORD", ""), 20
        )
        cls.repo = Repository(cls.client)

    def stored(self, incident_id, version):
        """The row count (without FINAL, so a duplicate would show) and the stored document for one exact key."""
        params = {"incident_id": incident_id, "diagnosis_version": version}
        count = self.client.query(
            "SELECT count() AS n FROM diagnoses WHERE incident_id = {incident_id:UUID} AND diagnosis_version = {diagnosis_version:UInt32}",
            params,
        )
        rows = self.client.query(
            "SELECT document, toString(created_at) AS created_at FROM diagnoses "
            "WHERE incident_id = {incident_id:UUID} AND diagnosis_version = {diagnosis_version:UInt32}",
            params,
        )
        return int(count[0]["n"]), rows

    def test_the_agent_account_is_the_one_in_use(self):
        rows = self.client.query("SELECT currentUser() AS u")
        self.assertEqual(rows, [{"u": "agent_writer"}])
        self.assertEqual(self.user, "agent_writer")

    def test_the_table_is_ready_and_both_discovery_policies_parse(self):
        self.assertIs(self.repo.table_ready(), True)
        for policy in ("first-only", "on-analyzer-change"):
            found = self.repo.discover(5, policy, "deterministic|deterministic-rules-1|none")
            self.assertIsInstance(found, list)
            self.assertTrue(all(isinstance(candidate, Candidate) and candidate.next_version >= 1 for candidate in found))

    def test_every_repository_read_query_executes_and_parses(self):
        statements = [
            (SQL_TABLE_READY, {}),
            (SQL_DISCOVER_NEW, {"batch": 5}),
            (SQL_DISCOVER_REVISE, {"analyzer_id": "other|x|y", "batch": 5}),
            (SQL_INCIDENT, {"incident_id": PROBE_INCIDENT_ID}),
            (SQL_EVIDENCE, {"incident_id": PROBE_INCIDENT_ID}),
            (SQL_DEPLOYMENT, {"deployment_id": "no-such-deployment"}),
            (SQL_SPANS, {"trace_ids": []}),
            (SQL_SPANS, {"trace_ids": ["abc", "it's \\ ok"]}),
            (SQL_LOGS, {"trace_ids": []}),
            (SQL_LOGS, {"trace_ids": ["abc", "it's \\ ok"]}),
            (SQL_EXISTS, {"incident_id": PROBE_INCIDENT_ID, "diagnosis_version": 99}),
        ]
        for sql, params in statements:
            with self.subTest(sql=" ".join(sql.split())[:60], params=sorted(params)):
                self.assertIsInstance(self.client.query(sql, params), list)

    def test_the_reserved_probe_incident_is_not_a_real_incident(self):
        self.assertEqual(self.client.query(SQL_INCIDENT, {"incident_id": PROBE_INCIDENT_ID}), [])
        self.assertEqual(self.client.query(SQL_EVIDENCE, {"incident_id": PROBE_INCIDENT_ID}), [])

    def test_special_characters_round_trip_through_the_real_server(self):
        for text in TRICKY_STRINGS:
            with self.subTest(text=text):
                self.assertEqual(self.client.query("SELECT {s:String} AS s", {"s": text}), [{"s": text}])
        self.assertEqual(self.client.query("SELECT {a:Array(String)} AS a", {"a": TRICKY_STRINGS}), [{"a": TRICKY_STRINGS}])
        self.assertEqual(self.client.query("SELECT {a:Array(String)} AS a", {"a": []}), [{"a": []}])
        self.assertEqual(self.client.query("SELECT {n:UInt32} AS n", {"n": 20}), [{"n": 20}])

    def test_a_hostile_string_in_a_parameter_cannot_change_the_statement(self):
        hostile = "x') OR 1=1 --"
        rows = self.client.query(SQL_EVIDENCE, {"incident_id": PROBE_INCIDENT_ID})
        self.assertEqual(rows, [])
        rows = self.client.query(SQL_DEPLOYMENT, {"deployment_id": hostile})
        self.assertEqual(rows, [])
        rows = self.client.query(SQL_SPANS, {"trace_ids": [hostile]})
        self.assertEqual(rows, [])

    def test_a_real_published_incident_loads_builds_a_bundle_and_passes_the_whole_pipeline(self):
        rows = self.client.query(
            "SELECT incident_id FROM incidents FINAL WHERE publication_state = 'published' ORDER BY detected_at DESC LIMIT 1"
        )
        if not rows:
            self.skipTest("no published incident exists in this database yet")
        incident_id = rows[0]["incident_id"]
        raw = self.repo.load_raw(incident_id)
        bundle = build_bundle(raw)
        self.assertEqual(bundle.incident.incident_id, incident_id)
        self.assertEqual(len(bundle.evidence), 4, "a published incident has exactly four evidence rows")
        self.assertEqual(sum(1 for row in bundle.evidence if row.source_type == "trace"), 3)
        text = json.dumps({"spans": raw.spans, "logs": raw.logs})
        for needle in ("order_id", "http.request", "Bearer"):
            self.assertNotIn(needle, text)
        for span in raw.spans:
            self.assertLessEqual(set(json.loads(span["attributes"])), {"span.kind", "span.name", "http.response.status_code"})
        now = datetime(2026, 10, 7, 21, 49, 41, 208000, tzinfo=timezone.utc)
        document = analyze(bundle, version=1, now=now)
        self.assertIsNone(validate(document, bundle))

    def test_the_probe_row_is_written_once_and_never_changed(self):
        self.repo.write(probe_row())
        count, rows = self.stored(PROBE_INCIDENT_ID, 1)
        self.assertEqual(count, 1)
        self.assertEqual(len(rows), 1)
        first_document, first_created = rows[0]["document"], rows[0]["created_at"]
        self.assertEqual(first_document, PROBE_DOCUMENT)

        # The very same row again, then a different row for the same key: neither may insert or change anything.
        self.repo.write(probe_row())
        self.repo.write(probe_row(document=json.dumps({"probe": "different"}), created_at="2026-10-08T00:00:00.000Z"))

        count, rows = self.stored(PROBE_INCIDENT_ID, 1)
        self.assertEqual(count, 1, "count() without FINAL must still be exactly 1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["document"].encode("utf-8"), first_document.encode("utf-8"), "the stored document is byte-identical")
        self.assertEqual(rows[0]["created_at"], first_created)

    def test_the_existence_check_sees_exactly_the_written_key(self):
        self.repo.write(probe_row())
        self.assertIs(self.repo.diagnosis_exists(PROBE_INCIDENT_ID, 1), True)
        self.assertIs(self.repo.diagnosis_exists(PROBE_INCIDENT_ID, 2), False)
        self.assertIs(self.repo.diagnosis_exists("00000000-0000-4000-8000-0000000d1a61", 1), False)

    def test_the_revision_query_compares_the_analyzer_only_on_each_incidents_latest_row(self):
        self.repo.write(probe_row())
        # The probe's latest row has this analyzer, so it must not be selected for revision under the same analyzer.
        same = self.client.query(SQL_DISCOVER_REVISE, {"analyzer_id": PROBE_ANALYZER, "batch": 20})
        self.assertNotIn(PROBE_INCIDENT_ID, [row["incident_id"] for row in same])
        # Under a different analyzer it is selected, unless other diagnoses fill the 20-row page first.
        other = self.client.query(SQL_DISCOVER_REVISE, {"analyzer_id": "other|analyzer|v2", "batch": 20})
        ids = [row["incident_id"] for row in other]
        self.assertTrue(PROBE_INCIDENT_ID in ids or len(ids) == 20, "the probe incident is selected for a different analyzer")
        if PROBE_INCIDENT_ID in ids:
            self.assertEqual(int(next(r for r in other if r["incident_id"] == PROBE_INCIDENT_ID)["latest_version"]), 1)

    def test_a_row_already_diagnosed_is_not_rediscovered_as_new(self):
        self.repo.write(probe_row())
        new_ids = [row["incident_id"] for row in self.client.query(SQL_DISCOVER_NEW, {"batch": 20})]
        self.assertNotIn(PROBE_INCIDENT_ID, new_ids)


if __name__ == "__main__":
    unittest.main()
