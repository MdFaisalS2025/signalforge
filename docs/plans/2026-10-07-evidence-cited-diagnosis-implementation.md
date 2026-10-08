# Evidence-cited diagnosis implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **Proposed for review.** Do not start until
[2026-10-07-evidence-cited-diagnosis.md](../specs/2026-10-07-evidence-cited-diagnosis.md) is approved.
Implements: the spec above, exactly. Any change to a contract in that spec is a spec change first.

**Goal:** a Python agent that diagnoses each published incident from bounded stored evidence, persists a
grounded, versioned diagnosis, and shows it on the incident page, with no key and no cloud call.

**Architecture:** `agent-python` polls ClickHouse for published, undiagnosed incidents, builds a bounded evidence
bundle, runs a deterministic analyzer, validates the result mechanically, and inserts one row into a new
`diagnoses` table as a least-privilege account. The dashboard reads that table read-only, re-validates, and renders it.

**Tech Stack:** Python 3.12 (standard library plus `jsonschema`), ClickHouse HTTP, the existing Go migration runner,
Next.js (existing), Docker Compose.

**Spec:** [2026-10-07-evidence-cited-diagnosis.md](../specs/2026-10-07-evidence-cited-diagnosis.md)

## Global Constraints

- Contract version is `1.1`; `NAMESPACE = 8f3c2a9e-5d1b-4f6a-b7c8-2e9d0a1b3c4d`;
  `diagnosis_id = UUIDv5(NAMESPACE, "diagnosis|<incident_id>|<diagnosis_version>")`.
- Defaults: `AGENT_PROVIDER=deterministic`, `AGENT_POLL_INTERVAL_S=2`, `AGENT_BATCH_SIZE=5`,
  `AGENT_REVISION_POLICY=first-only`. Deterministic `model_version = deterministic-rules-1`, `prompt_version = none`.
- Bounds: 8 evidence rows, 3 traces, 30 span rows, 30 log rows, bundle at most 16,384 bytes; hypothesis at most 240
  characters; claim at most 280; claims 1 to 6; alternatives 0 to 3; `missing_evidence` 0 to 5 items of at most 160;
  reasoning summary at most 1,200; confidence explanation at most 300.
- Five claim kinds: `deployment_succeeded`, `deployment_before_failure`, `failure_burst`, `http_500_in_payments`,
  `failures_share_deployment`. Validator codes: `G0_schema` through `G8_text_bound`. Failure codes:
  `validation_rejected`, `invalid_incident`, `bundle_too_large`.
- The agent's only write is one `INSERT` into `diagnoses`. `executable` is always `false`; `requires_approval` is
  always `true`.
- No external AI call, no API key, and no network beyond Compose in any test, fixture, or acceptance run.
- Existing behavior is preserved: no change to `demo-orders`, `demo-payments`, the Collector config, the normalizer,
  correlator, publisher, existing tables, existing topics, or the two existing acceptance scripts.
- The dashboard stays read-only and bound to `127.0.0.1:3000`. No new dashboard route.

## Ground rules for every task

- **Test first.** Each task writes its failing test, runs it, and records the exact failure before any
  implementation. A test that passes before the change is wrong or redundant, and the task is not done.
- **RED evidence.** The commit body of every task lists the failing command and the first failure line, then the
  passing command and its summary line.
- **One commit per task**, staged by explicit path, after `git diff --cached --check` and a read of the staged diff.
- **Python runs in Docker** through `scripts/py-in-docker.mjs` (T1). Do not install packages on the host.
- **No shell composition.** Child processes use argument arrays. Commands in this plan are shown as they run.
- **Bounded waits only.** Every network call has a deadline; every wait is a deadline-bounded poll. No step sleeps for
  a fixed expected duration.
- **Local credentials only.** `changeme-local-only` is the existing convention. No other secret exists in the repo.
- **No key, no provider call.** Only T13 touches provider code, and only against an in-process fake server.
- Do not merge, rebase, push, or amend. Do not touch `master`, `feature/incident-dashboard`, or the Orders/Payments
  worktree. Do not use `docker compose down -v` or remove volumes.

## Validation commands

Run at the end of every task that owns the matching code:

```bash
node scripts/py-in-docker.mjs python -m unittest discover -s tests -v     # agent tests (from T1)
python scripts/validate-schemas.py                                         # contracts
node --test scripts/py-in-docker.test.mjs scripts/verify-evidence-cited-diagnosis.test.mjs scripts/verify-incident-dashboard.test.mjs
npm --prefix apps/web test
npm --prefix apps/web run typecheck
node scripts/go-in-docker.mjs go test ./...                                # after T6
docker compose -f infra/docker/docker-compose.yml config --quiet
```

Tests that need ClickHouse (account tests, repository integration) wait, with a bound, for ClickHouse to answer and
start nothing themselves, the same pattern as `scripts/verify-incident-dashboard.test.mjs`.

## File ownership

| Path | Owner task |
|---|---|
| `scripts/py-in-docker.mjs`, `scripts/py-in-docker.test.mjs` | T1 |
| `services/agent-python/Dockerfile` (`deps` stage), `Dockerfile.dockerignore`, `requirements.txt` | T1 |
| `services/agent-python/src/signalforge_agent/__init__.py`, `config.py`, `tests/test_config.py` | T1 |
| `contracts/events/diagnosis.schema.json`, `contracts/events/samples/diagnosis.sample.json`, `contracts/events/samples/invalid/diagnosis.*.json` | T2 |
| `services/agent-python/src/signalforge_agent/contract.py`, `tests/test_contract.py` | T2 |
| `src/signalforge_agent/ids.py`, `bundle.py`, `tests/test_ids.py`, `tests/test_bundle.py`, `tests/fixtures/raw_*.json` | T3 |
| `src/signalforge_agent/grounding.py`, `analyzer_rules.py`, `tests/test_analyzer.py`, `tests/fixtures/golden_*.json` | T4 |
| `src/signalforge_agent/validator.py`, `tests/test_validator.py` | T5 |
| `services/collector-go/internal/store/migrations/0002_diagnoses.sql`, `internal/store/migrate_test.go` | T6 |
| `infra/clickhouse/users.d/agent-writer.xml`, `infra/docker/docker-compose.yml` (clickhouse volume line) | T6 |
| `scripts/verify-evidence-cited-diagnosis.test.mjs` | T6 (created), T9, T12 |
| `src/signalforge_agent/chclient.py`, `repository.py`, `tests/test_chclient.py`, `tests/test_repository.py`, `tests/test_repository_integration.py` | T7 |
| `src/signalforge_agent/orchestrator.py`, `provider.py` (interface and `DeterministicProvider`), `health.py`, `__main__.py`, `tests/test_orchestrator.py` | T8 |
| `services/agent-python/Dockerfile` (`runtime` stage), `infra/docker/docker-compose.yml` (`agent-python`) | T9 |
| `apps/web/src/server/queries.ts`, `clickhouse.ts`, `model.ts`, `diagnosis.ts`, `service.ts` (+ tests), `apps/web/app/api/api.test.ts` | T10 |
| `apps/web/src/ui/diagnosis-card.tsx`, `incident-list.tsx` (+ tests), `apps/web/app/incidents/[incidentId]/page.tsx`, `apps/web/app/globals.css` | T11 |
| `scripts/verify-evidence-cited-diagnosis.mjs`, `README.md`, `.env.example`, `services/agent-python/README.md` | T12 |
| `src/signalforge_agent/provider.py` (`OpenAICompatibleProvider`), `tests/test_provider_openai.py` | T13 |

