# Orders → Payments observability slice

Status: **Approved for implementation** (approved 2026-10-02).
Implements: First Ten Tasks #5–6 (`SignalForge_Project_Plan.docx`, section 24)
Related: [0002-monorepo-and-language-split.md](../decisions/0002-monorepo-and-language-split.md)

## 1. Purpose and boundary

Prove end-to-end cross-service observability through the OpenTelemetry Collector
with the smallest functional Orders → Payments request path: one synchronous
HTTP call, one propagated trace, explicit metrics, and application logs — all
three signal types delivered via OTLP.

Out of scope for this slice, regardless of what would be convenient to add
while the files are open: persistence, messaging (Redpanda), authentication,
retries/circuit breakers, correlation/incident creation, the AI agent, the
dashboard, and `demo-inventory`. Anything on this list stays deferred to the
week the plan already assigns it (see section 11 below).

## 2. Services and responsibilities

| Service | Responsibility |
|---|---|
| `demo-orders` | `POST /orders` — accepts an order, calls `demo-payments`, returns a combined result. `GET /health` — liveness only, excluded from telemetry (section 6). |
| `demo-payments` | `POST /payments/charge` — accepts a charge request, always approves it in this slice (see section 4 for why there is no failure branch). `GET /health` — same exclusion. |
| `otel-collector` | Already running from the Week 1 Compose skeleton. Receives OTLP traces, metrics, and logs from both services and prints them via the `debug` exporter. No new service; one config change (section 5). |

`demo-inventory` is not touched.

## 3. Resolved technology choices

These are final for this slice; nothing below is left open to interpretation at
implementation time.

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node.js | Already installed locally (v24.17.0); Go is not. Go's "distinct signal" is already scheduled for `collector-go` in Week 3 regardless of this choice (ADR 0002). |
| Container base image | `node:24-alpine` | Matches the local authoring/testing runtime exactly, avoiding host/container Node-version drift. |
| HTTP framework | **Fastify** | Built-in structured logger (`pino`) composes naturally with the stdout logging requirement; first-class TypeScript types; lower overhead than Express for a two-route service; `app.inject()` supports in-process testing without opening a port (section 7). |
| Outbound HTTP client (Orders → Payments) | **axios**, behind an injectable `PaymentsClient` interface | Under Node, axios delegates to the core `http`/`https` modules, which `@opentelemetry/instrumentation-http` instruments automatically — it creates the outbound client span and injects the `traceparent` header with no custom code. Node's global `fetch` (undici) does **not** go through the `http` module and would need the separate, less mature `@opentelemetry/instrumentation-undici` package instead — rejected to keep the instrumentation surface to one well-trodden package. Wrapped behind an interface so unit tests never make a real network call (section 7). |
| Package manager | npm (bundled with Node), with `package-lock.json` committed per service | No reason to add pnpm/yarn for two small, independent services. Each service resolves its own dependency tree independently (no shared workspace, see below), so each gets its own committed lockfile for reproducible builds — unlike `node_modules/`, a lockfile is generated but deliberately tracked, not gitignored. |
| Package layout | One `package.json` per service, **no shared npm package/workspace** | Only two services exist; a shared `@signalforge/telemetry` package would be a premature abstraction for ~50 lines of bootstrap code. The OTel bootstrap file is duplicated once per service (section 6, section 7) and revisited if a third service needs it. |
| OTLP transport | **OTLP/HTTP (protobuf)**, port 4318 | Avoids the native-binary dependency (`@grpc/grpc-js`) that OTLP/gRPC exporters pull in, which is a common source of flakiness in Alpine-based containers. The Collector already exposes both 4317 (gRPC) and 4318 (HTTP) — HTTP is simply the lower-friction choice for Node. |
| Instrumentation bootstrap | **Dedicated entry point + dynamic import**, not `-r`/static import ordering | See section 7.1. |
| Test runner | Node's built-in `node:test`, executed via `tsx` | No Jest/Vitest dependency. `tsx --test test/**/*.test.ts` runs TypeScript tests directly against the built-in runner. |
| Build for containers | `tsc` compiles `src/` → `dist/` in a multi-stage Dockerfile; the runtime stage runs `node dist/main.js` | No `ts-node`/`tsx` in the production image — smaller image, no runtime TS compilation cost. Note the entry point is `main.js`, not `server.js` (section 7.1). |

