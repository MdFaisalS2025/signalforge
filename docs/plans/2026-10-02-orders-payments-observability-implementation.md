# Orders → Payments observability slice — implementation plan (revised)

Specification: [2026-10-01-orders-payments-observability-slice.md](../specs/2026-10-01-orders-payments-observability-slice.md)
(status: **Approved for implementation**, approved 2026-10-02)

This plan breaks the approved specification into ten independently
reviewable tasks. **No task in this document has been executed.** Writing or
revising this plan does not create, install, start, stage, or commit
anything — that only happens when a task is explicitly executed in a later
step (see §4 for the commit policy that applies *then*, which is
deliberately different from the policy that applies to writing this plan).

**Environment note on Python:** this repository's environment resolves
`python` to Python 3.14.2 on both the Windows PowerShell workspace and the
Bash tool (`python3` also resolves here, but `python` is the standard
Windows invocation and is what this plan uses throughout). Commands in this
plan avoid POSIX-only constructs (`&&` chaining, inline `VAR=value cmd`,
`/tmp/...`, shell backgrounding with `&`, `kill %1`, `grep`) so they run
unmodified in this Windows PowerShell workspace; where a check needs real
process control (spawn, env vars, cleanup, polling), the plan uses a Node
script instead of shell scripting, since Node behaves identically on Windows
and Unix-like systems.

## 1. Goal

Make one real HTTP request flow from `demo-orders` to `demo-payments`
observable end-to-end: a single trace with the correct 3-span parent-child
chain, explicit request/duration metrics, and application logs — all three
signal types delivered via OTLP to the already-running Collector — while
keeping both services independently unit-testable without a real network
port or any global telemetry state.

## 2. Architecture summary

```
client ──POST /orders──▶ demo-orders ──POST /payments/charge──▶ demo-payments
                              │                                       │
                              ├── OTLP traces/metrics/logs ───────────┤
                              ▼                                       ▼
                                      otel-collector (debug exporter)
```

`demo-orders` validates the request, calls `demo-payments` through an
injectable `PaymentsClient`, and maps any client failure (timeout, connection
refused, or an unexpected response) uniformly to one documented `502`
response. `demo-payments` validates and unconditionally approves — it has no
failure branch in this slice (per spec §4). Both services bootstrap
OpenTelemetry in a dedicated entry point *before* loading Fastify/axios/HTTP,
so trace context propagates automatically via `@opentelemetry/instrumentation-http`.

## 3. Technology stack (resolved in the spec, restated here for reference)

TypeScript on Node 24 (`node:24-alpine` in containers) · Fastify · axios
(for the one outbound call, behind `PaymentsClient`) · OTLP/HTTP on port 4318
for all three signals · `node:test` via `tsx` · npm with a committed
`package-lock.json` per service · no shared npm package between the two
services.

## 4. Global constraints

- No persistence beyond process memory, no Redpanda, no ClickHouse, no
  Temporal workflows, no authentication, no retry/circuit-breaker logic, no
  Go correlation service, no AI/agent behavior, no dashboard work, and no
  changes to `demo-inventory`. These stay exactly as scheduled in the project
  plan's later weeks.