## Decisions that need a user-provided key or external authorization

**None of T1 through T12 needs any.** The default analyzer is deterministic, and every test and acceptance run is
local. These decisions arise only if the user chooses to go beyond the slice, and each stays blocked until the
user decides:

| # | Decision | Needs |
|---|---|---|
| D1 | Turn on a real provider (`AGENT_PROVIDER=openai-compatible`) | A user-supplied API key, set only in the user's own environment |
| D2 | Choose the endpoint and model | The user's choice of vendor, base URL, and model name |
| D3 | Allow telemetry-derived evidence to leave this machine (`AGENT_PROVIDER_ALLOW_EXTERNAL=yes`) | The user's explicit consent, per section 13.1 of the spec |
| D4 | Spend money on provider calls | The user's approval of a cost ceiling; the slice sets no spend limit of its own |
| D5 | Run any live provider evaluation or screenshot with a real provider | The user's go-ahead, after D1 to D4 |
| D6 | Run a local model server for the "local host" provider path | The user installing it; the slice does not install one |

Two ordinary build-time network uses are noted so they are not a surprise: T1 pulls the pinned Python base image,
and T1 installs `jsonschema` and its pinned dependencies inside the build from the package index. Neither involves an
AI provider.

## Tasks

### T1. Python scaffold, Docker test runner, and configuration

**Goal:** tests run reproducibly in a pinned container, and the agent's configuration fails closed.

**Files:**
- Create: `scripts/py-in-docker.mjs`, `scripts/py-in-docker.test.mjs`
- Create: `services/agent-python/Dockerfile` (stage `deps`), `Dockerfile.dockerignore`, `requirements.txt`
- Create: `services/agent-python/src/signalforge_agent/__init__.py`, `config.py`
- Create: `services/agent-python/tests/__init__.py`, `tests/test_config.py`

**Interfaces:**
- Produces: `config.load(env: Mapping[str, str]) -> AgentConfig`; `ConfigError(Exception)` whose message names the
  variable and never its value; `AgentConfig` frozen dataclass with fields `clickhouse_url`, `database`, `user`,
  `password`, `poll_interval_s`, `batch_size`, `revision_policy`, `heartbeat_path`, `provider`, `provider_base_url`,
  `provider_model`, `provider_api_key`, `provider_allow_external`, `provider_timeout_s`. Its `repr` redacts
  `password` and `provider_api_key`.
- Produces: `node scripts/py-in-docker.mjs [--network <name>] [--env KEY=VALUE]... <python command...>`, which builds
  the `deps` stage (`docker build -f services/agent-python/Dockerfile --target deps -t signalforge-agent-deps`, with the
  repository root as the build context) as image `signalforge-agent-deps`, then runs the command in it with the repository mounted
  read-only at `/repo`, working directory `/repo/services/agent-python`, and `PYTHONPATH=src`,
  `PYTHONDONTWRITEBYTECODE=1`. Exports `parseWrapperArgs` and `buildDockerArgs` for tests.

- [ ] **Step 1: Write the failing wrapper test.** Create `scripts/py-in-docker.test.mjs`, modeled on
  `scripts/go-in-docker.test.mjs`: it asserts `parseWrapperArgs(['--network','n','python','-V'])` returns the network
  args and `['python','-V']`; that a missing network value, a malformed `--env`, an unknown flag, and an empty
  command each throw; and that `buildDockerArgs` contains `run`, `--rm`, a `:ro` repository mount, the `-w`, `-e
  PYTHONPATH=src`, and never the string `sh -c`.
- [ ] **Step 2: Run it.** `node --test scripts/py-in-docker.test.mjs`. Expected RED: `Cannot find module
  '.../py-in-docker.mjs'`. Record it.
- [ ] **Step 3: Implement the wrapper**, spawning `docker` with an argument array and inheriting stdio. Resolve the
  base image digest once and record it in the Dockerfile:
  ```bash
  docker pull python:3.12-slim
  docker inspect --format "{{index .RepoDigests 0}}" python:3.12-slim
  ```
  Put the printed `python:3.12-slim@sha256:<digest>` in `ARG PYTHON_IMAGE=` in the Dockerfile, and nowhere else.
- [ ] **Step 4: Create the Dockerfile, `Dockerfile.dockerignore`, and `requirements.txt`.** `deps` installs
  `requirements.txt` into the image. Generate `requirements.txt` inside the pinned image so the pins are real:
  ```bash
  docker run --rm python:3.12-slim@sha256:<digest> sh -c "pip install --quiet jsonschema==4.26.0 && pip freeze"
  ```
  Save the output verbatim. It must contain `jsonschema==4.26.0` and every transitive pin.
- [ ] **Step 5: Run the wrapper test.** `node --test scripts/py-in-docker.test.mjs`. Expected GREEN.
- [ ] **Step 6: Write `tests/test_config.py` (RED).** Cases, each with an exact assertion:
  ```python
  def test_defaults(self):
      cfg = load({"CLICKHOUSE_URL": "http://ch:8123", "CLICKHOUSE_USER": "u", "CLICKHOUSE_PASSWORD": "p"})
      self.assertEqual((cfg.poll_interval_s, cfg.batch_size, cfg.revision_policy, cfg.provider),
                       (2, 5, "first-only", "deterministic"))

  def test_error_names_variable_not_value(self):
      with self.assertRaises(ConfigError) as ctx:
          load({**BASE, "AGENT_POLL_INTERVAL_S": "999-secret"})
      self.assertIn("AGENT_POLL_INTERVAL_S", str(ctx.exception))
      self.assertNotIn("999-secret", str(ctx.exception))
  ```
  Also: poll interval outside 1 to 60 and batch outside 1 to 20 rejected; unknown revision policy rejected; missing
  `CLICKHOUSE_URL`, user, or password rejected; `openai-compatible` without base URL or model rejected; `http` for a
  non-local provider host rejected; `http://localhost:8000` and `http://host.docker.internal:8000` accepted without a
  key; a non-local `https` host without `AGENT_PROVIDER_ALLOW_EXTERNAL=yes` rejected; a non-local host without a key
  rejected; `repr(cfg)` contains neither the password nor the key; with `AGENT_PROVIDER=deterministic` the provider
  variables are ignored even when invalid.
