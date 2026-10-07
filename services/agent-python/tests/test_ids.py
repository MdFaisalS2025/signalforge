import hashlib
import json
import random
import re
import unittest
import uuid
from pathlib import Path

from signalforge_agent.bundle import RawIncidentData, build_bundle
from signalforge_agent.ids import NAMESPACE, analyzer_id, diagnosis_id, input_digest

FIXTURES = Path(__file__).resolve().parent / "fixtures"

INCIDENT_ID = "5893b198-6ad5-5708-bb7e-a0d2ca4ca323"
DOCUMENTED_V1_ID = "c03997a4-e1ef-5a94-8a2e-62d9694d7642"


def load_raw(name="faulty_deploy_full"):
    data = json.loads((FIXTURES / f"raw_{name}.json").read_text(encoding="utf-8"))
    return RawIncidentData(
        incident=data["incident"],
        evidence=data["evidence"],
        deployment=data["deployment"],
        spans=data["spans"],
        logs=data["logs"],
    )


def shuffled(raw, seed):
    rng = random.Random(seed)
    evidence, spans, logs = list(raw.evidence), list(raw.spans), list(raw.logs)
    for rows in (evidence, spans, logs):
        rng.shuffle(rows)
    return RawIncidentData(incident=raw.incident, evidence=evidence, deployment=raw.deployment, spans=spans, logs=logs)