- Unit tests never open a real network port and never initialize global
  OpenTelemetry state (§7.2's design, corrected in Task 6 below).
- Every export/batch interval and every poll loop uses the bounded values
  fixed in spec §8 — no fixed `sleep()` anywhere in this plan, including the
  bootstrap-order check (Task 5).
- **Commit policy while writing or revising this plan (now):** nothing is
  staged, installed, started, or committed. This document only describes
  what each task will do when it is later executed.
- **Commit policy during later execution of Tasks 1–10 (not now):** each
  task, when executed, must — in order — (a) run that task's required
  verification commands and confirm their expected outcomes; (b) stage
  *only* the files that task's file-map entry lists, by explicit path, never
  a broad `git add -A`/`git add .`; (c) review the staged diff
  (`git diff --cached`) before committing; (d) commit using that task's
  approved commit message; (e) run `git status` and confirm no file outside
  that task's file-map entry is staged or was swept into the commit before
  moving to the next task. This policy applies starting with Task 1's
  execution — it does not apply to the act of writing this plan itself.

## 5. Review focus: five most important edge cases / failure modes

1. **Instrumentation registered too late.** If any task's code change causes
   `fastify`, `axios`, or Node's `http` module to load before
   `instrument.ts` finishes registering `HttpInstrumentation`, spans stop
   being created and `traceparent` stops propagating — silently, with no
   thrown error, since the services keep working functionally. Task 5
   includes a dedicated cross-platform Node check specifically to catch this
   (§9).
2. **Payments returning something other than a clean success or a clean
   transport failure.** If `demo-payments` ever responded with an
   unexpected status or a malformed body (not modeled today, but the client
   must defend against it per spec requirement 7), a naive `PaymentsClient`
   could throw an unhandled exception (crashing the request) instead of
   mapping it to the documented `502`. Task 4 tests this explicitly against
   a disposable local HTTP server standing in for a misbehaving Payments.
3. **Health-check traffic leaking into telemetry.** `ignoreIncomingRequestHook`
   / `ignoreOutgoingRequestHook` must match the `/health` path exactly; a
   mismatch (trailing slash, method mix-up) would let health checks pollute
   trace/metric volume and could make the acceptance script's "find my
   trace" logic ambiguous. Verified in Task 5 and again in Task 9's
   acceptance run (health-check traffic already running continuously via
   Compose health checks by the time acceptance tests run).
4. **Treating a 1-second export interval as a guarantee rather than a
   target.** Batch processors export on a timer, not synchronously on
   request completion; any check written against a fixed sleep shorter than
   one export cycle would flake. Every wait in this plan — the bootstrap
   check (Task 5) and the acceptance script (Task 9) — uses the bounded
   `pollUntil` pattern from spec §8, never a fixed sleep.
5. **A unit test that appears to exercise real OpenTelemetry context
   propagation without actually registering a context manager.** The
   original draft of this plan made exactly this mistake (constructing a
   `NodeTracerProvider` locally and assuming `context.with()`/
   `trace.getActiveSpan()` would work without `.register()` — they do not,
   because the OpenTelemetry API needs an active, globally registered
   context manager to track "the active span" at all). Task 6 corrects this
   by testing a pure formatting function instead, and moving all
   active-context verification to Task 5's real, isolated child-process
   check.

## 6. File map

Every file this plan creates or modifies, with one responsibility each.

| File | Responsibility | Task |
|---|---|---|
| *(baseline — no new files; see Task 1)* | Confirms and commits what already exists (Week 1 scaffold, approved spec, this plan) | 1 |
| `services/demo-orders/package.json` | Declares deps/devDeps/scripts for demo-orders | 2 |
| `services/demo-orders/package-lock.json` | Locked, reproducible dependency tree (committed) | 2 (created), updated in 3/4/5 as deps are added |
| `services/demo-orders/tsconfig.json` | TS compiler config (`src` → `dist`) | 2 |
| `services/demo-orders/.dockerignore` | Excludes `node_modules`, `dist`, `test` from build context | 2 |
| `services/demo-orders/src/validation.ts` | `isValidUuid`, `validateOrderRequest` — pure input validation, no I/O | 4 |
| `services/demo-orders/src/paymentsClient.ts` | `PaymentsClient` interface + `createAxiosPaymentsClient()` | 4 |
| `services/demo-orders/src/server.ts` | `buildServer(deps)` — Fastify app construction only, no `listen()` | 4 |
| `services/demo-orders/src/metrics.ts` | `recordHttpRequest()` — explicit counter/histogram | 5 |
| `services/demo-orders/src/instrument.ts` | OTel provider/exporter construction + HTTP instrumentation registration | 5 |
| `services/demo-orders/src/main.ts` | Process entry point; static-imports `instrument.ts` first, then dynamically imports `server.ts` | 5 |
| `services/demo-orders/src/logger.ts` | `formatLogLine()` (pure) + `logEvent()` (OTLP emission + enriched stdout) | 6 |
| `services/demo-orders/test/validation.test.ts` | Unit tests for every input-validation rule | 4 |
| `services/demo-orders/test/paymentsClient.test.ts` | Unit tests for `createAxiosPaymentsClient` against a disposable local HTTP server, including malformed/unexpected responses | 4 |
| `services/demo-orders/test/server.test.ts` | Unit tests for `/orders` and `/health` via `app.inject()` with a stub `PaymentsClient` | 4 |
| `services/demo-orders/test/logger.test.ts` | Unit tests for `formatLogLine()` only — explicit fake `SpanContextLike` values, no OTel API calls | 6 |
| `services/demo-orders/Dockerfile` | Multi-stage build; runtime `CMD ["node","dist/main.js"]` | 7 |
| `services/demo-payments/package.json` | Declares deps/devDeps/scripts for demo-payments | 2 |
| `services/demo-payments/package-lock.json` | Locked, reproducible dependency tree (committed) | 2 (created), updated in 3/5/6 |
| `services/demo-payments/tsconfig.json` | TS compiler config | 2 |
| `services/demo-payments/.dockerignore` | Same exclusions as demo-orders | 2 |
| `services/demo-payments/src/validation.ts` | `isValidUuid`, `validateChargeRequest` | 3 |
| `services/demo-payments/src/server.ts` | `buildServer()` — Fastify app construction, no dependencies to inject | 3 |
| `services/demo-payments/src/metrics.ts` | `recordHttpRequest()` (same shape as demo-orders' copy) | 5 |
| `services/demo-payments/src/instrument.ts` | Same role as demo-orders' copy | 5 |
| `services/demo-payments/src/main.ts` | Same role as demo-orders' copy | 5 |
| `services/demo-payments/src/logger.ts` | Same role as demo-orders' copy | 6 |
| `services/demo-payments/test/validation.test.ts` | Unit tests for every input-validation rule | 3 |
| `services/demo-payments/test/server.test.ts` | Unit tests for `/payments/charge` and `/health` via `app.inject()` | 3 |
| `services/demo-payments/test/logger.test.ts` | Same technique as demo-orders' copy (pure `formatLogLine()` only) | 6 |
| `services/demo-payments/Dockerfile` | Multi-stage build; runtime `CMD ["node","dist/main.js"]` | 7 |
| `infra/docker/docker-compose.yml` | Replace the two placeholder containers with real builds, ports, env, health checks | 7 |
| `.env.example` | Add the five new variables from spec §9 | 5, 7 |
| `observability/otel-collector/config.yaml` | `debug` exporter `verbosity: basic` → `detailed` | 8 |
| `scripts/verify-bootstrap-order.mjs` | Cross-platform (Node `child_process`) check that `demo-orders`' instrumentation registers before Fastify/axios/`http` load; fails if a live stdout log line is missing a non-empty `trace_id`/`span_id` | 5 |
| `scripts/verify-orders-payments-slice.mjs` | `pollUntil` + the two acceptance scenarios + failure diagnostics | 9 |
| `README.md` | Replace "placeholder containers" quick-start language with real run/test/verify instructions | 10 |
| `docs/decisions/0003-orders-payments-stack.md` | ADR recording the §3 technology choices | 2 |

## 7. Shared interfaces and types

Defined once here; every task below references these names and signatures —
no task introduces a conflicting name or shape for the same concept.

```ts
// --- HTTP contract (spec §4) ---
interface OrderRequestBody { order_id: string; item: string; amount_cents: number }
interface OrderSuccessResponse { order_id: string; status: 'created'; payment_status: 'approved' }
interface OrderFailureResponse { order_id: string; status: 'failed'; reason: 'payment_unavailable' }
interface ChargeRequestBody { order_id: string; amount_cents: number }
interface ChargeResponse { order_id: string; payment_status: 'approved' }
interface HealthResponse { status: 'ok' }
interface ValidationErrorResponse { error: 'invalid_request'; message: string }

// --- Validation (services/*/src/validation.ts) ---
type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };
function isValidUuid(value: unknown): value is string;
function validateChargeRequest(body: unknown): ValidationResult<ChargeRequestBody>;      // demo-payments
function validateOrderRequest(body: unknown): ValidationResult<OrderRequestBody>;        // demo-orders

// --- Payments client (services/demo-orders/src/paymentsClient.ts) ---
interface PaymentsClient {
  charge(orderId: string, amountCents: number): Promise<{ paymentStatus: 'approved' }>;
}
function createAxiosPaymentsClient(baseUrl: string, timeoutMs: number): PaymentsClient;
class PaymentsClientError extends Error {}   // thrown for timeout, connection failure, or an unexpected response shape/status

// --- Server construction (services/*/src/server.ts) ---
function buildServer(deps: { paymentsClient: PaymentsClient }): FastifyInstance;  // demo-orders
function buildServer(): FastifyInstance;                                          // demo-payments

// --- Logging (services/*/src/logger.ts) ---
type LogSeverity = 'info' | 'warn' | 'error';
interface SpanContextLike { traceId: string; spanId: string }
function formatLogLine(
  severity: LogSeverity,
  message: string,
  attributes: Record<string, string | number | boolean>,
  spanContext?: SpanContextLike
): string;   // pure — no OTel API calls, fully unit-testable in isolation
function logEvent(severity: LogSeverity, message: string, attributes: Record<string, string | number | boolean>): void;
  // reads trace.getActiveSpan()?.spanContext(), passes it to formatLogLine() for the
  // stdout line, and separately emits an OTel LogRecord for OTLP delivery

// --- Metrics (services/*/src/metrics.ts) ---
function recordHttpRequest(route: string, method: string, statusCode: number, durationSeconds: number): void;
```

Validation error responses use HTTP `400` uniformly and the exact shape
`ValidationErrorResponse` above. Malformed JSON that Fastify's body parser
itself cannot parse is **not** given a custom shape — it is left as Fastify's
own default `400` error body, stated explicitly so no task tries to
special-case it.

### 7.1 Exact input-validation rules (spec requirement 7)

| Condition | Service(s) | HTTP status | Response |
|---|---|---|---|
| Body is not valid JSON | both | `400` | Fastify's default error body (unchanged) |
| `order_id` missing or not a string | both | `400` | `{ error: 'invalid_request', message: 'order_id is required' }` |
| `order_id` present but not a valid UUID shape (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) | both | `400` | `{ error: 'invalid_request', message: 'order_id must be a valid UUID' }` |
| `item` missing or not a string | demo-orders | `400` | `{ error: 'invalid_request', message: 'item is required' }` |
| `item` is an empty or whitespace-only string | demo-orders | `400` | `{ error: 'invalid_request', message: 'item must not be empty' }` |
| `amount_cents` missing | both | `400` | `{ error: 'invalid_request', message: 'amount_cents is required' }` |
| `amount_cents` not an integer, or ≤ 0 | both | `400` | `{ error: 'invalid_request', message: 'amount_cents must be a positive integer' }` |
| Payments call throws `PaymentsClientError` (timeout, connection failure, or unexpected response) | demo-orders | `502` | `OrderFailureResponse` (spec §4) — one unified mapping, regardless of which of the three causes it |

## 8. Task breakdown

Ten tasks, in execution order. Each depends only on tasks listed before it.

---

### Task 1 — Establish repository baseline

**Depends on:** nothing. **Implements:** repository-hygiene continuity from
the prior turns in this session; creates no new files itself.

**Files:** none created. This task only reviews and commits what already
exists.

1. Review the currently staged and untracked state:
   ```
   git status
   git diff --cached --name-status
   ```
   Confirm the staged set matches the Week 1 scaffold established earlier
   this session (README, `.gitignore`, `.gitattributes`, `infra/docker/`,
   `contracts/events/`, `observability/`, `docs/decisions/0001`/`0002`,
   `evals/`, `runbooks/`, the per-service placeholder READMEs,
   `SignalForge_Project_Plan.docx`), and that `docs/specs/` and `docs/plans/`
   are present but untracked.
2. Confirm the two pre-existing derived artifacts remain ignored and absent
   from the index:
   ```
   git check-ignore -v SignalForge_Project_Plan_QA.pdf signalforge_render/page-01.png
   git status --porcelain=v1
   ```
   **Expected result:** `check-ignore` prints a match for both paths against
   the `.gitignore` rules added earlier; neither path appears in `git
   status`'s output at all (ignored files are hidden by default).
3. Run schema validation:
   ```
   python scripts/validate-schemas.py
   ```
   **Expected result:** all 5 sample events still validate.
4. Run Compose configuration validation:
   ```
   docker compose -f infra/docker/docker-compose.yml config
   ```
   **Expected result:** exit code `0`, resolved config printed with no error.
5. Stage the approved specification, this implementation plan, and the
   existing Week 1 scaffold together, by explicit path (not `-A`/`.`):
   ```
   git add README.md .gitignore .gitattributes .env.example
   git add infra/docker/docker-compose.yml
   git add contracts/events
   git add observability
   git add docs/decisions/0001-record-architecture-decisions.md docs/decisions/0002-monorepo-and-language-split.md
   git add docs/architecture/.gitkeep docs/demo/.gitkeep
   git add evals runbooks
   git add services/agent-python/README.md services/api/README.md services/collector-go/README.md
   git add services/demo-inventory/README.md services/demo-orders/README.md services/demo-payments/README.md
   git add services/remediation/README.md workflows/temporal/README.md
   git add contracts/api/README.md .github/workflows/README.md infra/helm/README.md infra/kubernetes/README.md infra/terraform/README.md
   git add SignalForge_Project_Plan.docx
   git add docs/specs/2026-10-01-orders-payments-observability-slice.md
   git add docs/plans/2026-10-02-orders-payments-observability-implementation.md
   ```
6. Review the complete staged diff and file list before committing:
   ```
   git status
   git diff --cached --stat
   ```
   Confirm nothing unexpected is present (no `node_modules`, no `.env`, no
   `SignalForge_Project_Plan_QA.pdf`, no `signalforge_render/*`).
7. Commit:
   ```
   git commit -m "chore: establish SignalForge foundation"
   ```
8. Confirm a clean result: `git status` shows a clean working tree aside
   from the still-untracked, still-ignored QA PDF and render PNGs (which stay
   on disk, untracked, per the earlier-approved hygiene decision).

**Baseline commit:** `chore: establish SignalForge foundation` — the Week 1
scaffold, the approved spec, and this plan, as one commit. No service code
exists yet; Task 2 is the first task to create any.

---

### Task 2 — Scaffold demo-orders/demo-payments packages and ADR

**Depends on:** Task 1. **Implements:** spec §3 (package layout, lockfiles).

**Files:** `services/demo-orders/{package.json,tsconfig.json,.dockerignore}`,
`services/demo-payments/{package.json,tsconfig.json,.dockerignore}`,
`docs/decisions/0003-orders-payments-stack.md`.

1. Create `services/demo-orders/package.json`:
   ```json
   {
     "name": "demo-orders",
     "version": "0.1.0",
     "private": true,
     "type": "module",
     "scripts": {
       "build": "tsc",
       "start": "node dist/main.js",
       "dev": "tsx src/main.ts",
       "test": "tsx --test test/**/*.test.ts",
       "typecheck": "tsc --noEmit"
     }
   }
   ```
2. Create `services/demo-orders/tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "outDir": "dist",
       "rootDir": "src",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true
     },
     "include": ["src"]
   }
   ```
3. Create `services/demo-orders/.dockerignore`:
   ```
   node_modules
   dist
   test
   *.md
   .env
   ```
4. Repeat steps 1–3 for `services/demo-payments` (name field
   `"demo-payments"`, identical `tsconfig.json`, identical `.dockerignore`).
5. Write `docs/decisions/0003-orders-payments-stack.md`: an ADR recording
   TypeScript/Node over Go for the demo services, Fastify over Express, axios
   over `fetch` (citing the `instrumentation-http` vs.
   `instrumentation-undici` reasoning from spec §3), OTLP/HTTP over gRPC, no
   shared npm package, and the `instrument.ts`/`main.ts` bootstrap split —
   each with the "why" already established in the spec, cited by section.
6. Verification: no build/test is possible yet (no `src/` exists). Confirm
   both `package.json` files parse as valid JSON:
   ```
   node -e "JSON.parse(require('node:fs').readFileSync('services/demo-orders/package.json','utf8')); console.log('OK')"
   node -e "JSON.parse(require('node:fs').readFileSync('services/demo-payments/package.json','utf8')); console.log('OK')"
   ```
7. Stage only this task's files, review the diff, and commit:
   ```
   git add services/demo-orders/package.json services/demo-orders/tsconfig.json services/demo-orders/.dockerignore
   git add services/demo-payments/package.json services/demo-payments/tsconfig.json services/demo-payments/.dockerignore
   git add docs/decisions/0003-orders-payments-stack.md
   git diff --cached --stat
   git commit -m "chore: scaffold demo-orders/demo-payments packages and record stack ADR"
   git status
   ```

---

### Task 3 — Payments service behavior (TDD)

**Depends on:** Task 2. **Implements:** spec §4 (contract minus the removed 503), §7.1 input-validation table.

**Files:** `services/demo-payments/src/{validation.ts,server.ts}`,
`services/demo-payments/test/{validation.test.ts,server.test.ts}`.

1. Install dependencies (run from the repository root; each command on its
   own line, not chained with `&&`):
   ```
   cd services/demo-payments
   npm install fastify
   npm install -D typescript tsx @types/node
   cd ../..
   ```
2. **Red:** write `test/validation.test.ts` with cases for: a valid charge
   request; missing `order_id`; a malformed `order_id`; missing
   `amount_cents`; a non-integer `amount_cents`; a non-positive
   `amount_cents` — each asserting the exact `ValidationResult` shape from
   §7.1. Run:
   ```
   cd services/demo-payments
   npx tsx --test test/validation.test.ts
   ```
   **Expected failure:** `Cannot find module '../src/validation.js'` (file
   does not exist yet).
3. **Green:** implement `src/validation.ts` with `isValidUuid` and
   `validateChargeRequest` per §7.1's table. Re-run the same command.
   **Expected result:** every case in step 2 passes, with no case skipped.
4. **Red:** write `test/server.test.ts` with cases for: `POST
   /payments/charge` with a valid body → `200` and the approved response
   shape; an invalid body → `400` with the documented validation error; `GET
   /health` → `200 { status: 'ok' }`. Run:
   ```
   npx tsx --test test/server.test.ts
   ```
   **Expected failure:** `Cannot find module '../src/server.js'`.
5. **Green:** implement `src/server.ts` exporting
   `buildServer(): FastifyInstance` with the two routes, using
   `validateChargeRequest`. Re-run. **Expected result:** every case in
   step 4 passes.
6. **Regression:** `npm test` (runs both test files). **Expected result:**
   all tests pass, with no case from steps 2 or 4 missing from the run —
   named critical cases to confirm by name in the output: the malformed-
   `order_id` case, the non-positive-`amount_cents` case, and the `/health`
   case.
   ```
   npx tsc --noEmit
   ```
   **Expected result:** zero type errors.
7. Stage, review, commit:
   ```
   cd ../..
   git add services/demo-payments/src/validation.ts services/demo-payments/src/server.ts
   git add services/demo-payments/test/validation.test.ts services/demo-payments/test/server.test.ts
   git add services/demo-payments/package.json services/demo-payments/package-lock.json
   git diff --cached --stat
   git commit -m "feat(demo-payments): implement /payments/charge and /health with input validation"
   git status
   ```

---

### Task 4 — Orders service and injectable Payments client (TDD)

**Depends on:** Task 3 (reuses the validation *pattern*, not its code — no
shared package, per spec §3). **Implements:** spec §4, §7.1, §7.2, §10.

**Files:** `services/demo-orders/src/{validation.ts,paymentsClient.ts,server.ts}`,
`services/demo-orders/test/{validation.test.ts,paymentsClient.test.ts,server.test.ts}`.

1. ```
   cd services/demo-orders
   npm install fastify axios
   npm install -D typescript tsx @types/node
   cd ../..
   ```
2. **Red → Green:** `test/validation.test.ts` / `src/validation.ts` for
   `validateOrderRequest`, same cycle as Task 3 steps 2–3, plus the two
   demo-orders-only rules (`item` missing, `item` empty/whitespace) from
   §7.1. Run `npx tsx --test test/validation.test.ts` before (fails: module
   not found) and after (passes: every shared-shape rule plus both `item`
   rules, with the empty-`item` case specifically confirmed by name).
3. **Red:** write `test/paymentsClient.test.ts` — spins up a disposable
   local HTTP server (`node:http`, `listen(0)` for an ephemeral port)
   standing in for a misbehaving Payments, to test the real axios-based
   client without touching `demo-payments`. Cases: a clean `200` response
   resolves with `{ paymentStatus: 'approved' }`; a non-`2xx` response
   throws `PaymentsClientError`; a `200` with a malformed body throws
   `PaymentsClientError`; a connection refusal (request to an unused local
   port) throws `PaymentsClientError`. Each stub server is closed in the
   test itself once its assertion completes. Run:
   ```
   npx tsx --test test/paymentsClient.test.ts
   ```
   **Expected failure:** `Cannot find module '../src/paymentsClient.js'`.
4. **Green:** implement `src/paymentsClient.ts` — `createAxiosPaymentsClient`
   makes the POST, validates `response.status === 200` and that the body
   matches `{ order_id: string, payment_status: 'approved' }`, and wraps any
   axios error (timeout, connection refused) or validation failure in
   `PaymentsClientError`. Re-run. **Expected result:** all four cases in
   step 3 pass.
5. **Red:** write `test/server.test.ts` using a hand-written stub
   implementing `PaymentsClient` (no axios, no real port) — one stub that
   resolves to approved, one that rejects. Cases: `POST /orders` succeeds
   (`201`) when Payments approves; `POST /orders` returns `502` with the
   documented failure body when Payments fails; `POST /orders` returns
   `400` on an invalid body; `GET /health` returns `200`. Run:
   ```
   npx tsx --test test/server.test.ts
   ```
   **Expected failure:** `Cannot find module '../src/server.js'`.
6. **Green:** implement `src/server.ts` exporting
   `buildServer(deps: { paymentsClient: PaymentsClient }): FastifyInstance`.
   Re-run. **Expected result:** all four cases in step 5 pass.
7. **Regression:** `npm test` (all three files). **Expected result:** every
   test across all three files passes — named critical cases to confirm by
   name: the malformed-Payments-response case, the connection-refusal case,
   and the `502` failure-mapping case.
   ```
   npx tsc --noEmit
   ```
   **Expected result:** zero type errors.
8. Stage, review, commit:
   ```
   cd ../..
   git add services/demo-orders/src/validation.ts services/demo-orders/src/paymentsClient.ts services/demo-orders/src/server.ts
   git add services/demo-orders/test/validation.test.ts services/demo-orders/test/paymentsClient.test.ts services/demo-orders/test/server.test.ts
   git add services/demo-orders/package.json services/demo-orders/package-lock.json
   git diff --cached --stat
   git commit -m "feat(demo-orders): implement /orders with injectable PaymentsClient and axios-backed implementation"
   git status
   ```

---

### Task 5 — OpenTelemetry bootstrap (traces, metrics, logs) with cross-platform ordering verification

**Depends on:** Tasks 3, 4. **Implements:** spec §6.1, §6.2, §7.1, §8, §9 (OTLP endpoint vars), requirement 8 (ordering safety, now cross-platform per this revision).

**Files (both services):** `src/instrument.ts`, `src/main.ts`, `src/metrics.ts`;
edit `src/server.ts` to call `recordHttpRequest`; `.env.example`;
`scripts/verify-bootstrap-order.mjs` (new, top-level, not per-service).

1. In each service directory:
   ```
   npm install @opentelemetry/api @opentelemetry/api-logs @opentelemetry/sdk-trace-node @opentelemetry/sdk-metrics @opentelemetry/sdk-logs @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/exporter-logs-otlp-http @opentelemetry/instrumentation @opentelemetry/instrumentation-http @opentelemetry/resources @opentelemetry/semantic-conventions
   ```
2. Implement `src/metrics.ts` (both services, identical shape):
   ```ts
   import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
   import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

   let meterProvider: MeterProvider | undefined;
   export function initMetrics(endpoint: string): void {
     const exporter = new OTLPMetricExporter({ url: endpoint });
     meterProvider = new MeterProvider({
       readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 1000 })],
     });
   }
   export function recordHttpRequest(route: string, method: string, statusCode: number, durationSeconds: number): void {
     if (!meterProvider) return; // safe no-op if telemetry was never initialized (e.g. in a unit test)
     const meter = meterProvider.getMeter('demo');
     meter.createCounter('http_requests_total').add(1, { route, method, status_code: statusCode });
     meter.createHistogram('http_request_duration_seconds').record(durationSeconds, { route, method, status_code: statusCode });
   }
   ```
3. Implement `src/instrument.ts` (both services): construct a `Resource`
   with `service.name` from `OTEL_SERVICE_NAME`; construct `NodeTracerProvider`
   with a `BatchSpanProcessor({ scheduledDelayMillis: 1000 })` wrapping
   `OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT })`
   and call `.register()`; construct `LoggerProvider` with a
   `BatchLogRecordProcessor({ scheduledDelayMillis: 1000 })` wrapping
   `OTLPLogExporter({ url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT })` and
   call `logs.setGlobalLoggerProvider(loggerProvider)`; call
   `initMetrics(process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT!)`; call
   `registerInstrumentations({ instrumentations: [new HttpInstrumentation({
   ignoreIncomingRequestHook: (req) => req.url === '/health', ignoreOutgoingRequestHook: (req) => req.path === '/health' })] })`.
4. Implement `src/main.ts` exactly per spec §7.1 — `import './instrument.js'`
   as the first line, then `async function start()` dynamically importing
   `./server.js` (and, for demo-orders, `./paymentsClient.js`), building the
   app, and calling `app.listen({ port: Number(process.env.PORT), host: '0.0.0.0' })`.
5. Edit `src/server.ts` in both services: inside each route handler, after
   computing the response, call `recordHttpRequest(route, method, statusCode, durationSeconds)`
   (duration measured via `process.hrtime.bigint()` at handler entry/exit).
6. Add the five new variables to `.env.example` (spec §9):
   ```
   PAYMENTS_URL=http://demo-payments:8082
   PAYMENTS_TIMEOUT_MS=3000
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://otel-collector:4318/v1/traces
   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://otel-collector:4318/v1/metrics
   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://otel-collector:4318/v1/logs
   ```
   The existing `OTEL_EXPORTER_OTLP_ENDPOINT` is left untouched and unread by
   this code (spec §9).
7. **Cross-platform bootstrap-order verification.** Implement
   `scripts/verify-bootstrap-order.mjs` — a Node script using
   `child_process.spawn` (not shell scripting), so it runs identically on
   Windows and Unix-like systems:

   ```js
   import { spawn } from 'node:child_process';
   import { randomUUID } from 'node:crypto';
   import http from 'node:http';

   function startStubPaymentsServer() {
     return new Promise((resolve) => {
       const server = http.createServer((req, res) => {
         let body = '';
         req.on('data', (chunk) => { body += chunk; });
         req.on('end', () => {
           const { order_id } = JSON.parse(body);
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ order_id, payment_status: 'approved' }));
         });
       });
       server.listen(0, '127.0.0.1', () => {
         const { port } = server.address();
         resolve({ server, url: `http://127.0.0.1:${port}` });
       });
     });
   }

   async function pollUntil(check, { intervalMs = 200, timeoutMs = 10000, what = 'condition' } = {}) {
     const deadline = Date.now() + timeoutMs;
     while (Date.now() < deadline) {
       const result = await check();
       if (result) return result;
       await new Promise((r) => setTimeout(r, intervalMs));
     }
     throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
   }

   async function main() {
     const stubPayments = await startStubPaymentsServer();
     let ordersProcess;
     let stdoutBuffer = '';
     let stderrBuffer = '';

     try {
       ordersProcess = spawn('node', ['dist/main.js'], {
         cwd: 'services/demo-orders',
         env: {
           ...process.env,
           PORT: '8081',
           OTEL_SERVICE_NAME: 'demo-orders',
           PAYMENTS_URL: stubPayments.url,
           PAYMENTS_TIMEOUT_MS: '3000',
           OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
           OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4318/v1/metrics',
           OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
         },
       });
       ordersProcess.stdout.on('data', (d) => { stdoutBuffer += d.toString(); });
       ordersProcess.stderr.on('data', (d) => { stderrBuffer += d.toString(); });

       await pollUntil(async () => {
         try { return (await fetch('http://127.0.0.1:8081/health')).ok; }
         catch { return false; }
       }, { what: 'demo-orders /health to respond' });

       const orderId = randomUUID();
       const res = await fetch('http://127.0.0.1:8081/orders', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ order_id: orderId, item: 'widget', amount_cents: 500 }),
       });
       if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}`);

       const logLine = await pollUntil(() => {
         const line = stdoutBuffer.split('\n').find((l) => l.includes(orderId));
         return line ?? false;
       }, { what: 'stdout log line containing the test order_id' });

       const parsed = JSON.parse(logLine);
       if (!parsed.trace_id || !parsed.span_id) {
         throw new Error(`Expected non-empty trace_id/span_id, got: ${logLine}`);
       }
       console.log('PASS: bootstrap order is correct — trace_id and span_id present on stdout');
     } catch (err) {
       console.error('FAIL:', err.message);
       console.error('--- demo-orders stdout ---\n' + stdoutBuffer);
       console.error('--- demo-orders stderr ---\n' + stderrBuffer);
       process.exitCode = 1;
     } finally {
       if (ordersProcess) ordersProcess.kill();
       stubPayments.server.close();
     }
   }

   main();
   ```

   This satisfies every element of requirement 4: `child_process.spawn`,
   environment variables supplied through the `env` option (never shell
   `VAR=value` syntax), `crypto.randomUUID()` instead of a hardcoded
   pseudo-UUID, a self-started disposable stub Payments server, a
   self-started compiled Orders process, bounded polling (health-check poll,
   then log-line poll — no fixed sleep anywhere), a verification that stdout
   contains non-empty `trace_id` and `span_id`, `finally`-block cleanup of
   both the child process and the stub server, and failure diagnostics
   (captured stdout/stderr printed on any thrown error). No Collector needs
   to be listening on `127.0.0.1:4318` — a failed OTLP export attempt logs a
   warning internally but does not prevent `instrument.ts` from creating the
   span or attaching its ID to the stdout line, which is the only property
   this check verifies.