- [ ] **Step 7: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_config -v`. Expected RED:
  `ModuleNotFoundError: No module named 'signalforge_agent.config'`.
- [ ] **Step 8: Implement `config.py` minimally, then re-run.** Expected GREEN.

**Validation:** the two commands above, plus `docker compose -f infra/docker/docker-compose.yml config --quiet`.

**Commit:** `feat(agent): scaffold Python agent, Docker test runner, and fail-closed configuration`

### T2. Diagnosis contract 1.1

**Goal:** the typed document of spec section 7 is a validated contract with samples that prove what it rejects.

**Files:**
- Modify: `contracts/events/diagnosis.schema.json`, `contracts/events/samples/diagnosis.sample.json`
- Create: `contracts/events/samples/invalid/diagnosis.<variant>.json` for the variants below
- Create: `services/agent-python/src/signalforge_agent/contract.py`, `tests/test_contract.py`

**Interfaces:**
- Produces: `contract.validate_document(doc: dict) -> list[ContractError]`, where `ContractError` has `path: str`
  (JSON pointer) and `keyword: str` (the failing validator keyword); an empty list means valid.
  `contract.schema_path() -> Path` uses `AGENT_SCHEMA_PATH` when set, else the nearest parent directory containing
  `contracts/events/diagnosis.schema.json`.

- [ ] **Step 1: Write the new valid sample** (the spec section 7 example, using the real demo IDs and the documented
  `diagnosis_id`), and the invalid samples, one defect each: `diagnosis.executable-true.json`,
  `diagnosis.claim-without-evidence.json`, `diagnosis.unknown-claim-kind.json`, `diagnosis.abstain-with-hypothesis.json`,
  `diagnosis.completed-without-hypothesis.json`, `diagnosis.overlong-reasoning.json` (1,201 characters),
  `diagnosis.confidence-not-enum.json`, `diagnosis.bad-digest.json`, `diagnosis.extra-field.json`.
- [ ] **Step 2: Write `tests/test_contract.py` (RED).** The valid sample validates. Each invalid sample fails for its
  specific reason, asserted by pointer and keyword, not by "any error":
  ```python
  EXPECTED = {
      "diagnosis.executable-true.json": ("/remediation_recommendation/executable", "const"),
      "diagnosis.claim-without-evidence.json": ("/supporting_claims/0/evidence_ids", "minItems"),
      "diagnosis.unknown-claim-kind.json": ("/supporting_claims/0/kind", "enum"),
      "diagnosis.overlong-reasoning.json": ("/reasoning_summary", "maxLength"),
      "diagnosis.confidence-not-enum.json": ("/confidence/value", "enum"),
      "diagnosis.bad-digest.json": ("/input_digest", "pattern"),
      "diagnosis.extra-field.json": ("", "additionalProperties"),
  }
  ```
  The two abstention samples assert the `if`/`then` pointer on `/primary_hypothesis` (`not`) and on the missing
  property (`required`). One more test asserts the old `1.0` sample shape (`schema_version: "1.0"`) is rejected on
  `/schema_version` with `const`.
- [ ] **Step 3: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_contract -v` and
  `python scripts/validate-schemas.py`. Expected RED: the new sample fails the old schema
  (`Additional properties are not allowed`), and `contract` does not exist.
- [ ] **Step 4: Update the schema** to version `1.1` per spec section 7.1 to 7.4 (`allOf` with `if`/`then` on
  `abstain`; `executable` const `false`; `requires_approval` const `true`; `created_at` pattern for exactly three
  fractional digits; `input_digest` pattern `^sha256:[0-9a-f]{64}$`). Implement `contract.py` with `jsonschema`.
- [ ] **Step 5: Re-run both commands.** Expected GREEN: `All 7 valid samples validate and all 11 invalid samples
  are rejected` (the valid sample is replaced, not added, and nine invalid samples join the existing two; confirm
  the counts against the output rather than the plan).

**Validation:** both commands; `python scripts/validate-schemas.py` must still pass every non-diagnosis sample.

**Commit:** `feat(contracts): define diagnosis contract 1.1 with grounded claims and a non-executable recommendation`

### T3. Identity, digest, and the bounded evidence bundle

**Goal:** the only input the analyzer and any provider ever see is a small, allowlisted, stably ordered bundle.

**Files:**
- Create: `src/signalforge_agent/ids.py`, `bundle.py`; `tests/test_ids.py`, `tests/test_bundle.py`
- Create: `tests/fixtures/raw_faulty_deploy_full.json` (and the other `raw_*.json` fixtures of spec 11.2)

**Interfaces:**
- Produces (`ids.py`): `NAMESPACE: uuid.UUID`; `diagnosis_id(incident_id: str, version: int) -> str`;
  `analyzer_id(provider: str, model_version: str, prompt_version: str) -> str` (`"<p>|<m>|<v>"`);
  `input_digest(bundle: EvidenceBundle) -> str` (`"sha256:<hex>"`).
- Produces (`bundle.py`): `RawIncidentData(incident: dict, evidence: list[dict], deployment: dict | None, spans:
  list[dict], logs: list[dict])` (rows exactly as ClickHouse `JSONEachRow` returns them);
  `EvidenceBundle` (frozen; `incident`, `evidence`, `deployment`, `traces`), where each trace entry holds its
  `evidence_id`, `trace_id`, `spans`, `logs`; `build_bundle(raw: RawIncidentData) -> EvidenceBundle`;
  `EvidenceBundle.evidence_ids() -> frozenset[str]`; `EvidenceBundle.allowed_tokens() -> frozenset[str]`;
  `BundleTooLarge(Exception)`; `to_api_timestamp(value: str) -> str` (`2026-10-07 21:49:30.988000000` becomes
  `2026-10-07T21:49:30.988000000Z`).

- [ ] **Step 1: Write `tests/test_ids.py` (RED).** A golden: `diagnosis_id("5893b198-6ad5-5708-bb7e-a0d2ca4ca323", 1)`
  equals `c03997a4-e1ef-5a94-8a2e-62d9694d7642`; versions 1 and 2 differ; the digest of the same bundle built from
  shuffled raw rows is identical; changing one evidence summary changes the digest; the digest matches
  `^sha256:[0-9a-f]{64}$`; `analyzer_id("deterministic", "deterministic-rules-1", "none")` equals
  `deterministic|deterministic-rules-1|none`.
