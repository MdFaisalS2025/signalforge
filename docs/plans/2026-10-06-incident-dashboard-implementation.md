# Incident dashboard implementation plan

Status: **Proposed for review.** Do not start until
[2026-10-06-incident-dashboard.md](../specs/2026-10-06-incident-dashboard.md) is approved.
Implements: the spec above, exactly. Any change to a contract in that spec is a spec change first.

## Ground rules for every task

- **Test first.** Each task writes its failing test, runs it, and records the failure message before the
  implementation. A task whose test passes before the change is not done; the test is wrong or redundant.
- **One commit per task**, staged by explicit path. Review `git diff --cached --check` and the staged diff
  before each commit.
- **No new services beyond `web`.** No changes to `demo-orders`, `demo-payments`, `collector-go`, the
  OpenTelemetry Collector, Redpanda topics, or ClickHouse migrations.
- **Read-only.** No route, page, or script issues a write to ClickHouse, Redpanda, or any file outside the
  owned paths.
- **No shell composition.** Child processes use argument arrays. Commands in this plan are shown as they run.
- **Bounded waits only.** Every network call in the acceptance script has a deadline.
- **Local credentials only.** `changeme-local-only` is the existing convention. Nothing else is stored.
- Do not merge, rebase, push, or amend. Do not touch `master` or the Orders/Payments worktree.

## Validation commands (run at the end of every task that owns code)

```bash
npm --prefix apps/web test
npm --prefix apps/web run typecheck
node --test scripts/verify-incident-dashboard.test.mjs
docker compose -f infra/docker/docker-compose.yml config --quiet
```

Tasks that touch only `infra/` or docs run the Compose check, plus the stack-level checks named in the task.

## File ownership

| Path | Owner task |
|---|---|
| `infra/clickhouse/users.d/dashboard-reader.xml` | T1 |
| `infra/docker/docker-compose.yml` (clickhouse volume; web service) | T1, T2 |
| `apps/web/package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `Dockerfile` | T2 |
| `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx` | T2, T7 |
| `apps/web/app/api/health/route.ts` (+ `apps/web/src/server/health.test.ts`) | T2 |
| `apps/web/src/server/validate.ts` (+ `validate.test.ts`) | T3 |
| `apps/web/src/server/queries.ts` (+ `queries.test.ts`) | T3 |
| `apps/web/src/server/clickhouse.ts` (+ `clickhouse.test.ts`) | T4 |
| `apps/web/src/server/model.ts` (+ `model.test.ts`) | T5 |
| `apps/web/src/server/service.ts` (+ `service.test.ts`) | T6 |
| `apps/web/app/api/incidents/route.ts`, `apps/web/app/api/incidents/[incidentId]/route.ts`, `apps/web/app/api/deployments/route.ts` (+ `api.test.ts`) | T6 |
| `apps/web/app/incidents/page.tsx`, `apps/web/src/ui/*.tsx` (list parts) | T7 |
| `apps/web/app/incidents/[incidentId]/page.tsx`, `apps/web/src/ui/evidence-timeline.tsx` | T8 |
| `apps/web/app/deployments/page.tsx`, `apps/web/app/demo/page.tsx`, `apps/web/src/ui/deploy-timeline.tsx` | T9 |
| `scripts/verify-incident-dashboard.test.mjs` | T1 (created with the read-only RED test), extended in T10 |
| `scripts/verify-incident-dashboard.mjs` | T10 |
| `README.md` (dashboard section only) | T10 |

## Tasks

### T1. Read-only ClickHouse reader

**Goal:** a ClickHouse user that can read `signalforge` and cannot write anything.

**RED.** Write `scripts/verify-incident-dashboard.test.mjs` first with one test: `dashboard_reader` cannot
insert into `incidents`. Before the users file exists, the login itself fails, so the test fails with
`Authentication failed`, not with a read-only error. Record that output. The test runs
`docker compose exec -T clickhouse clickhouse-client --user dashboard_reader --password changeme-local-only`
with an argument array, and asserts the stderr contains `READONLY` or `readonly`.

**GREEN.**
1. Create `infra/clickhouse/users.d/dashboard-reader.xml`: user `dashboard_reader`, password
   `changeme-local-only`, profile `dashboard_readonly` with `readonly = 1` and `allow_databases = signalforge`.
2. Add `../clickhouse/users.d:/etc/clickhouse-server/users.d:ro` to the `clickhouse` service volumes in
   `infra/docker/docker-compose.yml`.
3. Restart ClickHouse: `docker compose -f infra/docker/docker-compose.yml up -d clickhouse`. Do not use `-v`.
4. Re-run the test: the insert now fails with `READONLY`.
5. Also verify, by hand, that `SELECT count() FROM signalforge.incidents` succeeds as `dashboard_reader`.
   Record the result in the commit body.

**Commit:** `feat(infra): add read-only ClickHouse reader for the dashboard`

### T2. Web service scaffold and health route

**Goal:** a Next.js app that builds, runs in Compose on port 3000, and reports health without touching ClickHouse.

**RED.** Create `apps/web/src/server/health.test.ts` before the route: `GET /api/health` returns `200` and
`{"status":"ok"}`. Run `npm --prefix apps/web test`. It fails because the route module does not exist.

**GREEN.**
1. `apps/web/package.json`: Next.js (latest stable at implementation time, exact version pinned), React,
   `@clickhouse/client`, `typescript`, `tsx`, `@types/node`, `@types/react`. Scripts: `dev`, `build`,
   `start`, `test` (`tsx --test "src/**/*.test.ts" "app/**/*.test.ts"`), `typecheck` (`tsc --noEmit`).
