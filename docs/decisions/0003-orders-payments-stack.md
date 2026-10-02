# 3. Orders/Payments observability slice — stack choices

## Status
Accepted

## Context
`docs/specs/2026-10-01-orders-payments-observability-slice.md` (§3) resolves
several implementation choices for the Orders → Payments vertical slice
(First Ten Tasks #5–6). This ADR records those choices and the reasoning
already established in the spec, so a future reader doesn't need to re-derive
them from the task history.

## Decisions

- **TypeScript on Node.js, not Go**, for `demo-orders` and `demo-payments`.
  Node was already installed and verified locally when this slice was
  designed; Go was not. Go's "distinct signal" value (per the project plan's
  technology-stack rationale) is unaffected, since `collector-go` is already
  scheduled to use Go in Week 3 regardless of this choice
  ([0002-monorepo-and-language-split.md](0002-monorepo-and-language-split.md)).
- **Fastify, not Express**, as the HTTP framework. Lower overhead for a
  two-route service, first-class TypeScript types, and `app.inject()`
  supports in-process unit testing without opening a real port.
- **axios, not the global `fetch` (undici), for the one outbound call.**
  Under Node, axios delegates to the core `http`/`https` modules, which
  `@opentelemetry/instrumentation-http` instruments automatically — it
  creates the outbound client span and injects the `traceparent` header with
  no custom code. Node's global `fetch` does not go through the `http`
  module and would need the separate, less mature
  `@opentelemetry/instrumentation-undici` package instead. axios was chosen
  specifically to keep the instrumentation surface to one well-trodden
  package.
- **OTLP/HTTP (port 4318), not OTLP/gRPC (port 4317),** for all three signal
  types. Avoids the native-binary dependency (`@grpc/grpc-js`) that OTLP/gRPC
  exporters pull in — a common source of flakiness in Alpine-based
  containers. The Collector already exposes both ports; HTTP is the
  lower-friction choice for Node.
- **A dedicated `instrument.ts` entry point, statically imported first in
  `main.ts`, with the application code (`server.ts`, `paymentsClient.ts`)
  loaded only via a subsequent dynamic `import()`.** OpenTelemetry's Node
  instrumentations patch the `http`/`https` core modules at `require`-time;
  if Fastify, axios, or `http` load before instrumentation registration
  completes, the patch never attaches and trace propagation silently stops
  working. This bootstrap split removes any dependence on static-import
  ordering or hoisting.
- **No shared npm package or workspace between the two services.** Only two
  services exist; a shared `@signalforge/telemetry` package would be a
  premature abstraction for roughly 50 lines of bootstrap code. The telemetry
  bootstrap file is duplicated once per service and revisited only if a
  third Node service needs the same code.
- **`package-lock.json` committed per service**, despite being a generated
  file — unlike `node_modules/`, a lockfile is what makes each service's
  build reproducible, so it is tracked rather than gitignored.

## Consequences

Two services, each independently buildable and testable, at the cost of some
duplicated bootstrap code between them. The duplication is accepted now and
revisited only if a third Node service is added to this repository.