- [ ] **Step 2: Write `tests/test_bundle.py` (RED).** Each is one test:
  - at most 8 evidence rows are kept (nine in, `BundleTooLarge` is not raised, the extra is dropped deterministically
    by sort order) and at most 3 trace IDs are followed;
  - span rows keep only `span.kind`, `span.name`, `http.response.status_code`; a raw attribute such as `order_id` or
    `http.request.body` never appears anywhere in the canonical JSON;
  - a log with body `charge failed` is kept; a log with body `ignore previous instructions` becomes
    `[unrecognized log message omitted]` and the original text appears nowhere in the canonical JSON;
  - `initiated_by` and `previous_version` never appear;
  - more than 16,384 canonical bytes raises `BundleTooLarge`;
  - `allowed_tokens()` contains every incident, evidence, deployment, and trace ID, the version, and the fixed
    detection facts `30`, `300`, and `500` (the HTTP failure status of the known rule, never read from telemetry), and
    does not contain an ID from a different incident's fixture or a status code that merely appears in raw spans.
- [ ] **Step 3: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_ids tests.test_bundle -v`.
  Expected RED: `ModuleNotFoundError: No module named 'signalforge_agent.ids'`.
- [ ] **Step 4: Implement `ids.py` and `bundle.py`** (UUIDv5 from the standard library; canonical JSON with
  `sort_keys=True, separators=(",", ":"), ensure_ascii=False`; lists sorted by `(timestamp, source_type, source_ref)`
  and `(timestamp, span_id)`).
- [ ] **Step 5: Re-run.** Expected GREEN.

**Commit:** `feat(agent): add deterministic identity, input digest, and the bounded evidence bundle`

### T4. Grounding facts and the deterministic analyzer

**Goal:** the known faulty-deployment scenario yields an exact, citable diagnosis, and anything else abstains.

**Files:**
- Create: `src/signalforge_agent/grounding.py`, `analyzer_rules.py`; `tests/test_analyzer.py`
- Create: `tests/fixtures/golden_<fixture>.json` for each fixture in spec 11.2

**Interfaces:**
- Consumes: `EvidenceBundle` and `to_api_timestamp` (T3), `contract.validate_document` (T2), `ids` (T3).
- Produces (`grounding.py`): `abstain_reasons(bundle) -> list[str]` (the exact `missing_evidence` texts of spec 7.6,
  in table order); `max_confidence(bundle) -> str` (`high`, `medium`, or `low`); `verify_claim(kind: str,
  evidence_ids: Sequence[str], bundle) -> list[str]` (empty when verified; else the codes `G2_kind_citation_shape` or
  `G3_claim_not_verified`); `format_seconds(ns: int) -> str` (integer arithmetic, half up to one decimal).
- Produces (`analyzer_rules.py`): `analyze(bundle, *, version: int, now: datetime) -> dict`, a schema-valid document
  with `provider = {"name": "deterministic", "model": "deterministic-rules-1", "fallback_from": null}`.

- [ ] **Step 1: Write the fixtures** (`raw_*.json` already exist from T3) and golden documents for the seven fixtures
  of spec 11.2, authored by hand from the spec's rules, with `now = 2026-10-07T21:49:41.208Z`.
- [ ] **Step 2: Write `tests/test_analyzer.py` (RED).** One test per fixture asserting `analyze(...) == golden`, and
  that `contract.validate_document` returns `[]`. Plus:
  ```python
  def test_format_seconds_rounds_half_up(self):
      self.assertEqual(format_seconds(4_552_000_000), "4.6")
      self.assertEqual(format_seconds(4_550_000_000), "4.6")
      self.assertEqual(format_seconds(102_000_000), "0.1")
      self.assertEqual(format_seconds(0), "0.0")
  ```
  and: the `prompt_injection_log` output contains none of the injected text; the `faulty_deploy_no_telemetry`
  document has no `failures_share_deployment` claim and `confidence.value == "medium"`; every abstention has
  `abstain: true`, `status: "abstained"`, confidence `low`, a non-empty `missing_evidence`, no
  `primary_hypothesis`, no claims, and `action_type` `investigate`.
- [ ] **Step 3: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_analyzer -v`. Expected RED:
  `ModuleNotFoundError: No module named 'signalforge_agent.grounding'`.
- [ ] **Step 4: Implement `grounding.py`, then `analyzer_rules.py`** exactly per spec 7.6 (claims in the stated order,
  the two alternatives, the fixed reasoning template, the recommendation).
- [ ] **Step 5: Re-run.** Expected GREEN. If a golden and the spec disagree, the spec wins: fix the golden and say so
  in the commit body.

**Commit:** `feat(agent): add the deterministic evidence-based analyzer and its grounding facts`

### T5. Grounding validator

**Goal:** a document that is not supported by the bundle cannot pass.

**Files:**
- Create: `src/signalforge_agent/validator.py`; `tests/test_validator.py`

**Interfaces:**
- Consumes: `contract.validate_document` (T2), `grounding.verify_claim`, `grounding.max_confidence` (T4),
  `EvidenceBundle.evidence_ids()`, `allowed_tokens()` (T3).
- Produces: `validate(document: dict, bundle: EvidenceBundle) -> None`, raising
  `ValidationRejected(codes: tuple[str, ...])` with every failed code (`G0_schema` through `G8_text_bound`), sorted.

- [ ] **Step 1: Write `tests/test_validator.py` (RED).** First, the golden `faulty_deploy_full` document passes. Then
  one mutation per case of spec 11.3, each asserting the exact code tuple, for example:
  ```python
  def test_fabricated_citation_is_rejected(self):
      doc = copy.deepcopy(GOLDEN)
      doc["supporting_claims"][0]["evidence_ids"] = ["00000000-0000-4000-8000-000000000000"]
      with self.assertRaises(ValidationRejected) as ctx:
          validate(doc, BUNDLE)
      self.assertEqual(ctx.exception.codes, ("G1_unknown_evidence",))

  def test_other_incidents_evidence_is_unknown(self):
      doc = copy.deepcopy(GOLDEN)
      doc["supporting_claims"][0]["evidence_ids"] = [OTHER_INCIDENT_EVIDENCE_ID]
      ...codes == ("G1_unknown_evidence",)
  ```
  Also: an invented trace ID in a claim (`G4`); an invented number (`G4`); the integers `300` and `500` are allowed
  because `bundle.allowed_tokens()` holds them as fixed detection facts, so the validator needs no special case for the
  analyzer's "HTTP 500" wording, while any other status code such as `418` is rejected (`G4`);
  `high` with no telemetry (`G5`); abstention inconsistencies (`G6`); `docker restart` in the summary, a changed
  service parameter, and `executable: true` after bypassing the schema in a unit-level call (`G7`); `<script>` and
  `SELECT` in text (`G8`); a schema failure returns only `("G0_schema",)`. A last test asserts that two defects in
  one document yield both codes.