8. Run it:
   ```
   cd services/demo-orders
   npm run build
   cd ../..
   node scripts/verify-bootstrap-order.mjs
   ```
   **Expected result:** `PASS: bootstrap order is correct — trace_id and
   span_id present on stdout`, exit code `0`. **If this fails,** the import
   ordering in `main.ts` is broken (e.g. `server.ts` imported statically
   above `instrument.ts`) and must be fixed before continuing — this is
   exactly the scenario review-focus item 1 (§5) describes.
9. **Regression:** re-run `npm test` in both services. **Expected result:**
   the same passing tests as Tasks 3/4 (telemetry code is additive; no
   existing test imports `instrument.ts`, so none of them initialize the
   SDK — confirm by checking the test run's output contains no OTLP exporter
   log lines).
10. Stage, review, commit:
    ```
    git add services/demo-orders/src/instrument.ts services/demo-orders/src/main.ts services/demo-orders/src/metrics.ts services/demo-orders/src/server.ts
    git add services/demo-payments/src/instrument.ts services/demo-payments/src/main.ts services/demo-payments/src/metrics.ts services/demo-payments/src/server.ts
    git add services/demo-orders/package.json services/demo-orders/package-lock.json
    git add services/demo-payments/package.json services/demo-payments/package-lock.json
    git add .env.example scripts/verify-bootstrap-order.mjs
    git diff --cached --stat
    git commit -m "feat: add OpenTelemetry bootstrap (traces, metrics, logs) with import-order-safe entry point"
    git status
    ```

