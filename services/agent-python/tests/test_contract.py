import copy
import dataclasses
import json
import os
import tempfile
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

from signalforge_agent.contract import ContractError, find_schema, json_pointer, schema_path, validate_document

REPO = Path(__file__).resolve().parents[3]
EVENTS = REPO / "contracts" / "events"
SAMPLE = EVENTS / "samples" / "diagnosis.sample.json"
INVALID = EVENTS / "samples" / "invalid"

VALID = json.loads(SAMPLE.read_text(encoding="utf-8"))

# The diagnosis placeholder shape that schema version 1.0 accepted. It has no producer, and 1.1 must not accept it.
LEGACY_V1_0 = {
    "schema_version": "1.0",
    "diagnosis_id": "7b1e9f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b",
    "incident_id": "a1b2c3d4-e5f6-4789-90ab-cdef01234567",
    "model_version": "placeholder-0",
    "prompt_version": "v1",
    "abstain": False,
    "primary_hypothesis": "The demo-payments 0.3.0 release introduced the 5xx regression.",
    "supporting_claims": [
        {
            "claim": "First failing span occurs five seconds after the demo-payments deployment event.",
            "evidence_ids": ["9c858901-8a57-4791-81fe-4c455b099bc9"],
        }
    ],
    "alternative_hypotheses": [],
    "confidence": {"value": "high", "explanation": "Deployment timestamp and first failure are tightly correlated."},
    "missing_evidence": [],
    "created_at": "2026-10-01T12:00:20Z",
}

# Each invalid fixture has exactly one defect, so exactly one error is expected, at this pointer, for this keyword.
EXPECTED_INVALID = {
    "diagnosis.executable-true.json": [("/remediation_recommendation/executable", "const")],
    "diagnosis.claim-without-evidence.json": [("/supporting_claims/0/evidence_ids", "minItems")],
    "diagnosis.unknown-claim-kind.json": [("/supporting_claims/0/kind", "enum")],
    "diagnosis.abstain-with-hypothesis.json": [("/primary_hypothesis", "not")],
    "diagnosis.completed-without-hypothesis.json": [("", "required")],
    "diagnosis.overlong-reasoning.json": [("/reasoning_summary", "maxLength")],
    "diagnosis.confidence-not-enum.json": [("/confidence/value", "enum")],
    "diagnosis.bad-digest.json": [("/input_digest", "pattern")],
    "diagnosis.extra-field.json": [("", "additionalProperties")],
}

EVIDENCE_A = "2b36dac1-5929-5a4f-9c94-5e46d810d714"
EVIDENCE_B = "7aa3c142-a1f0-5582-a339-6021113cae07"


def pairs(document):
    return [(error.path, error.keyword) for error in validate_document(document)]


def mutated(mutate, base=None):
    document = copy.deepcopy(VALID if base is None else base)
    mutate(document)
    return document


def abstained():
    """A consistent abstention: the abstain-with-hypothesis fixture with its one defect removed."""
    document = json.loads((INVALID / "diagnosis.abstain-with-hypothesis.json").read_text(encoding="utf-8"))
    del document["primary_hypothesis"]
    return document