- [ ] **Step 2: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_validator -v`. Expected RED:
  `ModuleNotFoundError: No module named 'signalforge_agent.validator'`.
- [ ] **Step 3: Implement `validator.py`** per spec 7.5, including the token extraction (UUIDs, 32-hex IDs,
  dotted-or-hyphenated version strings, integers and decimals) and the whole-word command pattern.
- [ ] **Step 4: Re-run the validator tests and the analyzer tests.** Expected GREEN. Add one analyzer test that every
  golden document passes `validate` against its own bundle (a regression that links T4 and T5).

**Commit:** `feat(agent): reject ungrounded diagnoses with a mechanical citation and claim validator`

### T6. `diagnoses` table, migration, and the least-privilege account

**Goal:** the agent has exactly one table it can write, created by the existing migration runner.

**Files:**
- Create: `services/collector-go/internal/store/migrations/0002_diagnoses.sql`
- Modify: `services/collector-go/internal/store/migrate_test.go`
- Create: `infra/clickhouse/users.d/agent-writer.xml`
- Modify: `infra/docker/docker-compose.yml` (one `clickhouse` volume line)
- Create: `scripts/verify-evidence-cited-diagnosis.test.mjs` (account tests)

**Interfaces:**
- Produces: table `diagnoses` as in spec section 8.1; ClickHouse user `agent_writer` as in spec section 8.5.

- [ ] **Step 1: Write the failing Go test.** In `migrate_test.go`, a test that the embedded migrations include a
  version-2 file named `0002_diagnoses.sql` whose SQL contains `CREATE TABLE IF NOT EXISTS diagnoses` and each
  column name of spec 8.1. Run `node scripts/go-in-docker.mjs go test ./internal/store/...`. Expected RED:
  `expected migration version 2`. Record it.
- [ ] **Step 2: Write the failing account tests** in `scripts/verify-evidence-cited-diagnosis.test.mjs`, in a
  `describe('agent_writer account (needs ClickHouse)')` with a bounded readiness wait. Using
  `docker compose exec -T clickhouse clickhouse-client --user agent_writer …` with argument arrays, assert: `SELECT
  count() FROM signalforge.incidents` and `…telemetry_events` succeed; `INSERT INTO signalforge.diagnoses (diagnosis_id)
  SELECT generateUUIDv4() WHERE 0` is accepted; each of `INSERT INTO signalforge.incidents`, `…evidence_items`,
  `…deployments`, `ALTER TABLE signalforge.diagnoses ADD COLUMN x String`, `DROP TABLE signalforge.diagnoses`, and
  `SELECT * FROM system.query_log LIMIT 1` fails with an access-denied error; `dashboard_reader` can `SELECT count()
  FROM signalforge.diagnoses` and cannot insert into it (`READONLY`). Run the file with the stack up. Expected RED:
  `Authentication failed` for `agent_writer` (the account does not exist) and, after the user exists but before the
  migration, `Unknown table`. Record both.
- [ ] **Step 3: Create `0002_diagnoses.sql`** with the exact table of spec 8.1.
- [ ] **Step 4: Create `agent-writer.xml`** and mount it read-only in the `clickhouse` service, next to the dashboard
  reader's file (mount only the file, not the directory, for the reason the dashboard plan records). The six
  table-qualified grants and the profile limits are exactly those of spec 8.5. Use `<grants>` only and no
  `<allow_databases>`: ClickHouse 24.8 (tested on 24.8.14.39) refuses to start when a users-file user combines them
  (`BAD_ARGUMENTS`), and keeping `allow_databases` without `<grants>` would grant broad privileges within
  `signalforge`. The table-qualified grants are the scope boundary.
- [ ] **Step 5: Apply.** `docker compose -f infra/docker/docker-compose.yml up -d --build clickhouse collector-go`
  (never `-v`). Confirm `SELECT max(version) FROM signalforge.schema_migrations` returns 2.
- [ ] **Step 6: Re-run the Go tests and the account tests.** Expected GREEN. If ClickHouse rejects the grant syntax in
  the users file, adjust the file (for example to a role-based form) until each assertion passes, and record the
  working form and the ClickHouse version in the commit body; do not weaken an assertion.
- [ ] **Step 7: Prove correlation is intact.** `node scripts/go-in-docker.mjs go vet ./...` and `go test ./...`
  pass, and `node scripts/verify-faulty-deployment-incident.mjs` still exits 0 against the running stack.

**Commit:** `feat(store): add diagnoses table and a least-privilege agent account`

### T7. ClickHouse HTTP client and repository

**Goal:** all reads are bounded and parameterized, and the write is idempotent.

**Files:**
- Create: `src/signalforge_agent/chclient.py`, `repository.py`; `tests/test_chclient.py`, `tests/test_repository.py`,
  `tests/test_repository_integration.py`

**Interfaces:**
- Consumes: `RawIncidentData` and `ids` (T3), `AgentConfig` (T1).
- Produces (`chclient.py`): `ClickHouseClient(url, database, user, password, timeout_s, transport=None)` with
  `query(sql: str, params: Mapping[str, object] | None = None) -> list[dict]` (appends `FORMAT JSONEachRow`, sends
  each parameter as `param_<name>`, Array values in ClickHouse literal form) and `insert(table: str, rows:
  Sequence[Mapping]) -> None`; `ClickHouseTransient(Exception)` for connection errors, timeouts, and HTTP 5xx;
  `ClickHouseRejected(Exception)` with `.code` for HTTP 4xx; no exception message contains the password or the URL
  credentials.
- Produces (`repository.py`): `Repository(client)` with `table_ready() -> bool` (runs `SELECT 1 FROM diagnoses LIMIT 0`; true on success, false on an unknown-table
  rejection, and any other error propagates), `discover(limit: int, policy: str,
  analyzer_id: str) -> list[Candidate]` (`Candidate(incident_id: str, next_version: int)`), `load_raw(incident_id:
  str) -> RawIncidentData`, `diagnosis_exists(incident_id: str, version: int) -> bool`, and `write(row:
  DiagnosisRow) -> None`; SQL text constants `SQL_DISCOVER_NEW`, `SQL_DISCOVER_REVISE`, `SQL_INCIDENT`,
  `SQL_EVIDENCE`, `SQL_DEPLOYMENT`, `SQL_SPANS`, `SQL_LOGS`, `SQL_EXISTS`; `DiagnosisRow` dataclass with the column
  names of spec 8.1.

- [ ] **Step 1: Write `tests/test_chclient.py` (RED)** against a fake transport: parameters are sent as
  `param_<name>`; an `Array(String)` renders as `['a','b']` with quotes escaped; an HTTP 500 raises
  `ClickHouseTransient`; a socket timeout raises `ClickHouseTransient`; an HTTP 404 with a ClickHouse code raises
  `ClickHouseRejected` with that code; the password never appears in any exception text or `repr`.
- [ ] **Step 2: Write `tests/test_repository.py` (RED)** against a fake client that records calls: each SQL constant
  equals the spec's text exactly (sections 6.2, 6.3, 8.2) and contains a `LIMIT`; no statement is built by
  string formatting of a value (assert each statement has only `{name:Type}` placeholders); `discover` with
  `first-only` sends only `SQL_DISCOVER_NEW` and returns version 1; with `on-analyzer-change` it also sends
  `SQL_DISCOVER_REVISE` and returns `latest + 1`, and does not select an incident whose latest row already has the
  current analyzer even if an older row differs; `write` first sends `SQL_EXISTS` and sends no insert when the count is
  non-zero; across all tests the only statements ever sent are `SELECT`s and the one `INSERT INTO diagnoses`;
  `load_raw` follows at most three trace IDs and never sends a query containing a value from telemetry.
- [ ] **Step 3: Write `tests/test_repository_integration.py`**, skipped unless `AGENT_IT_CLICKHOUSE_URL` is set: runs
  the spec queries against the real ClickHouse (empty result is fine) to prove they parse, and proves
  `write` twice for the same key leaves `count()` (without `FINAL`) equal to 1 and the stored `document` unchanged.
- [ ] **Step 4: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_chclient tests.test_repository -v`.
  Expected RED: `ModuleNotFoundError: No module named 'signalforge_agent.chclient'`.