---

### Task 6 — Structured stdout correlation fields

**Depends on:** Task 5. **Implements:** spec §6.3, corrected per this
revision's point 5 (§5 item 5 above).

**Files (both services):** `src/logger.ts`, `test/logger.test.ts`; edit
`src/server.ts` to call `logEvent` instead of any placeholder logging.

1. **Red:** write `test/logger.test.ts` testing **only the pure
   `formatLogLine()` function** — no OTel API calls, no provider of any
   kind, so this test cannot leak state into any other test file because it
   never touches global telemetry state in the first place:
   ```ts
   import { test } from 'node:test';
   import assert from 'node:assert/strict';
   import { formatLogLine } from '../src/logger.js';

   test('formatLogLine includes trace_id/span_id when a SpanContextLike is supplied', () => {
     const line = formatLogLine('info', 'test message', { order_id: 'abc-123' }, { traceId: 'trace-abc', spanId: 'span-def' });
     const parsed = JSON.parse(line);
     assert.equal(parsed.trace_id, 'trace-abc');
     assert.equal(parsed.span_id, 'span-def');
     assert.equal(parsed.order_id, 'abc-123');
     assert.equal(parsed.level, 'info');
   });

   test('formatLogLine omits trace_id/span_id when no span context is supplied', () => {
     const line = formatLogLine('info', 'no span here', { order_id: 'xyz' });
     const parsed = JSON.parse(line);
     assert.equal('trace_id' in parsed, false);
     assert.equal('span_id' in parsed, false);
     assert.equal(parsed.order_id, 'xyz');
   });
   ```
   Run: `npx tsx --test test/logger.test.ts`. **Expected failure:** `Cannot
   find module '../src/logger.js'`.