2. `apps/web/tsconfig.json`, `.gitignore` (`node_modules`, `.next`), `.dockerignore`.
3. `apps/web/app/api/health/route.ts` returning the JSON above, `Cache-Control: no-store`.
4. `apps/web/app/layout.tsx` and a placeholder `apps/web/app/page.tsx` that redirects to `/incidents`.
5. `apps/web/Dockerfile` (`node:24-alpine`; `npm ci`, `npm run build`; runtime stage with production
   dependencies and `next start -p 3000`; `EXPOSE 3000`).
6. Replace the placeholder `web` service in `infra/docker/docker-compose.yml` with the definition in spec 6.1.
   Keep `api` unchanged.
7. Stack check: `docker compose -f infra/docker/docker-compose.yml up -d --build web`, then
   `curl -s http://localhost:3000/api/health`. Expect `{"status":"ok"}`.

**Commit:** `feat(web): scaffold read-only dashboard service and health route`

### T3. Input validation and bounded query builders

**Goal:** every value that reaches SQL is either a named parameter or rejected before it gets there.

**RED.** `validate.test.ts`: `incident_id` must be a UUID; `limit` accepts integers 1 to the cap and rejects
0, negatives, non-integers, and values above the cap (defaults: 20 for incidents, 10 for deployments, caps
100 and 50). `queries.test.ts`: each query in spec 5.2 matches the spec text exactly, contains its named
parameters, and has no other `{` placeholder or template interpolation. Both fail: the modules do not exist.

**GREEN.**
1. `validate.ts` exports `parseIncidentId(input)` and `parseLimit(input, { fallback, max })`. Each returns the
   value or throws `InvalidInput` with the field name.
2. `queries.ts` exports the seven query strings from spec 5.2 as constants, plus a `params` type for each.

**Commit:** `feat(web): validate dashboard inputs and build bounded queries`

### T4. Server-side ClickHouse client

**Goal:** one module is the only code that talks to ClickHouse, and it only runs read queries.

**RED.** `clickhouse.test.ts` with an injected fake transport: `listIncidents` sends Q1 with the given limit;
`getIncident` returns `null` for no row; `listDeployments` sends Q5; `failingTraces` sends Q6 with the
deployment IDs; a transport error is rethrown as `ClickHouseUnavailable` with no SQL text in its message.
Fails: the module does not exist.

**GREEN.**
1. `clickhouse.ts` creates one `@clickhouse/client` instance from the env variables in spec 5.5, with
   `readonly: true` on the client settings and `request_timeout` of 5000 ms.
2. Exports the operations listed in the RED test. Each uses only the query constants from T3 and bound
   parameters.
3. `ClickHouseUnavailable` wraps any driver error and logs the driver message server-side only.