- [ ] **Step 5: Implement `chclient.py` and `repository.py`.** Re-run. Expected GREEN.
- [ ] **Step 6: Run the integration test** against the live stack (T6 applied):
  `node scripts/py-in-docker.mjs --network signalforge_default --env AGENT_IT_CLICKHOUSE_URL=http://clickhouse:8123
  --env AGENT_IT_USER=agent_writer --env AGENT_IT_PASSWORD=changeme-local-only python -m unittest
  tests.test_repository_integration -v`. Expected GREEN, with the one probe row it writes using a reserved fixed
  incident ID that the dashboard cannot reach (no such incident exists); record that this row stays, since
  `agent_writer` cannot delete it.

**Commit:** `feat(agent): add the bounded ClickHouse client and an idempotent diagnosis repository`

### T8. Orchestrator, retry and dead-letter behavior, health, and CLI

**Goal:** the agent loop turns published incidents into stored diagnoses and survives every failure class.

**Files:**
- Create: `src/signalforge_agent/orchestrator.py`, `provider.py` (interface and `DeterministicProvider`),
  `health.py`, `__main__.py`; `tests/test_orchestrator.py`

**Interfaces:**
- Consumes: everything in T1 to T7.
- Produces: `Provider` protocol (`name`, `model_version`, `prompt_version`, `diagnose(bundle, version, now) ->
  dict`); `DeterministicProvider`; `backoff_seconds(attempt: int) -> int` (1, 2, 4, 8, 16, then 30);
  `process_incident(candidate, deps) -> Outcome` (`Outcome` is one of `written(status)`, `skipped`, `transient(error)`);
  `run_cycle(deps) -> CycleResult`; `run(config, stop: threading.Event, deps=None) -> int`;
  `python -m signalforge_agent run` and `python -m signalforge_agent healthcheck`.

- [ ] **Step 1: Write `tests/test_orchestrator.py` (RED)** with an in-memory fake repository and a fake clock:
  - a candidate becomes a `completed` row whose document passes the validator and whose `diagnosis_id` is the
    documented value;
  - re-running the cycle writes nothing new (idempotent skip);
  - `ClickHouseTransient` on load writes nothing, reports `transient`, and the next cycle retries; the backoff
    sequence is exactly `[1, 2, 4, 8, 16, 30, 30]`;
  - a deterministic analyzer whose output the validator rejects (monkeypatched to return a fabricated citation)
    writes one `failed` row with code `validation_rejected`, an empty document, and is not retried the next cycle;
  - `BundleTooLarge` writes `failed/bundle_too_large`; a malformed incident row writes `failed/invalid_incident`;
  - an insufficient-evidence incident writes `abstained`, not `failed`;
  - under `on-analyzer-change`, a second analyzer produces version 2 and keeps version 1;
  - the stop event ends the loop after the current incident; the heartbeat file is touched on a cycle that found no
    work; `run` exits with status 3 when `table_ready` never becomes true within 120 fake seconds; and no log line
    contains a document, a bundle, or the password.
- [ ] **Step 2: Run.** `node scripts/py-in-docker.mjs python -m unittest tests.test_orchestrator -v`. Expected RED:
  `ModuleNotFoundError: No module named 'signalforge_agent.orchestrator'`.
- [ ] **Step 3: Implement** the modules per spec 6 and 8.4. Logging is one JSON object per line with `level`,
  `message`, `incident_id`, `attempt`, `error_class` only. `healthcheck` exits 0 when the heartbeat file is newer
  than `max(10, 3 × poll interval)` seconds, else 1.
- [ ] **Step 4: Re-run all agent tests.** Expected GREEN.

**Commit:** `feat(agent): run the diagnosis loop with bounded retry, dead-lettering, and revisions`

### T9. Runtime image and Compose service

**Goal:** the agent runs in Compose with no ports, no capabilities, and a read-only filesystem.

**Files:**
- Modify: `services/agent-python/Dockerfile` (add the `runtime` stage)
- Modify: `infra/docker/docker-compose.yml` (`agent-python`)
- Modify: `scripts/verify-evidence-cited-diagnosis.test.mjs` (resolved-Compose assertions)

- [ ] **Step 1: Write the failing Compose test.** Assert against `docker compose config --format json`: the
  `agent-python` service has `build.context` at the repository root with `dockerfile` `services/agent-python/Dockerfile`;
  has no `ports`; its `depends_on` contains `clickhouse` with `service_healthy` and `collector-go` with
  `service_started` and does not contain `temporal`; `read_only` is `true`; `cap_drop` is `["ALL"]`;
  `security_opt` contains `no-new-privileges:true`; `restart` is `no`; `CLICKHOUSE_USER` is `agent_writer`;
  `AGENT_PROVIDER` defaults to `deterministic`; `AGENT_PROVIDER_API_KEY` resolves to the empty string; the healthcheck
  command is `python -m signalforge_agent healthcheck`. Run `node --test scripts/verify-evidence-cited-diagnosis.test.mjs`.
  Expected RED: the current service has `image: alpine:3.20` and no `build`.
- [ ] **Step 2: Add the `runtime` stage** (pinned `PYTHON_IMAGE`, non-root user, `requirements.txt` installed,
  `src/` and `contracts/events/diagnosis.schema.json` copied, `ENTRYPOINT ["python", "-m", "signalforge_agent",
  "run"]`) and replace the placeholder service with the definition in spec section 10.