2. **Green:** implement `src/logger.ts`:
   ```ts
   import { trace } from '@opentelemetry/api';
   import { logs, SeverityNumber } from '@opentelemetry/api-logs';

   export interface SpanContextLike { traceId: string; spanId: string }

   export function formatLogLine(
     severity: 'info' | 'warn' | 'error',
     message: string,
     attributes: Record<string, string | number | boolean>,
     spanContext?: SpanContextLike,
   ): string {
     const correlation = spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
     return JSON.stringify({ level: severity, message, timestamp: new Date().toISOString(), ...attributes, ...correlation });
   }

   const severityNumberFor = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };

   export function logEvent(
     severity: 'info' | 'warn' | 'error',
     message: string,
     attributes: Record<string, string | number | boolean>,
   ): void {
     const spanContext = trace.getActiveSpan()?.spanContext();
     logs.getLogger('demo').emit({ severityNumber: severityNumberFor[severity], body: message, attributes });
     console.log(formatLogLine(severity, message, attributes, spanContext));
   }
   ```
   Re-run. **Expected result:** both cases in step 1 pass.
3. Edit `src/server.ts` in both services: call `logEvent('info', 'request
   received', { order_id })` at handler entry, and `logEvent('info',
   'request completed', { order_id, status_code })` or `logEvent('error',
   'payment failed', { order_id, status_code: 502 })` at handler exit,
   matching spec §6.3's "minimum log events per request."