class ValidFixtureTest(unittest.TestCase):
    def test_the_v1_1_sample_is_accepted(self):
        self.assertEqual(validate_document(VALID), [])

    def test_the_sample_is_a_completed_grounded_diagnosis_with_a_non_executable_recommendation(self):
        self.assertEqual(VALID["schema_version"], "1.1")
        self.assertEqual((VALID["status"], VALID["abstain"]), ("completed", False))
        self.assertIs(VALID["remediation_recommendation"]["executable"], False)
        self.assertIs(VALID["remediation_recommendation"]["requires_approval"], True)
        self.assertTrue(all(claim["evidence_ids"] for claim in VALID["supporting_claims"]))

    def test_the_documented_diagnosis_id_formula_matches_the_sample(self):
        import uuid

        namespace = uuid.UUID("8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d")
        expected = uuid.uuid5(namespace, f"diagnosis|{VALID['incident_id']}|{VALID['diagnosis_version']}")
        self.assertEqual(VALID["diagnosis_id"], str(expected))

    def test_a_consistent_abstention_is_accepted(self):
        self.assertEqual(validate_document(abstained()), [])

    def test_the_schema_itself_is_a_valid_2020_12_schema(self):
        schema = json.loads(schema_path().read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        self.assertEqual(schema["properties"]["schema_version"]["const"], "1.1")
        self.assertIs(schema["additionalProperties"], False)


class LegacyShapeTest(unittest.TestCase):
    def test_the_legacy_v1_0_shape_is_rejected_on_schema_version(self):
        self.assertIn(("/schema_version", "const"), pairs(LEGACY_V1_0))

    def test_the_legacy_shape_is_rejected_for_missing_v1_1_fields_and_claim_kind(self):
        found = pairs(LEGACY_V1_0)
        self.assertIn(("", "required"), found)
        self.assertIn(("/supporting_claims/0", "required"), found)

    def test_a_v1_1_document_that_only_claims_the_old_version_is_rejected(self):
        self.assertEqual(pairs(mutated(lambda d: d.update(schema_version="1.0"))), [("/schema_version", "const")])


class InvalidFixtureTest(unittest.TestCase):
    def test_every_diagnosis_invalid_fixture_is_covered_and_none_is_missing(self):
        on_disk = sorted(path.name for path in INVALID.glob("diagnosis.*.json"))
        self.assertEqual(on_disk, sorted(EXPECTED_INVALID))
        self.assertEqual(len(on_disk), 9)

    def test_each_invalid_fixture_fails_at_its_pointer_and_keyword_and_nowhere_else(self):
        for name, expected in EXPECTED_INVALID.items():
            with self.subTest(fixture=name):
                document = json.loads((INVALID / name).read_text(encoding="utf-8"))
                self.assertEqual(pairs(document), expected)

    def test_every_invalid_fixture_differs_from_the_valid_sample_but_stays_v1_1(self):
        for name in EXPECTED_INVALID:
            with self.subTest(fixture=name):
                document = json.loads((INVALID / name).read_text(encoding="utf-8"))
                self.assertEqual(document["schema_version"], "1.1")
                self.assertNotEqual(document, VALID)

    def test_the_overlong_fixture_is_exactly_one_character_over_the_limit(self):
        document = json.loads((INVALID / "diagnosis.overlong-reasoning.json").read_text(encoding="utf-8"))
        self.assertEqual(len(document["reasoning_summary"]), 1201)


class ContractErrorTest(unittest.TestCase):
    def test_contract_error_is_a_frozen_value_with_a_path_and_a_keyword(self):
        error = ContractError(path="/a", keyword="const")
        self.assertEqual([f.name for f in dataclasses.fields(ContractError)], ["path", "keyword"])
        with self.assertRaises(dataclasses.FrozenInstanceError):
            error.path = "/b"  # type: ignore[misc]
        self.assertEqual(error, ContractError("/a", "const"))
        self.assertEqual(len({error, ContractError("/a", "const")}), 1)

    def test_errors_are_returned_in_a_deterministic_sorted_order(self):
        def break_many(document):
            document["confidence"]["value"] = "certain"
            document["input_digest"] = "nope"
            document["reasoning_summary"] = "x" * 1300
            document["supporting_claims"][0]["kind"] = "made_up"
            document["created_at"] = "yesterday"

        first = validate_document(mutated(break_many))
        self.assertGreaterEqual(len(first), 5)
        self.assertEqual(first, sorted(first, key=lambda e: (e.path, e.keyword)))
        self.assertEqual(first, validate_document(mutated(break_many)))

    def test_the_result_does_not_depend_on_key_insertion_order(self):
        broken = mutated(lambda d: d.update(input_digest="nope", created_at="yesterday"))
        reordered = dict(reversed(list(broken.items())))
        self.assertEqual(validate_document(broken), validate_document(reordered))

    def test_json_pointer_escapes_per_rfc_6901(self):
        self.assertEqual(json_pointer([]), "")
        self.assertEqual(json_pointer(["a"]), "/a")
        self.assertEqual(json_pointer(["supporting_claims", 0, "kind"]), "/supporting_claims/0/kind")
        self.assertEqual(json_pointer(["a/b", "c~d", 0]), "/a~1b/c~0d/0")
        self.assertEqual(json_pointer(["~1"]), "/~01", "the tilde is escaped first, so ~1 is not read back as a slash")
        self.assertEqual(json_pointer([""]), "/")


class StrictnessTest(unittest.TestCase):
    def test_unexpected_properties_are_rejected_at_every_level(self):
        cases = {
            "": lambda d: d.update(extra=1),
            "/supporting_claims/0": lambda d: d["supporting_claims"][0].update(extra=1),
            "/alternative_hypotheses/0": lambda d: d["alternative_hypotheses"][0].update(extra=1),
            "/confidence": lambda d: d["confidence"].update(extra=1),
            "/remediation_recommendation": lambda d: d["remediation_recommendation"].update(extra=1),
            "/remediation_recommendation/parameters": lambda d: d["remediation_recommendation"]["parameters"].update(command="x"),
            "/provider": lambda d: d["provider"].update(extra=1),
        }
        for path, mutate in cases.items():
            with self.subTest(path=path):
                self.assertEqual(pairs(mutated(mutate)), [(path, "additionalProperties")])

    def test_required_top_level_fields(self):
        required = [
            "schema_version", "diagnosis_id", "incident_id", "diagnosis_version", "status", "abstain",
            "supporting_claims", "alternative_hypotheses", "confidence", "missing_evidence", "reasoning_summary",
            "remediation_recommendation", "provider", "model_version", "prompt_version", "input_digest", "created_at",
        ]
        for name in required:
            with self.subTest(name=name):
                self.assertEqual(pairs(mutated(lambda d, n=name: d.pop(n))), [("", "required")])

    def test_identifiers_must_be_lowercase_uuids(self):
        for field in ("diagnosis_id", "incident_id"):
            for bad in ("not-a-uuid", VALID[field].upper(), VALID[field].replace("-", "")):
                with self.subTest(field=field, bad=bad):
                    self.assertEqual(pairs(mutated(lambda d, f=field, b=bad: d.update({f: b}))), [(f"/{field}", "pattern")])

    def test_cited_ids_must_be_uuids(self):
        self.assertEqual(
            pairs(mutated(lambda d: d["supporting_claims"][0].update(evidence_ids=["trace-1"]))),
            [("/supporting_claims/0/evidence_ids/0", "pattern")],
        )
        self.assertEqual(
            pairs(mutated(lambda d: d["alternative_hypotheses"][0].update(disconfirming_evidence_ids=["x"]))),
            [("/alternative_hypotheses/0/disconfirming_evidence_ids/0", "pattern")],
        )

    def test_diagnosis_version_is_a_positive_integer(self):
        self.assertEqual(pairs(mutated(lambda d: d.update(diagnosis_version=0))), [("/diagnosis_version", "minimum")])
        self.assertEqual(pairs(mutated(lambda d: d.update(diagnosis_version=1.5))), [("/diagnosis_version", "type")])
        self.assertEqual(pairs(mutated(lambda d: d.update(diagnosis_version="1"))), [("/diagnosis_version", "type")])
        self.assertEqual(validate_document(mutated(lambda d: d.update(diagnosis_version=7))), [])

    def test_created_at_has_exactly_three_fractional_digits_and_a_z(self):
        for bad in ("2026-10-07T21:49:41Z", "2026-10-07T21:49:41.2Z", "2026-10-07T21:49:41.208000Z",
                    "2026-10-07T21:49:41.208+00:00", "2026-10-07 21:49:41.208Z", "yesterday"):
            with self.subTest(bad=bad):
                self.assertEqual(pairs(mutated(lambda d, b=bad: d.update(created_at=b))), [("/created_at", "pattern")])

    def test_input_digest_is_sha256_with_64_lowercase_hex_digits(self):
        for bad in ("sha256:" + "A" * 64, "sha256:" + "a" * 63, "sha256:" + "a" * 65, "sha1:" + "a" * 64, "a" * 64):
            with self.subTest(bad=bad):
                self.assertEqual(pairs(mutated(lambda d, b=bad: d.update(input_digest=b))), [("/input_digest", "pattern")])

    def test_confidence_value_is_low_medium_or_high(self):
        for good in ("low", "medium", "high"):
            self.assertEqual(validate_document(mutated(lambda d, g=good: d["confidence"].update(value=g))), [])
        self.assertEqual(pairs(mutated(lambda d: d["confidence"].update(value="HIGH"))), [("/confidence/value", "enum")])

    def test_claim_kinds_are_the_five_approved_values(self):
        for kind in ("deployment_succeeded", "deployment_before_failure", "failure_burst",
                     "http_500_in_payments", "failures_share_deployment"):
            self.assertEqual(validate_document(mutated(lambda d, k=kind: d["supporting_claims"][0].update(kind=k))), [], kind)
        self.assertEqual(
            pairs(mutated(lambda d: d["supporting_claims"][0].pop("kind"))), [("/supporting_claims/0", "required")]
        )

    def test_claim_citations_are_one_to_eight_distinct_ids(self):
        ids = [f"00000000-0000-4000-8000-00000000000{n}" for n in range(1, 10)]
        self.assertEqual(
            pairs(mutated(lambda d: d["supporting_claims"][0].update(evidence_ids=[EVIDENCE_A, EVIDENCE_A]))),
            [("/supporting_claims/0/evidence_ids", "uniqueItems")],
        )
        self.assertEqual(validate_document(mutated(lambda d: d["supporting_claims"][0].update(evidence_ids=ids[:8]))), [])
        self.assertEqual(
            pairs(mutated(lambda d: d["supporting_claims"][0].update(evidence_ids=ids))),
            [("/supporting_claims/0/evidence_ids", "maxItems")],
        )

    def test_text_and_list_bounds(self):
        claim = VALID["supporting_claims"][0]
        extra_claims = lambda n: [copy.deepcopy(claim) for _ in range(n)]
        cases = [
            ("hypothesis 240 ok", lambda d: d.update(primary_hypothesis="h" * 240), []),
            ("hypothesis 241", lambda d: d.update(primary_hypothesis="h" * 241), [("/primary_hypothesis", "maxLength")]),
            ("hypothesis empty", lambda d: d.update(primary_hypothesis=""), [("/primary_hypothesis", "minLength")]),
            ("claim 280 ok", lambda d: d["supporting_claims"][0].update(claim="c" * 280), []),
            ("claim 281", lambda d: d["supporting_claims"][0].update(claim="c" * 281), [("/supporting_claims/0/claim", "maxLength")]),
            ("six claims ok", lambda d: d.update(supporting_claims=extra_claims(6)), []),
            ("seven claims", lambda d: d.update(supporting_claims=extra_claims(7)), [("/supporting_claims", "maxItems")]),
            ("no claims when completed", lambda d: d.update(supporting_claims=[]), [("/supporting_claims", "minItems")]),
            ("reasoning 1200 ok", lambda d: d.update(reasoning_summary="r" * 1200), []),
            ("reasoning empty", lambda d: d.update(reasoning_summary=""), [("/reasoning_summary", "minLength")]),
            ("explanation 300 ok", lambda d: d["confidence"].update(explanation="e" * 300), []),
            ("explanation 301", lambda d: d["confidence"].update(explanation="e" * 301), [("/confidence/explanation", "maxLength")]),
            ("explanation empty", lambda d: d["confidence"].update(explanation=""), [("/confidence/explanation", "minLength")]),
            ("four alternatives", lambda d: d.update(alternative_hypotheses=[copy.deepcopy(d["alternative_hypotheses"][0]) for _ in range(4)]), [("/alternative_hypotheses", "maxItems")]),
            ("alternative text 241", lambda d: d["alternative_hypotheses"][0].update(hypothesis="a" * 241), [("/alternative_hypotheses/0/hypothesis", "maxLength")]),
            ("six missing items", lambda d: d.update(missing_evidence=["m"] * 6), [("/missing_evidence", "maxItems")]),
            ("missing item 161", lambda d: d.update(missing_evidence=["m" * 161]), [("/missing_evidence/0", "maxLength")]),
            ("model empty", lambda d: d["provider"].update(model=""), [("/provider/model", "minLength")]),
            ("model 81", lambda d: d["provider"].update(model="m" * 81), [("/provider/model", "maxLength")]),
        ]
        for label, mutate, expected in cases:
            with self.subTest(case=label):
                self.assertEqual(pairs(mutated(mutate)), expected)


class AbstentionRulesTest(unittest.TestCase):
    def test_abstain_and_status_must_agree(self):
        self.assertEqual(pairs(mutated(lambda d: d.update(status="abstained"))), [("/status", "const")])
        self.assertEqual(pairs(mutated(lambda d: d.update(status="completed"), abstained())), [("/status", "const")])

    def test_an_abstention_must_have_no_claims(self):
        document = abstained()
        document["supporting_claims"] = copy.deepcopy(VALID["supporting_claims"][:1])
        self.assertEqual(pairs(document), [("/supporting_claims", "maxItems")])

    def test_an_abstention_must_name_what_is_missing(self):
        document = abstained()
        document["missing_evidence"] = []
        self.assertEqual(pairs(document), [("/missing_evidence", "minItems")])

    def test_an_abstention_must_have_low_confidence(self):
        document = abstained()
        document["confidence"]["value"] = "high"
        self.assertEqual(pairs(document), [("/confidence/value", "const")])

    def test_an_abstention_may_only_investigate_or_do_nothing(self):
        document = abstained()
        document["remediation_recommendation"]["action_type"] = "none"
        self.assertEqual(validate_document(document), [])
        document["remediation_recommendation"]["action_type"] = "rollback_deployment"
        found = pairs(document)
        self.assertIn(("/remediation_recommendation/action_type", "enum"), found)


class RecommendationRulesTest(unittest.TestCase):
    def test_a_recommendation_always_requires_approval_and_is_never_executable(self):
        self.assertEqual(
            pairs(mutated(lambda d: d["remediation_recommendation"].update(requires_approval=False))),
            [("/remediation_recommendation/requires_approval", "const")],
        )
        for value in (True, "false", 0, None):
            with self.subTest(executable=value):
                found = pairs(mutated(lambda d, v=value: d["remediation_recommendation"].update(executable=v)))
                self.assertIn(("/remediation_recommendation/executable", "const"), found)

    def test_every_recommendation_field_is_required(self):
        for name in ("action_type", "summary", "parameters", "risk", "expected_effect", "rollback_note",
                     "executable", "requires_approval"):
            with self.subTest(name=name):
                found = pairs(mutated(lambda d, n=name: d["remediation_recommendation"].pop(n)))
                self.assertIn(("/remediation_recommendation", "required"), found)

    def test_action_type_and_risk_are_enums(self):
        self.assertEqual(
            pairs(mutated(lambda d: d["remediation_recommendation"].update(action_type="restart_service"))),
            [("/remediation_recommendation/action_type", "enum")] + [],
        )
        self.assertEqual(
            pairs(mutated(lambda d: d["remediation_recommendation"].update(risk="severe"))),
            [("/remediation_recommendation/risk", "enum")],
        )

    def test_a_rollback_needs_all_three_parameters(self):
        found = pairs(mutated(lambda d: d["remediation_recommendation"].update(parameters={})))
        self.assertEqual(found, [("/remediation_recommendation/parameters", "required")])
        found = pairs(mutated(lambda d: d["remediation_recommendation"]["parameters"].pop("from_version")))
        self.assertEqual(found, [("/remediation_recommendation/parameters", "required")])

    def test_investigate_and_none_take_no_parameters(self):
        def investigate(document):
            document["remediation_recommendation"]["action_type"] = "investigate"

        self.assertEqual(
            pairs(mutated(investigate)), [("/remediation_recommendation/parameters", "maxProperties")]
        )

        def investigate_clean(document):
            investigate(document)
            document["remediation_recommendation"]["parameters"] = {}

        self.assertEqual(validate_document(mutated(investigate_clean)), [])

    def test_parameter_values_are_bounded_strings_and_the_deployment_id_is_a_uuid(self):
        self.assertEqual(
            pairs(mutated(lambda d: d["remediation_recommendation"]["parameters"].update(deployment_id="latest"))),
            [("/remediation_recommendation/parameters/deployment_id", "pattern")],
        )
        self.assertEqual(
            pairs(mutated(lambda d: d["remediation_recommendation"]["parameters"].update(service=3))),
            [("/remediation_recommendation/parameters/service", "type")],
        )

    def test_recommendation_text_bounds(self):
        cases = [
            ("summary 300 ok", {"summary": "s" * 300}, []),
            ("summary 301", {"summary": "s" * 301}, [("/remediation_recommendation/summary", "maxLength")]),
            ("effect 200 ok", {"expected_effect": "e" * 200}, []),
            ("effect 201", {"expected_effect": "e" * 201}, [("/remediation_recommendation/expected_effect", "maxLength")]),
            ("note 201", {"rollback_note": "n" * 201}, [("/remediation_recommendation/rollback_note", "maxLength")]),
            ("summary empty", {"summary": ""}, [("/remediation_recommendation/summary", "minLength")]),
        ]
        for label, change, expected in cases:
            with self.subTest(case=label):
                self.assertEqual(pairs(mutated(lambda d, c=change: d["remediation_recommendation"].update(c))), expected)


class ProviderRulesTest(unittest.TestCase):
    def test_provider_name_and_fallback_are_known_values(self):
        self.assertEqual(pairs(mutated(lambda d: d["provider"].update(name="anthropic"))), [("/provider/name", "enum")])
        self.assertEqual(
            pairs(mutated(lambda d: d["provider"].update(fallback_from="gpt"))), [("/provider/fallback_from", "enum")]
        )
        self.assertEqual(validate_document(mutated(lambda d: d["provider"].update(fallback_from="openai-compatible"))), [])
        self.assertEqual(
            validate_document(mutated(lambda d: d["provider"].update(name="openai-compatible", model="some-model"))), []
        )


class SchemaPathTest(unittest.TestCase):
    def test_agent_schema_path_wins_when_supplied(self):
        with tempfile.TemporaryDirectory() as tmp:
            custom = Path(tmp) / "custom.schema.json"
            custom.write_text("{}", encoding="utf-8")
            self.assertEqual(schema_path({"AGENT_SCHEMA_PATH": str(custom)}), custom)

    def test_a_missing_file_named_by_agent_schema_path_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                schema_path({"AGENT_SCHEMA_PATH": str(Path(tmp) / "nope.json")})

    def test_an_empty_agent_schema_path_is_treated_as_unset(self):
        self.assertEqual(schema_path({"AGENT_SCHEMA_PATH": ""}), schema_path({}))

    def test_the_default_finds_the_repository_schema_from_any_working_directory(self):
        expected = EVENTS / "diagnosis.schema.json"
        before = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                found = schema_path({})
            finally:
                os.chdir(before)
        self.assertEqual(found.resolve(), expected.resolve())
        self.assertTrue(found.is_file())

    def test_find_schema_searches_upward_from_the_start_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "contracts" / "events" / "diagnosis.schema.json"
            target.parent.mkdir(parents=True)
            target.write_text("{}", encoding="utf-8")
            deep = root / "services" / "agent-python" / "src" / "pkg"
            deep.mkdir(parents=True)
            self.assertEqual(find_schema(deep), target)
            self.assertEqual(find_schema(root), target)

    def test_find_schema_fails_closed_when_nothing_is_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                find_schema(Path(tmp))


if __name__ == "__main__":
    unittest.main()