**Commit:** `feat(web): read incidents and deployments through the server-side ClickHouse client`

### T5. Classification, explanation, and row mapping

**Goal:** the pure rules from spec 5.3 and the field mapping from spec 5.4, with no I/O.

**RED.** `model.test.ts`:
- classification table: `succeeded` with 0 failures and no incident is `healthy`; `failing_traces >= 1` is
  `faulty`; an incident row makes it `faulty` even with 0 failures; any other status is `unknown` with the
  status value; no traffic is never `healthy`.
- explanation: exact sentence from spec 5.3 for `payments-5xx-burst-after-deployment`; the fallback sentence
  for an unknown rule.
- mapping: `deployment_version` is `null` with no matching deployment; `published_at` is `null` unless
  published; `previous_version` is `null` for an empty string.
Fails: the module does not exist.

**GREEN.** `model.ts` exports `classifyDeployment`, `explainIncident`, `toIncidentItem`, `toDeploymentItem`,
`toEvidenceItem`, all pure.

**Commit:** `feat(web): classify deployments and explain incidents`

### T6. Read-only API routes

**Goal:** the three GET routes from spec 5.4, and 405 for every other method.

**RED.** `service.test.ts` and `api.test.ts`, with the T4 client replaced by a fake:
- `GET /api/incidents` returns the spec 5.4 shape, sorted by `detected_at` descending, with `deployment_version` joined;
- `GET /api/incidents/{id}` returns `incident`, `explanation`, `deployment`, `evidence`; `404 incident_not_found`
  for no row; `400 invalid_input` for a non-UUID;
- `GET /api/deployments` returns `class`, `failing_traces`, `incident_ids`;
- `POST`, `PUT`, `PATCH`, `DELETE` on `/api/incidents` return `405` with `Allow: GET`;
- a thrown `ClickHouseUnavailable` returns `503 {"error":"clickhouse_unavailable"}` whose body contains no `SELECT`
  and no `Code:`.
Fails: the routes do not exist.

**GREEN.** `service.ts` composes T3, T4, and T5. The three `route.ts` files export `GET` only, and export
`POST`, `PUT`, `PATCH`, `DELETE` returning `405`. Responses set `Cache-Control: no-store`.

**Stack check:** with the stack running and at least one incident present, `curl -s "http://localhost:3000/api/incidents?limit=5"`
returns real rows.

**Commit:** `feat(web): add read-only incident and deployment API routes`

### T7. Incident list page

**Goal:** the list view from spec 7.1, with its three states.

**RED.** Add a test in `apps/web/src/ui/incident-list.test.tsx` (rendered with `react-dom/server`) before the
component: empty data renders "No incidents yet." and the link to `/demo`; an error state renders "ClickHouse
is unavailable." and a Refresh button; the loading state renders five skeleton rows with `aria-busy="true"`;
a loaded incident renders severity text next to a dot, and publication `pending` vs `published`. Fails: the
component does not exist.

**GREEN.**
1. `apps/web/app/globals.css` with the color tokens from spec 4 as CSS custom properties on `:root`, the rail,
   the table, and the focus ring. No external fonts.
2. `apps/web/src/ui/incident-list.tsx`, `apps/web/src/ui/shell.tsx` (rail with Incidents, Deployments, Demo).
3. `apps/web/app/incidents/page.tsx` fetches `/api/incidents` server-side through `service.ts` (not over HTTP to
   itself) and passes the result to the list component.

**Stack check:** open `http://localhost:3000/incidents` and confirm the rows match the API.

**Commit:** `feat(web): add incident list with loading, empty, and error states`

### T8. Incident detail page

**Goal:** the detail view from spec 7.2.

**RED.** `apps/web/src/ui/evidence-timeline.test.tsx`: four evidence items place one green deployment marker
and three red trace markers on a UTC axis in time order; the trace ID is truncated to 12 characters with the
full value in a `title` attribute; fewer than four items renders the warning banner with the count and no
invented marker. Fails: the component does not exist.