4. **Real active-context enrichment is deliberately not unit-tested here.**
   It is verified by Task 5's `scripts/verify-bootstrap-order.mjs`, which
   spawns the real compiled process with `instrument.ts` actually registered
   and asserts the live stdout line contains a non-empty `trace_id`/
   `span_id` — that is the one place in this plan where real OpenTelemetry
   context propagation is exercised end-to-end. **OTLP delivery of the log
   record is deliberately not unit-tested either** — it is verified by Task
   9's acceptance script against the real Collector. This task's own tests
   cover only the pure formatting logic.
5. **Regression:** `npm test` in both services — expect all prior passing
   tests plus the two new `formatLogLine` cases, with no test newly failing.
   `npx tsc --noEmit` — zero errors.
6. Stage, review, commit:
   ```
   git add services/demo-orders/src/logger.ts services/demo-orders/test/logger.test.ts services/demo-orders/src/server.ts
   git add services/demo-payments/src/logger.ts services/demo-payments/test/logger.test.ts services/demo-payments/src/server.ts
   git diff --cached --stat
   git commit -m "feat: correlate stdout logs with active trace/span context via logEvent"
   git status
   ```

---

### Task 7 — Dockerfiles and Compose integration

**Depends on:** Task 6. **Implements:** spec §3 (container image), §9.

**Files:** both services' `Dockerfile`; `infra/docker/docker-compose.yml`.

1. Write `services/demo-orders/Dockerfile`:
   ```dockerfile
   FROM node:24-alpine AS builder
   WORKDIR /app
   COPY package.json package-lock.json ./
   RUN npm ci
   COPY tsconfig.json ./
   COPY src ./src
   RUN npm run build

   FROM node:24-alpine AS runtime
   WORKDIR /app
   ENV NODE_ENV=production
   COPY package.json package-lock.json ./
   RUN npm ci --omit=dev
   COPY --from=builder /app/dist ./dist
   EXPOSE 8081
   CMD ["node", "dist/main.js"]
   ```
   Write the equivalent for `services/demo-payments` (port 8082). These run
   inside Linux containers regardless of host OS, so no Windows/Unix
   distinction applies inside the Dockerfile itself.