## 4. Request/response contract

```
POST /orders
Request:  { "order_id": "<uuid>", "item": "<string>", "amount_cents": <integer> }
Response 201: { "order_id": "<uuid>", "status": "created", "payment_status": "approved" }
Response 502: { "order_id": "<uuid>", "status": "failed", "reason": "payment_unavailable" }

POST /payments/charge        (internal; called only by demo-orders)
Request:  { "order_id": "<uuid>", "amount_cents": <integer> }
Response 200: { "order_id": "<uuid>", "payment_status": "approved" }

GET /health                  (both services)
Response 200: { "status": "ok" }
```

**`POST /payments/charge` has no documented failure response in this slice.**
The earlier draft listed a `503 { error: "payments_unavailable" }` response,
but there is no reachable code path that produces it: `demo-payments`'s
handler in this slice has exactly one branch — validate the body shape, then
unconditionally approve. The "Payments unavailable" scenario tested in
section 9 is `demo-payments` being **stopped entirely** (container down),
which `demo-orders` observes as a connection failure/timeout at the client
boundary — never as an HTTP response from Payments at all. Documenting a 503
`demo-payments` cannot actually emit would describe nonexistent behavior. If a
later slice adds an internal failure branch to Payments (e.g. a deterministic
fault switch, First Ten Tasks #9), a real error response is specified then.

No JSON Schema file is added for this contract yet. Both endpoints are written
in the same change by the same author; formalizing the schema now would be
ceremony with no second consumer to protect against drift. The schema moves
into `contracts/api/` the moment a second, independently-evolving consumer
exists — expected in Week 4 when the dashboard calls the operator API.

`order_id` is the deterministic correlation key required by section 9: it is
supplied by the caller, echoed in every response, and included as a field on
every application log line from both services, so a human or script can go
from "the order I sent" to "the trace that produced it" without first knowing
a trace ID.

## 5. OpenTelemetry Collector — confirmed configuration

The Collector config at `observability/otel-collector/config.yaml` already
defines `traces`, `metrics`, and `logs` pipelines, each with the `otlp`
receiver (gRPC on 4317, HTTP on 4318) and the `debug` exporter — no pipeline is
missing, so no pipeline is added.

One change is required: the `debug` exporter's `verbosity` is currently
`basic`, which prints only summary counts (span/metric/log counts), not the
trace IDs, span IDs, or attribute values needed to grep for a specific
`order_id` or trace ID during acceptance testing. This must change to
`detailed` before acceptance testing is possible:

```yaml
exporters:
  debug:
    verbosity: detailed   # was: basic
```

No other receiver, processor, or exporter changes are needed for this slice.

## 6. Instrumentation design

### 6.1 Traces

- `@opentelemetry/sdk-trace-node` with a `NodeTracerProvider`, a
  `BatchSpanProcessor`, and `OTLPTraceExporter` (from
  `@opentelemetry/exporter-trace-otlp-http`) pointed at
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. The `BatchSpanProcessor` is
  constructed with `scheduledDelayMillis: 1000` (not the SDK's 5000ms
  default) — see section 8 for why.
- `@opentelemetry/instrumentation-http` registered globally, with
  `ignoreIncomingRequestHook` and `ignoreOutgoingRequestHook` both returning
  `true` for any request whose path is `/health`. This is the mechanism for
  requirement 5 (exclude health checks from telemetry) — enforced at the
  instrumentation layer, not left to a best-effort filter in the acceptance
  script.
- Required span chain for a successful request, all under one `trace_id`:
  1. `demo-orders` inbound server span (`POST /orders`), created by
     `instrumentation-http`'s server-side hook.
  2. `demo-orders` outbound client span (`POST /payments/charge`), created by
     `instrumentation-http`'s client-side hook around the axios call inside
     `PaymentsClient` (section 7.2), as a child of span 1.
  3. `demo-payments` inbound server span (`POST /payments/charge`), created by
     `instrumentation-http`'s server-side hook after extracting the
     `traceparent` header that axios/instrumentation-http injected — a child
     of span 2.
- On a failed call to Payments (timeout or non-2xx), the `demo-orders` outbound
  span (and the handler span wrapping it) is marked
  `span.setStatus({ code: SpanStatusCode.ERROR, message: ... })` before the
  502 response is returned. This is explicit application code in the error
  branch, not inferred from the HTTP status by the instrumentation.

### 6.2 Metrics

Metrics are **explicit**, not assumed from auto-instrumentation:

- `@opentelemetry/sdk-metrics` with a `MeterProvider`, a
  `PeriodicExportingMetricReader`, and `OTLPMetricExporter` (from
  `@opentelemetry/exporter-metrics-otlp-http`) pointed at
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. The reader is constructed with
  `exportIntervalMillis: 1000` (not the SDK's 60000ms default) — see section 8.
- Each service defines, in its own `src/metrics.ts`:
  - `http_requests_total` — a `Counter`, incremented once per completed
    request in the route handler (not in global middleware, so `/health` is
    never counted).
  - `http_request_duration_seconds` — a `Histogram`, recorded once per
    completed request with the handler's measured duration.
- Labels, deliberately low-cardinality and fixed in advance:
  `route` (the literal route template — `"/orders"` or
  `"/payments/charge"`, never the raw path with parameters, though this slice
  has no path parameters), `method` (`"POST"`), and `status_code` (the exact
  numeric HTTP status — a finite set: `201`, `502`, `200` across both
  services, now that section 4 removes the undocumentable 503). **Never**
  `order_id` or `trace_id` as a label — those are high-cardinality and belong
  on logs and span attributes only, never on a metric label, per requirement 6.

### 6.3 Logs

- `@opentelemetry/sdk-logs` with a `LoggerProvider`, a
  `BatchLogRecordProcessor` (also `scheduledDelayMillis: 1000`, matching
  traces — see section 8), and `OTLPLogExporter` (from
  `@opentelemetry/exporter-logs-otlp-http`) pointed at
  `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, registered via
  `logs.setGlobalLoggerProvider()` from `@opentelemetry/api-logs`.
- A single shared-per-service helper, `src/logger.ts`, exposes one function:

  ```ts
  function logEvent(
    severity: 'info' | 'warn' | 'error',
    message: string,
    attributes: Record<string, string | number | boolean>
  ): void
  ```

  **The stdout line and the OTLP log record get their trace/span correlation
  through two different mechanisms — this distinction is deliberate, not
  accidental duplication:**

  1. **OTLP path (automatic context association):** `logEvent` calls
     `logs.getLogger('<service-name>').emit({ severityNumber, body: message,
     attributes })`. Because this executes inside the active span's context
     (Fastify's handler runs inside the context `instrumentation-http`
     activates for the inbound request), the OTel Logs SDK automatically
     attaches the active `trace_id` and `span_id` to the exported `LogRecord`.
     No application code reads or writes those fields for this path — the SDK
     does it via the ambient context.
  2. **Stdout path (explicit enrichment):** the SDK's automatic context
     association only affects the `LogRecord` object sent via OTLP — it has no
     effect on a plain `console.log` string. For the stdout JSON line to carry
     `trace_id`/`span_id` too (required so the acceptance script in section 9
     can read them from `docker compose logs demo-orders` without needing to
     talk to the Collector first), `logEvent` explicitly reads the active span
     before formatting the stdout line:

     ```ts
     import { trace } from '@opentelemetry/api';

     function logEvent(severity, message, attributes) {
       const spanContext = trace.getActiveSpan()?.spanContext();
       const correlation = spanContext
         ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
         : {};

       otelLogger.emit({ severityNumber: severityNumberFor(severity), body: message, attributes });

       console.log(JSON.stringify({
         level: severity,
         message,
         timestamp: new Date().toISOString(),
         ...attributes,
         ...correlation,
       }));
     }
     ```

     If there is no active span (e.g. a log line emitted outside any request
     context, which does not happen in this slice but is handled safely),
     `correlation` is `{}` and the stdout line simply omits `trace_id`/
     `span_id` rather than emitting `undefined`.
- Every call site includes `order_id` explicitly in `attributes` — this is an
  application-level field neither the OTel SDK nor the span context has any
  way to infer, and it is the field the acceptance script uses to find the
  right stdout line before reading back `trace_id` (section 9, step 4).
- Minimum log events per request: one `info` line on receipt, one `info` line
  on successful completion (or one `error` line on failure), from each service
  that handles the request.
- Stdout alone never satisfies the acceptance criteria in section 9 — the OTLP
  export (mechanism 1 above) is what's checked there; the stdout line
  (mechanism 2) is only how the acceptance script *discovers* the trace ID in
  the first place, without needing a separate trace-query API that doesn't
  exist in this slice.

## 7. Bootstrap order and testability

### 7.1 Instrumentation startup order

OpenTelemetry's Node instrumentations (`@opentelemetry/instrumentation-http`)
work by patching the `http`/`https` core modules at `require`-time via
require-in-the-middle. If Fastify, axios, or Node's `http` module are loaded
(directly or transitively) **before** instrumentation registration runs, the
patch never attaches and spans/context-propagation silently don't happen —
this is a known class of bug with ES module static imports, where import
hoisting makes the actual load order non-obvious. This slice uses a single,
unambiguous pattern to avoid it:

- **`src/instrument.ts`** — the *only* file imported for its side effects
  before anything else. Contains nothing but: construct the resource
  (service name, version), construct and register the `NodeTracerProvider`,
  `MeterProvider`, and `LoggerProvider` with their OTLP exporters (sections
  6.1–6.3), and call `registerInstrumentations({ instrumentations: [new
  HttpInstrumentation({ ... }) ] })`. It imports nothing from `fastify`,
  `axios`, or the application code.
- **`src/main.ts`** — the process entry point (what the Dockerfile's `CMD`
  runs, as `dist/main.js`). Its *first* statement is a static import of
  `./instrument.js`:

  ```ts
  import './instrument.js';               // must be the first line, runs synchronously

  async function start() {
    const { buildServer } = await import('./server.js');       // dynamic: loaded only after
    const { createAxiosPaymentsClient } = await import('./paymentsClient.js'); // instrument.ts has run
    const app = buildServer({ paymentsClient: createAxiosPaymentsClient(/* ... */) });
    await app.listen({ port: Number(process.env.PORT), host: '0.0.0.0' });
  }

  start();
  ```

  Because `./server.js` and `./paymentsClient.js` are loaded via dynamic
  `import()` *after* the static import of `./instrument.js` has fully
  executed, Node guarantees instrumentation registration completes before
  `fastify`/`axios`/`http` are ever required — there is no reliance on static
  import ordering, hoisting, or `-r` flag conventions.
- **`src/server.ts`** — exports `buildServer(deps)` only (section 7.2). It has
  no side effects at import time beyond defining the function; it does not
  call `.listen()` and does not import `instrument.ts`.

### 7.2 Testability: app construction vs. process startup

- **`src/paymentsClient.ts`** exports:
  ```ts
  interface PaymentsClient {
    charge(orderId: string, amountCents: number): Promise<{ paymentStatus: 'approved' }>;
  }
  function createAxiosPaymentsClient(baseUrl: string, timeoutMs: number): PaymentsClient;
  ```
  `createAxiosPaymentsClient` is the only thing that touches axios; it is
  called exactly once, in `main.ts`, with real config.
- **`src/server.ts`** exports:
  ```ts
  function buildServer(deps: { paymentsClient: PaymentsClient }): FastifyInstance;
  ```
  `demo-payments`'s `server.ts` takes no dependencies (`buildServer(): FastifyInstance`) since it has no outbound calls.
- **Unit tests** (`test/server.test.ts`) import `buildServer` directly from
  `../src/server.js` — they never import `../src/main.ts` or
  `../src/instrument.ts`, so **no OTel SDK is ever initialized during unit
  tests**: `@opentelemetry/api` and `@opentelemetry/api-logs` are designed to
  be safe to call with no provider registered (`trace.getActiveSpan()`
  returns `undefined`, `logs.getLogger(...).emit(...)` is a documented no-op)
  — so `logger.ts` and `metrics.ts` run without error, they simply don't
  export anything, which is correct for a unit test. This is what prevents
  global providers, batch-processor timers, or exporter HTTP clients from
  leaking into the test process.
- Tests call `app.inject({ method: 'POST', url: '/orders', payload: {...} })`
  — Fastify's built-in in-process request simulation — so **no real TCP port
  is opened** for any unit test.
- The Payments-unreachable unit test passes a stub `PaymentsClient` whose
  `charge()` rejects (simulating a timeout/connection error), rather than
  starting a real `demo-payments` process or faking a network timeout.

## 8. Deterministic export and bounded polling

Default OTel SDK batching intervals are tuned for production (span batch
delay 5000ms, metric export interval 60000ms) — both are far longer than is
reasonable for a test loop, and relying on them risks one of two failure
modes: a test that passes only if it happens to wait long enough, or a test
written with a fixed `sleep()` that either flakes (too short) or wastes time
on every run (padded long "to be safe"). This slice avoids both:

- **Export cadence (producer side, services):** `scheduledDelayMillis: 1000`
  on both the span and log batch processors (sections 6.1, 6.3);
  `exportIntervalMillis: 1000` on the metric reader (section 6.2). These are
  hardcoded constants in `instrument.ts`, not environment-configurable — this
  is a fixed test/dev reliability setting, not a deployment tuning knob, so
  introducing an env var for it would be configuration surface with no real
  use case yet.
- **Bounded polling (consumer side, the acceptance script):** no fixed
  `sleep()` of any duration. Instead, a single helper:

  ```ts
  async function pollUntil(
    check: () => Promise<boolean>,
    { intervalMs = 500, timeoutMs = 10000, what = 'condition' } = {}
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
  }
  ```

  Used for every "wait for this to show up" step in section 9: waiting for
  the `demo-orders` stdout log line containing a given `order_id` to appear,
  and waiting for the Collector's debug output to contain a given `trace_id`.
  A 10-second deadline against a 1-second export cadence gives roughly an
  order of magnitude of margin without the script hanging indefinitely on a
  genuine failure — a failed `pollUntil` call produces a clear, immediate
  timeout error naming what it was waiting for, rather than a hang.

## 9. Ports, environment, health checks, dependencies

| Service | Container port | Compose mapping | Depends on | Health check |
|---|---|---|---|---|
| `demo-orders` | 8081 | `8081:8081` | `otel-collector` (hard — won't start cleanly without telemetry init); `demo-payments` (soft — see error handling, section 10) | `GET /health` → `200 {"status":"ok"}` |
| `demo-payments` | 8082 | `8082:8082` | `otel-collector` (hard) | `GET /health` → `200 {"status":"ok"}` |

**New environment variables — exactly five, added to `.env.example`, no secrets:**

```
PAYMENTS_URL=http://demo-payments:8082
PAYMENTS_TIMEOUT_MS=3000
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://otel-collector:4318/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://otel-collector:4318/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://otel-collector:4318/v1/logs
```

**Handling of the existing generic `OTEL_EXPORTER_OTLP_ENDPOINT`** (already in
`.env.example` from the Week 1 scaffold, pointed at port 4317 for gRPC): it is
**left unchanged and is not read by either service in this slice**.
`instrument.ts` constructs each OTLP exporter with an explicit `url` option
read directly from the three signal-specific variables above — it does not
rely on the OTel SDK's built-in environment-variable auto-discovery (which
would otherwise fall back from a signal-specific var to the generic one and
append `/v1/<signal>` itself). Reading the three specific variables explicitly
in code, and never touching the generic one, removes any ambiguity about
precedence: there is nothing to resolve, because only one set of variables is
ever consulted by this code. The generic variable remains in `.env.example`
unchanged, available for a future non-Node service (e.g. `collector-go`'s Go
OTel SDK, which may use env-var auto-discovery differently) — it is not
contradictory, it is simply unused by `demo-orders`/`demo-payments`.

`OTEL_SERVICE_NAME` (already in `.env.example`) is overridden per-service at
the Compose level (`demo-orders`, `demo-payments`) so spans/logs/metrics are
correctly attributed to their origin service.

`docker-compose.yml` replaces the two `alpine:3.20` / `sleep infinity`
placeholders for `demo-orders` and `demo-payments` with real `build:` contexts
pointing at `services/demo-orders/Dockerfile` and
`services/demo-payments/Dockerfile`, the ports/env above, and a `healthcheck:`
block using `GET /health`. `demo-inventory` keeps its placeholder unchanged.

## 10. Error handling and timeout behavior

- The outbound axios call inside `PaymentsClient` (section 7.2) has a fixed
  3-second timeout (`PAYMENTS_TIMEOUT_MS`) and **no retry logic** — zero
  retries, by design, for this slice. Retry/backoff policy is a resilience
  concern explicitly deferred to the testing strategy's later "Resilience"
  category (plan section 15), which doesn't exist yet in this repo.
- On timeout or any non-2xx response from Payments:
  1. The outbound client span and the `/orders` handler span are marked
     `ERROR` (section 6.1).
  2. `demo-orders` logs one `error`-severity event carrying the same
     `order_id` and (via the mechanisms in section 6.3) the same `trace_id` as
     the rest of the request.
  3. `demo-orders` returns `502 { order_id, status: "failed", reason:
     "payment_unavailable" }` — the exact documented gateway-error response
     from section 4, not a generic 500.
  4. The axios call is made exactly once. There is no loop, no retry
     middleware, and no catch-and-reattempt logic anywhere in `PaymentsClient`
     or the handler — this is verifiable by reading the source, and
     empirically by the Payments-unavailable test (section 9.2 → now
     section 11.2) confirming exactly one attempt.

## 11. Test strategy

### 11.1 Unit tests (`node:test` via `tsx`, one file per service)

- `POST /orders` with a stub `PaymentsClient` that resolves → asserts `201`
  and the response shape from section 4.
- `POST /orders` with a stub `PaymentsClient` that rejects (simulating
  timeout/connection failure) → asserts `502` and the documented failure body.
- `POST /payments/charge` with a valid body → asserts `200` and the approved
  response shape.
- All three use `app.inject()` (section 7.2) — no real port, no real network
  call, no real `demo-payments` process.
- No telemetry assertions at the unit level — correctness of span/metric/log
  emission is an integration concern, checked against the real Collector, not
  mocked, and these tests don't even load the OTel SDK (section 7.2).

### 11.2 Integration / acceptance (the criteria that matter for this task)

Both tests below run against the full Compose stack (`demo-orders`,
`demo-payments`, `otel-collector`) and are the acceptance criteria for First
Ten Tasks #5–6. These are specified here; the runnable script itself
(`scripts/verify-orders-payments-slice.mjs`) is created in the implementation
step, not this one. Both tests use `pollUntil` (section 8) for every
"wait for this to appear" step — no fixed sleeps.

**Test 1 — successful request reaches all three signal pipelines**

1. Record `testStartedAt = new Date().toISOString()`.
2. Generate a fresh UUID as `order_id`.
3. `POST http://localhost:8081/orders` with that `order_id`.
4. Assert the HTTP response is `201` and echoes the same `order_id`.
5. `pollUntil` reading `demo-orders`' logs (`docker compose logs --since
   ${testStartedAt} demo-orders`) for a line containing this `order_id`, then
   extract its `trace_id` field from that line — a text/field match, not a
   parsing guess, and scoped to output generated after the test began so a
   stale line from a previous run can't match.
6. Using that `trace_id`, `pollUntil` reading the Collector's output
   (`docker compose logs --since ${testStartedAt} otel-collector`), filtered
   first by `--since` and then by a substring match on the `trace_id`, and
   assert:
   - At least one trace span group contains this exact `trace_id`.
   - Within that trace ID, there are at least three spans matching the chain
     in section 6.1 (Orders server span, Orders client span, Payments server
     span), and the Collector's detailed output shows the expected
     parent-span-ID relationships between them (Orders server span is parent
     of Orders client span; Orders client span is parent of Payments server
     span).
   - At least one metric data point for `http_requests_total` was exported by
     each service with `status_code` in {`201`, `200`}.
   - At least one log record carrying this `trace_id` was exported via OTLP
     (not just present in stdout) from each service.
   - **The test does not assert that the Collector contains exactly one
     trace overall** — health-check activity or other SDK startup telemetry
     may also be present; the test only asserts that a trace matching this
     specific `trace_id` exists and has the required shape (requirement 4).

**Test 2 — Payments-unavailable produces an observable, non-retried failure**

Structured as `try { ... } finally { ... }` so `demo-payments` is always
restarted, including when an assertion in the `try` block throws:

```js
const testStartedAt = new Date().toISOString();
try {
  await exec('docker compose stop demo-payments');
  const orderId = randomUUID();
  const res = await postOrder(orderId);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { order_id: orderId, status: 'failed', reason: 'payment_unavailable' });

  const traceId = await pollUntil(() => findTraceIdForOrder(orderId, testStartedAt), { what: 'order log line with trace_id' });

  await pollUntil(() => collectorShowsErrorSpan(traceId, testStartedAt), { what: 'error-status Orders span' });
  await pollUntil(() => collectorShowsErrorLog(traceId, testStartedAt), { what: 'error-severity log record' });
  assert.equal(await countOutboundClientSpansForTrace(traceId, testStartedAt), 1, 'no retry: exactly one outbound client span');
} finally {
  await exec('docker compose start demo-payments');
  await pollUntil(() => isHealthy('demo-payments'), { what: 'demo-payments health after restart' });
}
```

Both `docker compose logs` scans in this test use `--since ${testStartedAt}`
(matching Test 1's scoping, section 11.2 step 5–6), so a trace/log from a
prior test run or from container startup cannot be mistaken for this test's
output.

### 11.3 Explicitly deferred testing

Load testing, resilience testing (restart/duplicate/delay scenarios), and
security testing (section 15 categories) are out of scope — there's no second
telemetry source yet to meaningfully stress, and no untrusted input path
exists in this slice to attack.

## 12. Files this implementation will create or change

```
services/demo-orders/
  src/instrument.ts       # new — OTel providers + exporters + HTTP instrumentation,
                            #          registered before anything else (section 7.1)
  src/main.ts              # new — process entry point; static-imports instrument.ts
                            #          first, then dynamically imports server.ts (section 7.1)
  src/server.ts            # new — exports buildServer(deps); no listen(), no side effects
  src/paymentsClient.ts     # new — PaymentsClient interface + createAxiosPaymentsClient()
  src/logger.ts             # new — logEvent() helper (OTLP + enriched stdout, section 6.3)
  src/metrics.ts            # new — http_requests_total, http_request_duration_seconds
  test/server.test.ts        # new — uses buildServer() + a stub PaymentsClient + app.inject()
  package.json                # new
  package-lock.json            # new — generated, committed (not gitignored)
  tsconfig.json                 # new
  Dockerfile                     # new — multi-stage, node:24-alpine, CMD ["node","dist/main.js"]
  .dockerignore                   # new

services/demo-payments/
  src/instrument.ts       # new (duplicated bootstrap, see section 3)
  src/main.ts              # new
  src/server.ts            # new — exports buildServer(); no outbound-dependency param needed
  src/logger.ts             # new
  src/metrics.ts            # new
  test/server.test.ts        # new
  package.json                # new
  package-lock.json            # new — generated, committed (not gitignored)
  tsconfig.json                 # new
  Dockerfile                     # new
  .dockerignore                   # new

scripts/verify-orders-payments-slice.mjs   # new — Test 1 and Test 2 from section 11.2,
                                             #          including pollUntil (section 8)

.env.example                                # change — add the five vars in section 9
infra/docker/docker-compose.yml             # change — real build contexts for the
                                              #          two services (section 9);
                                              #          demo-inventory untouched
observability/otel-collector/config.yaml    # change — debug exporter verbosity:
                                              #          basic -> detailed (section 5)
docs/decisions/0003-orders-payments-stack.md # new — ADR recording the choices in
                                              #          section 3 (Fastify, axios,
                                              #          OTLP/HTTP, instrument.ts/main.ts
                                              #          bootstrap split, no shared package)
```

No change to `contracts/events/*` (no new event types in this slice) or to
`demo-inventory`.

## 13. Explicitly deferred (not forgotten)

- Redpanda/ClickHouse publishing, the Go correlation service, incident
  creation — Week 3.
- Deployment-event emission — First Ten Tasks #8.
- Deterministic fault-injection switches — First Ten Tasks #9. (This is also
  where a real Payments-side failure branch, and therefore a real
  machine-producible error response from `POST /payments/charge`, would be
  introduced — see section 4.)
- The operator dashboard — Week 4.
- `contracts/api/*.schema.json` formalization of the HTTP contract in
  section 4 — revisit when a second consumer exists.
- Auth, persistence beyond process memory, retry/circuit-breaker logic, load
  and resilience testing.
- A shared telemetry npm package — revisit if a third Node service needs the
  same bootstrap code.
- An env var for batch/export intervals — revisit if a deployment scenario
  actually needs the 1000ms dev/test cadence tuned differently (section 8).

## 14. Self-review notes (rerun after revision)

- **Status accuracy:** header now reads "Proposed — ready for review," with
  an explicit note that implementation must not begin until the status
  changes via explicit approval. The prior "Approved for implementation"
  label is removed throughout — checked that no other section (e.g. section
  12's file list) implied work had already started.
- **Import/startup ordering:** section 7.1 now names one specific, concrete
  pattern (`instrument.ts` static-imported first in `main.ts`, application
  code loaded only via a subsequent dynamic `import()`) rather than
  describing the goal abstractly. Checked against section 12's file list:
  `instrument.ts` and `main.ts` both appear as new files for both services,
  and the Dockerfile `CMD` target changed from `dist/server.js` to
  `dist/main.js` to match.
- **Agreement between logging design and acceptance steps:** section 6.3 now
  explicitly adds `trace_id`/`span_id` to the stdout JSON line via
  `trace.getActiveSpan()`, which is exactly what section 11.2's Test 1 step 5
  and Test 2 rely on when reading `docker compose logs demo-orders` to
  recover a `trace_id` — checked that no acceptance step still assumes a
  stdout field that section 6.3 doesn't actually produce.
- **Test isolation:** section 7.2 defines the `buildServer(deps)` /
  `PaymentsClient` interface boundary and states explicitly that unit tests
  never import `instrument.ts`, so no global OTel provider, batch-processor
  timer, or exporter HTTP client is created during `node:test` runs. Checked
  that section 12's file list reflects this split (`server.ts` separate from
  `main.ts`/`instrument.ts`) for both services.
- **Timeout/export reliability:** section 8 hardcodes 1000ms export/batch
  cadences on the producer side and defines a single bounded `pollUntil`
  helper (500ms interval / 10s deadline) for the consumer side; section 11.2
  rewrote both acceptance tests to use it instead of implying a fixed sleep.
  Checked that no step in section 11.2 contains an unbounded wait or an
  unexplained fixed delay.
- **Environment-variable consistency:** section 9 states the count is
  exactly five new variables and explains, rather than leaves implicit, why
  the pre-existing generic `OTEL_EXPORTER_OTLP_ENDPOINT` is untouched and
  unread by this slice's code — checked that `instrument.ts`'s description in
  section 6 and section 7.1 only ever references the three signal-specific
  variable names, never the generic one, so the explanation in section 9
  matches what the code actually does.
- **File-list completeness:** section 12 now includes `instrument.ts`,
  `main.ts`, `paymentsClient.ts`, and `package-lock.json` for both services,
  none of which appeared in the prior draft. Checked that `package-lock.json`
  is called out as deliberately committed (unlike `node_modules/`) so a
  future reader doesn't assume it's an oversight against the existing
  `.gitignore` conventions.
- Re-checked for scope creep after all edits: section 13's deferred list
  still matches section 12's file list — nothing added in this revision
  touches Redpanda, ClickHouse, Temporal, the dashboard, or `demo-inventory`.