class DiagnosisIdTest(unittest.TestCase):
    def test_the_namespace_is_the_shared_deterministic_identity_namespace(self):
        self.assertEqual(NAMESPACE, uuid.UUID("8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d"))

    def test_the_documented_diagnosis_id_for_version_1(self):
        self.assertEqual(diagnosis_id(INCIDENT_ID, 1), DOCUMENTED_V1_ID)

    def test_the_id_follows_the_documented_formula(self):
        expected = str(uuid.uuid5(NAMESPACE, f"diagnosis|{INCIDENT_ID}|2"))
        self.assertEqual(diagnosis_id(INCIDENT_ID, 2), expected)

    def test_versions_one_and_two_differ(self):
        self.assertNotEqual(diagnosis_id(INCIDENT_ID, 1), diagnosis_id(INCIDENT_ID, 2))

    def test_the_id_is_stable_across_calls_and_differs_between_incidents(self):
        self.assertEqual(diagnosis_id(INCIDENT_ID, 1), diagnosis_id(INCIDENT_ID, 1))
        other = "a1b2c3d4-e5f6-4789-90ab-cdef01234567"
        self.assertNotEqual(diagnosis_id(INCIDENT_ID, 1), diagnosis_id(other, 1))

    def test_the_id_is_a_lowercase_uuid_string(self):
        self.assertRegex(diagnosis_id(INCIDENT_ID, 1), r"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_a_non_canonical_incident_id_is_rejected_rather_than_silently_changing_the_id(self):
        for bad in (INCIDENT_ID.upper(), INCIDENT_ID.replace("-", ""), "not-a-uuid", "", f" {INCIDENT_ID}"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    diagnosis_id(bad, 1)

    def test_the_version_must_be_a_positive_integer(self):
        for bad in (0, -1, True, 1.0, "1", None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    diagnosis_id(INCIDENT_ID, bad)  # type: ignore[arg-type]


class AnalyzerIdTest(unittest.TestCase):
    def test_the_deterministic_analyzer_id(self):
        self.assertEqual(
            analyzer_id("deterministic", "deterministic-rules-1", "none"),
            "deterministic|deterministic-rules-1|none",
        )

    def test_the_provider_analyzer_id(self):
        self.assertEqual(
            analyzer_id("openai-compatible", "some-model", "diagnose-v1"),
            "openai-compatible|some-model|diagnose-v1",
        )

    def test_empty_parts_and_parts_containing_the_separator_are_rejected(self):
        for args in (("", "m", "v"), ("p", "", "v"), ("p", "m", ""), ("p|q", "m", "v"), ("p", "m|n", "v"), ("p", "m", "v|w")):
            with self.subTest(args=args):
                with self.assertRaises(ValueError):
                    analyzer_id(*args)


class InputDigestTest(unittest.TestCase):
    def test_the_digest_has_the_contract_format(self):
        digest = input_digest(build_bundle(load_raw()))
        self.assertRegex(digest, r"^sha256:[0-9a-f]{64}$")

    def test_the_digest_is_the_sha256_of_the_canonical_json_bytes(self):
        bundle = build_bundle(load_raw())
        expected = "sha256:" + hashlib.sha256(bundle.canonical_json().encode("utf-8")).hexdigest()
        self.assertEqual(input_digest(bundle), expected)

    def test_rebuilding_from_the_same_raw_data_gives_the_same_digest(self):
        self.assertEqual(input_digest(build_bundle(load_raw())), input_digest(build_bundle(load_raw())))

    def test_shuffled_raw_rows_give_the_same_canonical_bundle_and_digest(self):
        raw = load_raw()
        reference = build_bundle(raw)
        for seed in range(25):
            with self.subTest(seed=seed):
                rebuilt = build_bundle(shuffled(raw, seed))
                self.assertEqual(rebuilt.canonical_json(), reference.canonical_json())
                self.assertEqual(input_digest(rebuilt), input_digest(reference))

    def test_changing_one_evidence_summary_changes_the_digest(self):
        raw = load_raw()
        before = input_digest(build_bundle(raw))
        changed = load_raw()
        changed.evidence[1]["summary"] = changed.evidence[1]["summary"] + " (edited)"
        self.assertNotEqual(input_digest(build_bundle(changed)), before)

    def test_changing_other_retained_content_changes_the_digest(self):
        before = input_digest(build_bundle(load_raw()))
        for label, mutate in (
            ("deployment version", lambda r: r.deployment.update(new_version="0.3.0")),
            ("incident title", lambda r: r.incident.update(title="Payments 5xx burst, edited")),
            ("trigger rule", lambda r: r.incident.update(trigger_rule="something-else")),
            ("span status code", lambda r: r.spans[0].update(attributes=json.dumps({"span.kind": "server", "span.name": "POST /payments/charge", "http.response.status_code": 200}))),
        ):
            with self.subTest(change=label):
                raw = load_raw()
                mutate(raw)
                self.assertNotEqual(input_digest(build_bundle(raw)), before)

    def test_content_the_bundle_drops_does_not_change_the_digest(self):
        before = input_digest(build_bundle(load_raw()))
        raw = load_raw()
        raw.deployment["initiated_by"] = "someone-else"
        raw.deployment["previous_version"] = "9.9.9"
        raw.incident["dedup_key"] = "changed"
        for row in raw.evidence:
            row["ingested_at"] = "2030-01-01 00:00:00.000"
        self.assertEqual(input_digest(build_bundle(raw)), before)

    def test_different_fixtures_have_different_digests(self):
        digests = {name: input_digest(build_bundle(load_raw(name))) for name in (
            "faulty_deploy_full", "faulty_deploy_no_telemetry", "two_traces_only", "deployment_missing",
            "unknown_rule", "late_failure", "prompt_injection_log",
        )}
        self.assertEqual(len(set(digests.values())), len(digests))
        for digest in digests.values():
            self.assertTrue(re.fullmatch(r"sha256:[0-9a-f]{64}", digest))


class FixtureDigestPinTest(unittest.TestCase):
    """What reaches an analyzer or provider must not change by accident.

    These values were computed from the bundle as first committed (f1e5afa). A later change to the canonical bundle
    shape or contents changes them on purpose, and then this table is updated in the same commit that says why.
    """

    PINNED = {
        "faulty_deploy_full": ("sha256:09423073efb7cfb0448805bb01d67d2d4f30bd045916d818244e090ae5e94744", 3365),
        "faulty_deploy_no_telemetry": ("sha256:8a82eeadf7692e74fa344e30cafceec5fb9a291ab22fdbe359517bd02ff9cfa2", 2243),
        "two_traces_only": ("sha256:0982a6a74d713026231a46b4676157070d42e1865c03e529c50dd3e93c02b418", 2565),
        "deployment_missing": ("sha256:0a606c0e559e0015bff97eb3db4a7de32c527edc4a3ad7893b63ec420e74076f", 3170),
        "unknown_rule": ("sha256:6ffc93f45cac576cf966d2d2fa81eeb5bbdd6bde689c1b14b4893f1f7b20e09f", 3344),
        "late_failure": ("sha256:227cd9790c745fccc390dd849550d392b7678b4c56e75d144cf6c9e838053271", 3365),
        "prompt_injection_log": ("sha256:2ed75bb6b671bc24ebb9f19dfd4628314e4628f6844ebc67b95f6653ed1bd1e9", 3475),
    }

    def test_each_fixtures_digest_and_canonical_size_are_pinned(self):
        for name, (digest, size) in self.PINNED.items():
            with self.subTest(fixture=name):
                bundle = build_bundle(load_raw(name))
                self.assertEqual(input_digest(bundle), digest)
                self.assertEqual(len(bundle.canonical_json().encode("utf-8")), size)

    def test_computing_the_allowed_tokens_does_not_change_the_digest(self):
        bundle = build_bundle(load_raw())
        before = input_digest(bundle)
        bundle.allowed_tokens()
        self.assertEqual(input_digest(bundle), before)


if __name__ == "__main__":
    unittest.main()