2. Edit `infra/docker/docker-compose.yml`: replace the `demo-orders` and
   `demo-payments` placeholder entries (`image: alpine:3.20`,
   `command: ["sleep","infinity"]`) with real `build:` contexts, the ports/
   env from spec §9, and a `healthcheck:` block using Node's built-in global
   `fetch` via `node -e` (no `curl`/`wget` dependency in the Alpine image):
   ```yaml
   demo-orders:
     build: ../../services/demo-orders
     environment:
       PORT: "8081"
       OTEL_SERVICE_NAME: demo-orders
       PAYMENTS_URL: http://demo-payments:8082
       PAYMENTS_TIMEOUT_MS: "3000"
       OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
       OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: http://otel-collector:4318/v1/metrics
       OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: http://otel-collector:4318/v1/logs
     ports:
       - "8081:8081"
     depends_on:
       - otel-collector
     healthcheck:
       test: ["CMD", "node", "-e", "fetch('http://localhost:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
       interval: 5s
       timeout: 3s
       retries: 5

   demo-payments:
     build: ../../services/demo-payments
     environment:
       PORT: "8082"
       OTEL_SERVICE_NAME: demo-payments
       OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
       OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: http://otel-collector:4318/v1/metrics
       OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: http://otel-collector:4318/v1/logs
     ports:
       - "8082:8082"
     depends_on:
       - otel-collector
     healthcheck:
       test: ["CMD", "node", "-e", "fetch('http://localhost:8082/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
       interval: 5s
       timeout: 3s
       retries: 5
   ```
   `demo-inventory` is not touched.