- [ ] **Step 3: Re-run the Compose test and `docker compose config --quiet`.** Expected GREEN.
- [ ] **Step 4: Smoke on the live stack.** `docker compose -f infra/docker/docker-compose.yml up -d --build
  agent-python`; then poll the health status for at most 60 seconds until `healthy`
  (`docker compose ps --format "{{.Health}}"`). Expected: healthy, and `docker compose logs agent-python` shows JSON
  lines only and no credential. Run `docker compose down` afterwards if the stack is not needed (never `-v`).

**Commit:** `feat(infra): run agent-python as a hardened Compose service`

### T10. Dashboard server: queries, reader, read-side validation, service, API

**Goal:** the API exposes the diagnosis additively, and never exposes an ungrounded one.

**Files:**
- Modify: `apps/web/src/server/queries.ts`, `clickhouse.ts`, `model.ts`, `service.ts` (+ each `.test.ts`)
- Create: `apps/web/src/server/diagnosis.ts`, `diagnosis.test.ts`
- Modify: `apps/web/app/api/api.test.ts`

**Interfaces:**
- Produces: `QUERIES.Q8`, `QUERIES.Q9` (spec 9.1) and `QueryParams` entries; reader methods
  `latestDiagnosis(incidentId: string): Promise<DiagnosisRow | null>` and
  `latestDiagnoses(incidentIds: string[]): Promise<DiagnosisSummaryRow[]>`; `parseDiagnosis(row, incidentId,
  evidenceIds): DiagnosisView` returning `{ state: 'unavailable' }` for any violation; `IncidentItem.diagnosis`
  and the detail response's `diagnosis` as in spec 9.2.

- [ ] **Step 1: Write the failing tests first.**
  - `queries.test.ts`: Q8 and Q9 equal the spec text exactly and contain only their named parameters.
  - `diagnosis.test.ts`: `contracts/events/samples/diagnosis.sample.json` parses to `state: 'completed'`; every file
    in `contracts/events/samples/invalid/diagnosis.*.json` becomes `{ state: 'unavailable' }`; a citation that is not
    among the supplied evidence IDs becomes `unavailable`; a document whose `incident_id` differs from the requested
    one becomes `unavailable`; `status: 'failed'` rows map to `state: 'failed'` with the code; an unknown failure
    code becomes `unavailable`; text is passed through unmodified (no HTML is interpreted).
  - `service.test.ts`: with no diagnosis row the detail has `diagnosis: null`; with a valid row, the document
    appears with `state`; a thrown non-unavailable error on the diagnosis query (for example an unknown-table
    rejection) yields `{ state: 'unavailable' }` while the incident, evidence, and deployment fields are unchanged;
    `ClickHouseUnavailable` still propagates as before; the list gives `diagnosis: null` or the summary.
  - `api.test.ts`: change the exact-key assertion to
    `['deployment', 'diagnosis', 'evidence', 'explanation', 'generated_at', 'incident']`, and assert that no
    pre-existing field changed and that `Content-Type` and `no-store` are still exact.
  Run `npm --prefix apps/web test`. Expected RED: the new modules and queries do not exist, and the key assertion fails
  (`'diagnosis'` missing).
- [ ] **Step 2: Implement** the queries, the reader methods, `diagnosis.ts`, and the service changes.
- [ ] **Step 3: Run** `npm --prefix apps/web test`, `npm --prefix apps/web run typecheck`, and
  `npm --prefix apps/web run build`. Expected GREEN.

**Commit:** `feat(web): serve the latest diagnosis additively and validate it on read`

### T11. Dashboard UI: diagnosis card, list column, and citation anchors

**Goal:** the screenshot-friendly page of spec section 2 renders from the API data.

**Files:**
- Create: `apps/web/src/ui/diagnosis-card.tsx`, `diagnosis-card.test.tsx`
- Modify: `apps/web/src/ui/incident-list.tsx`, `incident-list.test.tsx`
- Modify: `apps/web/app/incidents/[incidentId]/page.tsx`, `apps/web/app/globals.css`

- [ ] **Step 1: Write the failing UI tests** (static markup, as the existing UI tests do):
  - the five detail states render their fixed text (`Diagnosis pending.`, the card, `No diagnosis: insufficient
    evidence.`, `Diagnosis failed (validation_rejected).`, `The diagnosis could not be displayed.`);
  - a completed card shows the likely cause, a confidence dot plus the word, each claim with chips whose `href` is
    `#evidence-<uuid>` for a cited ID and whose `title` holds the full ID and summary;
  - the Recommendation panel contains the text `Recommendation only. Nothing was executed.` and contains no
    `<button`, no `<form`, and no `<a`;
  - hostile text such as `<img src=x onerror=alert(1)>` in a claim appears escaped and never as a tag;
  - the page's evidence table rows carry `id="evidence-<uuid>"`;
  - the list gains a **Diagnosis** column, rendering `high`, `medium`, `low`, `abstained`, `failed`,
    `unavailable`, or `pending` as a dot plus a word with no new link;
  - existing list and detail tests still pass unchanged.
  Run `npm --prefix apps/web test`. Expected RED: `Cannot find module './diagnosis-card'`.
- [ ] **Step 2: Implement** the card, the list column, the page changes, and the CSS (`:target` highlight, chip and
  panel styles in the existing graphite palette; amber for `medium`, green for `high`, neutral for the rest; never
  color alone).
- [ ] **Step 3: Run** the web test, typecheck, and build. Expected GREEN. Check the layout at 800 px in the browser as
  part of the final validation, not here.

**Commit:** `feat(web): show the evidence-cited diagnosis on the incident page and list`

### T12. Acceptance script and documentation

**Goal:** one command proves the whole slice on a running stack, with bounded waits.

**Files:**
- Create: `scripts/verify-evidence-cited-diagnosis.mjs`
- Modify: `scripts/verify-evidence-cited-diagnosis.test.mjs`, `README.md` (status sentence and a diagnosis section only),
  `.env.example` (blank provider variables with comments), `services/agent-python/README.md`

**Interfaces:**
- Produces: `STEPS` (the twelve steps of spec 12.2), `runAcceptance(context)`, `pollUntil(fn, {deadlineMs,
  intervalMs, signal})` (resolves with the first truthy value or rejects at the deadline), exported for tests.

- [ ] **Step 1: Write the failing script tests** with in-process HTTP stubs standing in for the dashboard (through a
  `DASHBOARD_BASE_URL` parameter, as the existing script does): each step fails for its specific bad input, namely a
  citation that is not in the incident's evidence (step 5), an `executable: true` (step 4), a hypothesis lacking the
  deployment ID (step 6), a page missing chip targets or containing a `<form method="post">` (step 7), a missing list
  chip (step 8), a body containing `SELECT` (step 11), and a changed deployment count (step 12). `pollUntil` is tested
  with a fake clock: it resolves when the value appears and rejects at the deadline without exceeding it, and the test
  asserts that no `setTimeout` longer than `intervalMs` is used. Run `node --test
  scripts/verify-evidence-cited-diagnosis.test.mjs`. Expected RED: `Cannot find module './verify-evidence-cited-diagnosis.mjs'`.