**GREEN.**
1. `apps/web/src/ui/evidence-timeline.tsx` (positioned SVG; no charting library).
2. `apps/web/app/incidents/[incidentId]/page.tsx`: title, summary line, explanation paragraph, deployment panel,
   timeline, and the evidence table. Links back to `/deployments` with an anchor.
3. A 404 from the service renders a not-found view with a link to `/incidents`.

**Stack check:** open the detail page for the demo incident and confirm the explanation text matches spec 5.3.

**Commit:** `feat(web): add incident detail with evidence timeline`

### T9. Deployment timeline and demo page

**Goal:** the timeline from spec 7.3 and the static demo page from spec 7.4.

**RED.** `apps/web/src/ui/deploy-timeline.test.tsx`: a faulty deployment marker is red and carries a connector to
its incident; a healthy marker is green; the footnote sentence from spec 5.3 is present; the empty state text
"No Payments deployments recorded yet." renders with a link to `/demo`. `apps/web/app/demo/page.test.tsx`: the
demo page contains the exact commands from spec 10, one per copy block, and does not call the API. Fails: the
components do not exist.

**GREEN.**
1. `apps/web/src/ui/deploy-timeline.tsx` and `apps/web/app/deployments/page.tsx` (timeline, table, footnote).
2. `apps/web/app/demo/page.tsx` renders the spec 10 commands as static text.

**Stack check:** open `/deployments` after the demo flow and confirm `0.2.0-faulty` is red and linked.

**Commit:** `feat(web): add deployment timeline and demo page`

### T10. Acceptance script and demo documentation

**Goal:** the acceptance script from spec 8.3, and the demo section of the README.

**RED.** `scripts/verify-incident-dashboard.test.mjs` tests the script's pure helpers first: the step list,
the `405` method check, the `SELECT`/`Code:` body scan, and the deadline helper. Fails: the script does not
exist. Then run the script itself against the stack with no incident present. It must exit non-zero at step 2
with `no incidents`, which is the expected RED for an empty stack.

**GREEN.**
1. `scripts/verify-incident-dashboard.mjs` implements the nine steps from spec 8.3. It uses `fetch` with
   `AbortSignal.timeout(5000)` per request and a 60 s overall deadline. It reads only, and exits 0 only if every
   step passes, printing one line per step.
2. `README.md`: a "Faulty deployment dashboard" section containing the spec 10 demo flow verbatim, and the
   acceptance command `node scripts/verify-incident-dashboard.mjs`.

**Commit:** `test: add incident dashboard acceptance script and demo documentation`

### T11. Final validation and cleanup

1. Run the four validation commands in the header. All must exit 0.
2. Run `node scripts/verify-incident-dashboard.mjs` twice against the stack after one faulty demo run. Both exit 0.
3. Capture the three screenshots in spec 9 (A, B, C) for review. Screenshots are not committed.
4. `docker compose -f infra/docker/docker-compose.yml down` (no `-v`). Confirm no `signalforge` containers or
   networks remain.
5. `git status` must show no unowned files.

No commit in this task unless validation found a defect, in which case that defect gets its own RED→GREEN
commit before this task closes.

## Acceptance (the final script)

`node scripts/verify-incident-dashboard.mjs` exits 0 when all of the following hold on the running stack:

1. `/api/health` is `200`.
2. `/api/incidents` returns at least one incident, sorted newest first.
3. The newest incident has exactly four evidence rows, one `deployment` and three `trace`, all `high`.
4. Its deployment is classified `faulty` in `/api/deployments`, with its ID in `incident_ids`.
5. `POST`, `PUT`, `PATCH`, and `DELETE` to `/api/incidents` each return `405`.
6. `dashboard_reader` cannot insert into `incidents` or `deployments` (error mentions `READONLY`).
7. `/incidents` returns `200` and contains the newest incident's title.
8. No response body contains `SELECT` or `Code:`.

## Self-review

- Every route, field, and variable in this plan appears in the spec. No task introduces a contract the spec
  does not define.
- Each task names its RED test and the reason it fails before the change.
- The only Compose changes are the ClickHouse volume (T1) and the `web` service (T2). `api` is untouched.
- The validation commands match the existing repository commands (`npm --prefix`, `node --test`,
  `docker compose config`).
- Commit messages follow the repository's `type(scope): summary` pattern.