3. Validate (each command on its own line; identical on PowerShell and
   Bash — the Docker CLI's syntax does not differ by host shell):
   ```
   docker compose -f infra/docker/docker-compose.yml config
   ```
   **Expected result:** exit `0`, resolved config includes both real
   `build:` contexts for these two services.
4. Build:
   ```
   docker compose -f infra/docker/docker-compose.yml build demo-orders demo-payments
   ```
   **Expected result:** both images build without error.
5. Smoke-run with guaranteed cleanup — run the `up` and the health check,
   and run `down` whether or not the health check succeeds, so a failure
   never leaves containers running:
   ```
   docker compose -f infra/docker/docker-compose.yml up -d demo-orders demo-payments otel-collector
   docker compose -f infra/docker/docker-compose.yml ps
   ```
   **Expected result:** both services' health status reaches `healthy`
   within ~25 seconds (5 retries × 5s interval). Then, regardless of whether
   the expected result was observed:
   ```
   docker compose -f infra/docker/docker-compose.yml down
   ```
6. Stage, review, commit:
   ```
   git add services/demo-orders/Dockerfile services/demo-payments/Dockerfile infra/docker/docker-compose.yml
   git diff --cached --stat
   git commit -m "feat: containerize demo-orders/demo-payments and wire them into docker-compose"
   git status
   ```

---

### Task 8 — Collector detailed-output configuration

**Depends on:** nothing new (independent of Tasks 2–7, but sequenced here
per the approved spec's own file list). **Implements:** spec §5.

**Files:** `observability/otel-collector/config.yaml`.

1. Edit the `debug` exporter's `verbosity` from `basic` to `detailed`
   (exact diff already specified in spec §5).
2. Validate:
   ```
   docker compose -f infra/docker/docker-compose.yml config
   ```
   **Expected result:** exit `0` (confirms the Compose file still parses;
   the Collector config itself is validated by the Collector binary at
   container start).
3. Smoke-check with guaranteed cleanup:
   ```
   docker compose -f infra/docker/docker-compose.yml up -d otel-collector
   docker compose -f infra/docker/docker-compose.yml logs otel-collector
   ```
   **Expected result:** normal startup log lines, no config-parse error.
   Then, regardless of outcome:
   ```
   docker compose -f infra/docker/docker-compose.yml down
   ```
4. Stage, review, commit:
   ```
   git add observability/otel-collector/config.yaml
   git diff --cached --stat
   git commit -m "chore: increase Collector debug exporter verbosity to detailed for acceptance testing"
   git status
   ```

---

### Task 9 — Acceptance-verification script

**Depends on:** Tasks 7, 8. **Implements:** spec §8, §11.2, requirement 10.

**Files:** `scripts/verify-orders-payments-slice.mjs`.

1. Implement the `pollUntil` helper exactly as specified in spec §8
   (500ms interval, 10000ms deadline, named failure message) — same pattern
   already used in Task 5's `verify-bootstrap-order.mjs`.
2. Implement **Test 1** (successful request) exactly per spec §11.2: record
   `testStartedAt`, `POST /orders` with a fresh `crypto.randomUUID()`, assert
   `201`, poll `docker compose logs --since ${testStartedAt} demo-orders`
   (invoked via `child_process`, not shell piping) for a line containing the
   `order_id`, extract `trace_id`, then poll `docker compose logs --since
   ${testStartedAt} otel-collector` and search its captured text (via a
   JavaScript string/structural check, not a shell `grep`) for: the 3-span
   chain with correct parent-child relationships, at least one
   `http_requests_total` metric point per service, and at least one OTLP log
   record per service.
3. Implement **Test 2** (Payments-unavailable) exactly per spec §11.2's
   `try { ... } finally { ... }` structure: stop `demo-payments`, `POST
   /orders` with a fresh `order_id`, assert the exact `502` body, poll for
   the error-status span and error-severity log by `trace_id`, assert
   exactly one outbound client span for that `trace_id` (no retry), then in
   `finally` restart `demo-payments` and poll its health check —
   unconditionally, even if an assertion above threw, so a failed assertion
   never leaves `demo-payments` stopped for the next run.
4. Add failure diagnostics: wrap the script's `main()` in a top-level
   try/catch; on any thrown error, print the `--since`-scoped logs for
   `demo-orders`, `demo-payments`, and `otel-collector` to stderr before
   re-throwing and exiting with code `1`.
5. Run against the stack from Task 7:
   ```
   docker compose -f infra/docker/docker-compose.yml up -d
   node scripts/verify-orders-payments-slice.mjs
   docker compose -f infra/docker/docker-compose.yml down
   ```
   **Expected result:** exit code `0` from the script, with both Test 1 and
   Test 2 pass confirmations printed in order. The `down` runs regardless of
   the script's exit code, so a failed run doesn't leave the stack up.
6. Stage, review, commit:
   ```
   git add scripts/verify-orders-payments-slice.mjs
   git diff --cached --stat
   git commit -m "test: add Orders/Payments observability acceptance script"
   git status
   ```

---

### Task 10 — Documentation and final validation

**Depends on:** Task 9 (needs everything else in place to validate
end-to-end). **Implements:** spec §12 (README), requirement 11 (full
validation).

**Files:** `README.md` (quick-start section).

1. Edit `README.md`'s "Quick start" section: remove the "placeholder
   containers (`sleep infinity`)" caveat for `demo-orders`/`demo-payments`,
   document `POST /orders`/`POST /payments/charge`/`GET /health`, and add a
   "Verify the observability slice" subsection documenting `node
   scripts/verify-orders-payments-slice.mjs`.
2. Run the full validation sequence, each command on its own line, stopping
   and reporting at the first failure rather than continuing past it. If any
   Docker-related step fails partway through, run `docker compose -f
   infra/docker/docker-compose.yml down` as a cleanup step before reporting
   the failure, so no step in this sequence can leave containers running:

   | Step | Command | Expected outcome |
   |---|---|---|
   | Unit tests (demo-orders) | `cd services/demo-orders` then `npm test` | all tests pass |
   | Unit tests (demo-payments) | `cd services/demo-payments` then `npm test` | all tests pass |
   | Type check (both) | `npm run typecheck` in each | zero errors |
   | Build (both) | `npm run build` in each | `dist/` produced, zero errors |
   | Bootstrap-order check (regression) | `node scripts/verify-bootstrap-order.mjs` (from repo root) | `PASS`, exit `0` |
   | Schema validation (unaffected, confirms no regression) | `python scripts/validate-schemas.py` | all 5 sample events still validate |
   | Compose config validation | `docker compose -f infra/docker/docker-compose.yml config` | exit `0` |
   | Clean-image container build | `docker compose -f infra/docker/docker-compose.yml build --no-cache demo-orders demo-payments` | both images build from scratch, zero errors |
   | Stack up + health checks | `docker compose -f infra/docker/docker-compose.yml up -d` then `docker compose -f infra/docker/docker-compose.yml ps` | `demo-orders`, `demo-payments`, `otel-collector` all `healthy`/`running` |
   | Both live acceptance scenarios | `node scripts/verify-orders-payments-slice.mjs` | exit code `0`, both tests pass |
   | Stack down (always run, pass or fail) | `docker compose -f infra/docker/docker-compose.yml down` | clean shutdown |
   | Git status/diff review | `git status`, `git diff --cached --stat` | reviewed before this task's own commit |

3. Stage, review, commit:
   ```
   git add README.md
   git diff --cached --stat
   git commit -m "docs: update README for the Orders/Payments observability slice"
   git status
   ```

## 9. Spec-requirement → task mapping

| Spec/requirement | Task(s) |
|---|---|
| Repository baseline / hygiene continuity | 1 |
| §3 package/stack choices, lockfiles | 2, 3, 4, 5 |
| §4 contract (incl. removed 503) | 3, 4 |
| §5 Collector verbosity | 8 |
| §6.1 traces, span chain, error status | 5 |
| §6.2 explicit metrics, low-cardinality labels | 5 |
| §6.3 stdout correlation vs. OTLP correlation | 6 |
| §7.1 bootstrap ordering | 5 |
| §7.2 testability / DI boundary | 3, 4 |
| §8 export cadence, bounded polling | 5, 9 |
| §9 env vars, generic-var handling | 5, 7 |
| §10 error handling, no retries | 4, 9 |
| §11.1 unit tests | 3, 4, 6 |
| §11.2 acceptance tests | 9 |
| §12 file list | 2 (scaffolding) → 3–10 (each file's owning task per §6 above) |
| Requirement 7 (input validation) | 3, 4 |
| Requirement 8 (ordering verification, cross-platform) | 5 |
| Requirement 9 (test isolation) | 3, 4, 6 |
| Requirement 10 (acceptance script properties) | 9 |
| Requirement 11 (full validation) | 10 |
| Requirement 12 (scope boundaries) | all — reaffirmed in §4 of this plan |

## 10. Self-review (rerun after revision)

- **Baseline versus feature separation:** Task 1 now creates zero files and
  only reviews/stages/commits what already exists; Task 2 is the first task
  to create any new file (package manifests, tsconfig, `.dockerignore`, the
  ADR), confirmed by re-checking Task 1's file-map entry reads
  "*(baseline — no new files; see Task 1)*".
- **Commit-policy consistency:** §4 now states explicitly that writing this
  plan commits nothing, while *executing* Tasks 1–10 later follows a
  five-step stage/review/commit/verify sequence — checked that every task's
  final step follows that exact sequence (stage named paths, `git diff
  --cached`, commit, `git status`) and that no task says "do not commit"
  anymore.
- **Windows compatibility:** re-scanned every command block for `&&` chains,
  inline `VAR=value cmd`, `/tmp/...`, `&` backgrounding, `kill %1`, and
  `grep` — none remain. Multi-step shell sequences are split one command per
  line (works identically in PowerShell and Bash); the one place that needed
  real process control, env injection, and cleanup (Task 5's bootstrap-order
  check) is a Node script using `child_process.spawn`'s `env` option and a
  `finally` block instead of shell job control. `python` (confirmed
  available in this environment) replaces `python3` throughout.
- **OpenTelemetry context correctness:** Task 6's unit test now exercises
  only the pure `formatLogLine()` function with explicit fake
  `SpanContextLike` values — it makes no OpenTelemetry API call and
  therefore cannot misleadingly appear to test active-context propagation
  without a registered context manager. Real active-context enrichment is
  verified once, correctly, in Task 5's child-process check, where
  `instrument.ts` actually runs and registers a real provider.
- **Process cleanup:** Task 5's bootstrap check kills its spawned Orders
  process and closes its stub server in a `finally` block; Task 9's
  acceptance Test 2 restarts `demo-payments` in a `finally` block; Tasks 7,
  8, and 10 each pair a Docker `up`/build step with an unconditional `down`
  afterward (Task 10's table explicitly notes `down` "always run, pass or
  fail"). No task leaves a background process or container running past its
  own scope on either a pass or a failure.
- **Absence of fixed sleeps:** searched every task for `sleep`/`setTimeout`
  used as a wait — the only `setTimeout` remaining is inside the shared
  `pollUntil` helper's own retry interval, which is itself bounded by a
  deadline and used identically in both Task 5 and Task 9; no task waits a
  fixed duration and assumes readiness.
- **Task numbering and dependency accuracy:** re-verified the "Depends on"
  line of every task against the new 1–10 numbering (Task 5 depends on 3+4,
  not the old "2+3"; Task 9 depends on 7+8, not the old "6+7"; Task 10
  depends on 9, not the old "8") and against §6's file map and §9's
  requirement table, both updated to the same numbering.
- **Specification coverage:** §9's mapping table still covers every spec
  section §3–§12 and every plan requirement 7–12, each pointing at a task in
  the new 1–10 scheme — none orphaned.
- **Brittle test-count language:** replaced every exact count (previously
  "6/6", "9/9", "16/16", "18/18", "11/11") with "all tests pass" plus the
  specific critical case(s) named for that task (e.g., the malformed-
  `order_id` case, the connection-refusal case, the empty-`item` case) —
  these names are derived directly from the test cases each task's own
  steps just described, not invented separately.

## 11. Recommendation for execution

Execute Tasks 1–10 **sequentially in this session**, one task per
request/approval cycle. Per point 9 of this revision: **execution should
begin only with Task 1 (establish the repository baseline), then stop for
review before any package or service work (Task 2 onward) begins** — Task 1
has no code dependency on anything that follows, but every later task's
proposed commit assumes the baseline commit already exists as the repository's
first commit, so starting elsewhere would leave that assumption unverified.

## 12. Remaining blocker

None. The one open question from the prior draft (whether Task 1 should
include the baseline commit) is now resolved by this revision — Task 1 *is*
that commit, and it is the designated entry point for execution.
