# agent-python

The incident diagnosis agent. It polls ClickHouse for published incidents that have no diagnosis, builds a small bounded
bundle from the incident's four evidence rows (plus the deployment and a few allow-listed span and log facts), asks a
provider for a typed diagnosis, validates it mechanically, and writes it to `signalforge.diagnoses`. The dashboard reads
that table and shows the result. The design is in
[docs/specs/2026-10-07-evidence-cited-diagnosis.md](../../docs/specs/2026-10-07-evidence-cited-diagnosis.md), and the
document shape is `contracts/events/diagnosis.schema.json` (version 1.1).

A diagnosis is evidence-cited, non-executable, and requires later human approval. The agent runs nothing, publishes no
port, and has no Kafka client. When the evidence is insufficient it abstains, and it records a failed row (with a fixed
failure code and no text) when it cannot produce a valid diagnosis.

## Deterministic by default

`AGENT_PROVIDER=deterministic` is the default. It applies one fixed rule (a Payments HTTP 500 burst after a deployment) to
the bundle. It needs no key, no network, and no external service, and every test and acceptance run uses it.

**No external model provider is enabled in this slice.** The configuration for an `openai-compatible` provider is parsed
and checked (see below), but its adapter is not implemented, so selecting it makes the agent exit at startup with status 2
instead of falling back silently. The adapter is the optional Task 13 of the plan. Provider settings, when they are
used, follow these constraints:

- Explicit opt-in only: `AGENT_PROVIDER=openai-compatible` together with `AGENT_PROVIDER_BASE_URL` and `AGENT_PROVIDER_MODEL`.
- The base URL must be `https`, unless its host is exactly `localhost`, `127.0.0.1`, or `host.docker.internal`.
- A non-local host also needs `AGENT_PROVIDER_API_KEY` and `AGENT_PROVIDER_ALLOW_EXTERNAL=yes`, the explicit consent that the
  bounded bundle leaves this machine.
- The key comes only from the process environment. It is never written to the repository, `docker-compose.yml`,
  `.env.example`, a log, or the database. All of these variables are blank by default.

## Layout

```
src/signalforge_agent/
  config.py          environment parsing and the provider opt-in rules
  contract.py        loads the diagnosis schema and checks a document against it
  ids.py             deterministic diagnosis, analyzer, and digest identities
  bundle.py          the bounded evidence bundle and its allowed-token set
  analyzer_rules.py  the deterministic rule that builds a diagnosis from a bundle
  grounding.py       claim verifiers over bundle facts
  validator.py       the grounding validator (G0 to G8)
  provider.py        the provider interface and the deterministic provider
  chclient.py        a minimal ClickHouse HTTP client
  repository.py      discovery queries and the idempotent diagnosis write
  orchestrator.py    the poll loop
  health.py          the heartbeat file behind the container health check
  __main__.py        `run` and `healthcheck`
tests/               unit tests, plus fixtures under tests/fixtures/
```

## Validator rules

`validator.validate(document, bundle)` raises one rejection that lists every failed rule code. It checks the schema first
(G0) and evaluates the other rules only for a schema-valid document.

| Code | Rule |
|---|---|
| `G0_schema` | The document fails the v1.1 schema. |
| `G1_unknown_evidence` | A cited ID is not evidence of this incident. |
| `G2_kind_citation_shape` | A claim does not cite the evidence types its kind requires. |
| `G3_claim_not_verified` | A claim's verifier fails against the bundle facts. |
| `G4_untraceable_token` | A UUID, trace ID, version, or number in free text is not in the bundle's allowed-token set. |
| `G5_confidence_exceeds_ceiling` | The confidence is above the ceiling computed from the bundle. |
| `G6_abstention_inconsistent` | The abstain, status, hypothesis, claims, missing-evidence, confidence, and action rules disagree. |
| `G7_recommendation_unsafe` | `executable` is not `false`, `requires_approval` is not `true`, parameters differ from the incident's, or text looks like a command. |
| `G8_text_bound` | A text field is over its bound or holds a control character, an angle bracket, `SELECT`, or `Code:`. |

## Running the tests

The tests run in Docker, so no Python is needed on the host. The wrapper builds the pinned `deps` stage of the
Dockerfile and mounts the repository read-only. From the repository root:

```bash
node scripts/py-in-docker.mjs python -m unittest discover -s tests -v
```

`test_repository_integration.py` needs the Compose ClickHouse service and is skipped unless `AGENT_IT_CLICKHOUSE_URL` is
set. The header of that file shows the command that runs it on the Compose network.

## Running the agent

The Compose service builds the `runtime` stage, runs as a non-root user with a read-only filesystem, and connects to
ClickHouse as the restricted `agent_writer` account (`SELECT` on five tables, `INSERT` on `diagnoses`). Start it with the
stack command in the root [README](../../README.md#evidence-cited-diagnosis).