- [ ] **Step 2: Implement the script** per spec 12.2. Child processes (`docker compose exec`, `docker compose
  restart`) use argument arrays. Every request has a deadline; the diagnosis wait has a 60-second deadline; the
  restart wait has a 60-second deadline; the script prints `PASS <n> <name>` per step and a final `PASS`, and exits
  1 on the first failure with the step name.
- [ ] **Step 3: Write the docs.** `README.md`: the status sentence now counts the diagnosis slice, and a short
  "Evidence-cited diagnosis" section gives the stack command and the acceptance command, says the default needs no
  key, and links the spec. `.env.example`: the `AGENT_*` variables, with the provider ones blank and a comment that
  no key belongs in the repository. `services/agent-python/README.md`: purpose, layout, the validator rules, how to
  run the tests, and the provider opt-in rules. Do not rewrite unrelated documentation.
- [ ] **Step 4: Re-run the script tests and the full validation commands.** Expected GREEN.

**Commit:** `feat(scripts): add the evidence-cited diagnosis acceptance script and documentation`

### T13. Optional OpenAI-compatible provider adapter (deferrable)

**Goal:** the future LLM path exists behind the same interface and the same validator, proven only against a local fake.
This task can be skipped without affecting any other task or the acceptance script.

**Files:**
- Modify: `src/signalforge_agent/provider.py` (add `OpenAICompatibleProvider`), `orchestrator.py` (fallback wiring)
- Create: `tests/test_provider_openai.py`

**Interfaces:**
- Consumes: `Provider`, `AgentConfig`, `validator.validate`, `DeterministicProvider`.
- Produces: `OpenAICompatibleProvider(config, transport=None)` implementing `Provider` with `name =
  "openai-compatible"`, `prompt_version = "diagnose-v1"`, and `diagnose(bundle, version, now)`; one request per
  attempt to `<base>/chat/completions` with `temperature` 0 and a JSON response format.

- [ ] **Step 1: Write the failing tests** with an in-process fake HTTP server (no real network):
  - the request body contains the bundle fields of spec 8.2 and none of: `initiated_by`, `previous_version`, any raw
    attribute key, the ClickHouse password, or the provider key; the key appears only in the `Authorization` header;
  - a valid fake response passes through the validator and is stored with `provider.name` `openai-compatible`;
  - a response citing an unknown evidence ID, or exceeding the confidence ceiling, is rejected, retried once, and then
    replaced by the deterministic result with `provider.fallback_from` set to `openai-compatible`;
  - a timeout and an HTTP 500 each fall back the same way;
  - a non-JSON body falls back;
  - the key never appears in any log line or exception text, even when the fake server echoes it back;
  - `AGENT_PROVIDER=openai-compatible` with a missing key (non-local host) exits at startup with status 2 and does not
    start a loop.
  Run `node scripts/py-in-docker.mjs python -m unittest tests.test_provider_openai -v`. Expected RED:
  `ImportError: cannot import name 'OpenAICompatibleProvider'`.
- [ ] **Step 2: Implement** the adapter with `urllib.request`, the fixed `diagnose-v1` prompt built only from the
  bundle, at most two attempts, `AGENT_PROVIDER_TIMEOUT_S`, and the fallback rule of spec 8.4.
- [ ] **Step 3: Re-run all agent tests.** Expected GREEN. No test in this task or any other contacts a real host.

**Authorization note:** completing this task needs no key. Using the adapter for real is decisions D1 to D5 above.

**Commit:** `feat(agent): add an opt-in OpenAI-compatible provider behind the same validator`

## Final validation (read-only; no commit)

Run after T12, or T13 if included. Do not modify source files.

1. Regression: every command in "Validation commands", plus `python scripts/validate-schemas.py`,
   `node scripts/go-in-docker.mjs go vet ./...`, `docker compose … config --quiet`, and
   `docker compose … build --no-cache collector-go agent-python demo-orders demo-payments web`.
2. Live: start the stack with the command in spec section 10; run the demo flow (fault deployment, three orders);
   wait with bounded polling for the incident and then the diagnosis; run
   `node scripts/verify-evidence-cited-diagnosis.mjs` and `node scripts/verify-incident-dashboard.mjs` and
   `node scripts/verify-faulty-deployment-incident.mjs`, each twice, capturing real exit codes (all `0`); restore
   Payments to `0.1.0`.
3. Visual (if browser tooling exists): the three captures of spec 12.3 to a temporary location outside the repository,
   plus the page at about 800 px. Never commit screenshots.
4. Cleanup: `docker compose … down` (no `-v`); no `signalforge` containers or networks remain; no acceptance or
   browser process remains; the worktree is clean.

## Self-review

- **Spec coverage.** Contract (T2), bundle and identity (T3), analyzer and fixtures (T4), validator and adversarial
  cases (T5), table, migration, and account (T6), repository, trigger, idempotency, revisions (T7), retry,
  dead-letter, and health (T8), Compose and hardening (T9), API and read-side validation (T10), UI and screenshot
  outcome (T11), acceptance script and docs (T12), provider adapter (T13). The security section is enforced by T3
  (allowlist), T5 (`G7`, `G8`), T6 (grants), T9 (hardening), T10 (read-side checks), and T13 (key handling). Spec
  section 12.2's twelve checks map one-to-one to T12's `STEPS`.
- **Names.** `diagnosis_version`, `status`, `kind`, `remediation_recommendation`, `provider`, `input_digest`,
  `analyzer_id`, `RawIncidentData`, `EvidenceBundle`, `Candidate`, `DiagnosisRow`, and the code names `G0` through
  `G8` and the three failure codes are each defined in one task and used verbatim in later ones.
- **Placeholders.** None. The few values resolved at implementation time (the Python image digest in T1, the exact
  `requirements.txt` pins, the final sample counts in T2) each come with the exact command that produces them.
- **Test-first.** Every task names the failing command and the failure it expects before any implementation, and
  T2, T3, T4, and T10 pin the failure reason, not merely the failure.
- **Preservation.** T6 reruns the Go suite and the correlation acceptance script; T10 updates the one exact-key
  assertion deliberately and asserts nothing else changed; the final validation reruns both existing acceptance
  scripts.
- **Scope.** No Kafka consumer, no new topic, no new dashboard route, no approval or execution, no runbook retrieval,
  no scoring pipeline, no second scenario. T13 is the only optional task and is isolated.
- **Authorization.** The decisions table names every point that would need a key or external consent, and states that
  T1 to T12 need none.
