# Enterprise Workflow Builder

A visual workflow system: design workflows on an SVG canvas, publish immutable versions, and run them on a
durable execution engine that survives restarts. Workflows are triggered manually, by signed webhooks, by
cron schedules or by events, and can call HTTP APIs (with SSRF protection), transform data with a sandboxed
expression language, wait for human approvals with escalation, and call other workflows.

The project is an npm-workspaces monorepo written in strict TypeScript:

| Package | Purpose |
| --- | --- |
| `packages/engine` (`@ewb/engine`) | Pure TypeScript core with no runtime dependencies: definition model and node catalog, schema + graph validation, version diff, expression language (tokenizer, Pratt parser, sandboxed evaluator), cron parser and scheduler, durable execution engine. |
| `apps/server` (`@ewb/server`) | Node.js HTTP API on `node:http` with SQLite persistence (`node:sqlite`) and migrations. Also covers JWT auth, roles and per-workflow ACLs, triggers, approvals, notifications, an SSRF-safe HTTP client, live updates over SSE, Prometheus metrics and a CLI. |
| `apps/web` (`@ewb/web`) | React 19 + Vite single-page app. It has its own SVG canvas editor plus pages for runs, run timelines, the dashboard, approvals and user management. |

## Implemented functionality

- **Workflow model**: nodes, edges and typed ports (`any`, `object`, `http`, `decision`, `error`). The catalog has 14 node
  types (4 triggers, 7 actions and 3 flow nodes), and field specs drive both validation and the editor's config forms.
- **Validation**:
  - Structural schema checks and size limits.
  - Graph rules: exactly one trigger, no cycles, no self-loops, no unreachable nodes, no dangling or duplicate edges,
    no unknown ports, and no incompatible port types.
  - Per-field config checks: required fields, expression/template syntax, cron syntax, URLs, numeric ranges and selects.
  - Expression reference checks: `steps.X` must exist, and it is flagged when it is not upstream.
  - The same validator runs in the browser (live) and on the server (publish gate).
- **Visual editor** (own SVG canvas, no diagram library):
  - Add nodes by dragging from the palette or clicking.
  - Drag nodes with grid snapping.
  - Connect ports by dragging from an output to an input. Cycles, duplicates and type mismatches are rejected with a reason.
  - Pan by dragging the background, zoom with the wheel around the cursor, and fit to content.
  - Select and delete nodes or edges (Delete key). Undo/redo (Ctrl+Z / Ctrl+Y).
  - A config panel with per-field validation errors and live expression syntax feedback. Schedule nodes show a cron
    description and the next fire times.
  - Error badges on nodes. Save (Ctrl+S, with optimistic concurrency), publish, run, and live run status overlaid on the
    canvas.
- **Triggers**:
  - Manual (UI/API, with optional required payload fields).
  - Webhook: shared-secret header or HMAC-SHA256 signature with a 5-minute timestamp window, idempotency keys and per-IP
    rate limiting.
  - Schedule: own 5-field cron parser with ranges, steps, lists, month/day names, macros and Vixie-style day-of-month OR
    day-of-week matching, evaluated in UTC. The persistent scheduler applies a misfire policy after downtime.
  - Event: `POST /api/events` with an optional filter expression per subscriber.
- **Actions**:
  - HTTP request: templated URL, headers and body. Private, loopback and link-local destinations are blocked by default;
    an allow-list overrides this. DNS answers are pinned and every redirect is re-validated.
  - Transform (expression language).
  - Delay: a duration or an absolute timestamp; it is durable.
  - Set variable.
  - Notification: in-app to users or roles, or a webhook POST.
  - Approval: assignees, approve or reject with a comment, timeout, and one level of escalation.
  - Sub-workflow: runs the published version of another workflow and waits for it.
- **Execution engine**:
  - Every step transition is persisted before work continues.
  - Conditional branches, with dead-path propagation so joins never deadlock.
  - Parallel fan-out and `all`/`any` joins.
  - Retries with exponential backoff, and per-attempt timeouts that abort the step through an `AbortSignal`.
  - Error ports for handled failures, and an `End` node for early success or failure.
  - A run-level maximum duration.
  - Crash recovery: `recover()` re-executes in-flight steps, replays accepted signals and re-arms timers.
  - An injectable clock throughout.
- **Versioning**: a mutable draft with a revision number (optimistic concurrency) and immutable published versions with
  checksums and notes. You can diff any two refs (`1`, `2`, `draft`), and runs are pinned to the version they started on.
- **Approvals**:
  - An inbox with a "mine" filter. Assignees are emails or `role:<role>`.
  - Approve or reject with a comment.
  - A timeout escalates to extra assignees, then times out through the `timeout` port.
  - Approvals are closed automatically when a run is cancelled.
- **Permissions**:
  - Users have global roles: admin, editor, operator or viewer.
  - A per-workflow ACL grants editor, operator or viewer. Effective access is the lower of the global role and the ACL
    entry; admins bypass the ACL.
  - JWT auth (HS256) with scrypt password hashing.
- **Dashboard**: a runs list with filters and pagination, a run detail page with a Gantt-style step timeline, an event log
  and step inputs/outputs, success rate, average/p50/p95 duration, runs per day and per-workflow breakdowns.
- **Notifications**: in-app (with a live bell over SSE) and webhook. The system creates them automatically for approval
  requests and escalations and for failed runs.
- **Operations**: structured JSON logs, a Prometheus `/metrics` endpoint, `/api/health`, configuration through
  environment variables or a JSON file (validated with zod), graceful shutdown, and a CLI (`migrate`, `create-user`,
  `seed`, `validate`, `cron`).

## Technology stack

TypeScript 5.9 (strict), Node.js ≥ 22.13 (developed on Node 25), `node:sqlite`, zod 4, React 19, Vite 8, Vitest 4,
ESLint 9 + typescript-eslint. There are no native modules and no external services; the server's only runtime
dependency is zod.

## Quick start

```bash
npm install
npm run build                       # engine + server (tsc) and web (vite build)
npm run cli -- seed                 # demo users (password Passw0rd!demo) + 3 sample workflows
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
NODE_ENV=production WEB_DIST=apps/web/dist npm start
# open http://127.0.0.1:4000 and sign in as editor@example.com / Passw0rd!demo
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for development mode (Vite dev server + API), configuration and a walkthrough.
The full endpoint reference is in [API.md](API.md), and the design is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration

Environment variables override an optional JSON file (`EWB_CONFIG=path.json`, camelCase keys), which overrides defaults.
All values are validated at startup. The complete list is in [.env.example](.env.example). The most important ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | |
| `DATABASE_PATH` | `var/ewb.db` | SQLite file (WAL mode). |
| `JWT_SECRET` | random per process in development | **Required** in production (≥ 32 chars). |
| `WEB_DIST` | unset | Serve the built SPA from the API server. |
| `HTTP_ALLOW_LIST` | empty | Hostnames (`api.corp`, `*.corp.example`), IPs or CIDRs that the HTTP action may reach even if private. |
| `HTTP_ALLOW_PRIVATE` | `false` | Disables the private-range block entirely (development only). |
| `STEP_TIMEOUT_MS` | `300000` | Default per-attempt timeout. |
| `SCHEDULER_MISFIRE` | `fire_once` | `fire_once` or `skip` for schedules missed during downtime. |

## Testing

```bash
npm test            # vitest: engine, server, web and integration projects
npm run typecheck   # tsc for all packages and test files
npm run lint        # eslint
```

The suite has 291 tests in 21 files (engine 161, server 66, web 28, integration 36) and takes about 4 s on the development
machine. It includes:

- Engine unit tests (expressions, cron, scheduler, validation, diff, runtime).
- Server unit tests (auth, SSRF client, database, router, services, CLI).
- Web tests (editor reducer, geometry, API client, SSE parser, SVG rendering).
- Integration tests that start the real HTTP server in-process over a temporary SQLite database.

Highlights:

- `tests/integration/durable-engine.test.ts` kills the engine after each of the first 30 persisted transitions of a
  workflow that has parallel branches, a retry, a delay and an approval. It then builds a new engine over the same SQLite
  file and asserts that the final output is identical.
- `tests/integration/recovery.test.ts` restarts the whole server in the middle of an HTTP step, during a delay and while
  an approval is pending. It also checks that cron schedules fire, pick up changes when republished and fire once after
  downtime.
- No test uses sleeps. Time is driven by `ManualClock`, and async work is awaited through `engine.idle()`.

More detail is in [docs/testing.md](docs/testing.md).

## Deployment

`Dockerfile` (multi-stage, non-root, health check) and `compose.yaml` are provided. **They were written carefully but
have not been built or run locally, because Docker is not installed on the development machine.** For a bare-metal
deployment, run `npm ci && npm run build`, then `node apps/server/dist/index.js` with `NODE_ENV=production`,
`JWT_SECRET`, `DATABASE_PATH` and `WEB_DIST` set. The operations runbook is in [docs/operations.md](docs/operations.md).
The CI workflow in `.github/workflows/ci.yml` runs typecheck, lint, tests and build; it exists only as a local file and
has not been run on GitHub.

## Limitations

- **Single process.** The engine keeps timers in memory and relies on SQLite's single writer. Running several server
  instances against one database is not supported: there is no leader election or distributed locking.
- **At-least-once steps.** A step that was running when the process died is executed again on recovery. HTTP calls
  should therefore be idempotent; the webhook trigger's `Idempotency-Key` helps on the inbound side.
- **Schedules use UTC only.** Time zones and DST rules are not implemented, and neither are seconds or `L`/`W`/`#`
  cron extensions.
- **Graph limits.** Workflows are DAGs; loops and "for each" iteration nodes are not supported (use `map()` in
  expressions instead). Each node runs at most once per run.
- **Approvals** support one escalation level. Delegation and quorum (n-of-m) approvals are not implemented.
- **Notifications** are in-app and webhook only; there is no email or SMS.
- **No browser E2E suite in the repo.** The UI was exercised manually through a headless-Chrome (CDP) script that is not
  part of the repository. Web unit tests cover the editor reducer, geometry, API client and SVG rendering.
- **Auth.** There is no refresh-token rotation or token revocation (tokens expire after `JWT_TTL_SECONDS`), and no
  SSO/OIDC. The SSE stream is authenticated with a bearer header over `fetch`, so it is not available to plain
  `EventSource` clients.
- **Retention.** There is no archival or retention policy for runs and events yet.
- **Not verified:** Docker images and compose, GitHub Actions, and browsers other than Chrome.

## Roadmap

- Time-zone-aware schedules and cron seconds.
- Loop/map nodes and a manual retry or resume of failed runs from a chosen step.
- Multi-instance execution with a lease table, and a Postgres adapter for `RunStore`.
- Retention jobs and run archival, plus export/import of workflows as JSON from the UI.
- Email notification channel, approval delegation and n-of-m approvals.
- OIDC login and API tokens for service accounts.

## AI-assisted development

This project was developed with AI assistance (Claude by Anthropic). The design, code, tests and documentation were
produced in an AI-assisted workflow. They were reviewed and verified by running the full test suite (three consecutive
passing runs), typecheck, lint and the production build. The verification also included a curl smoke test against the
production-mode server and a headless-browser walkthrough of the editor. Claims in this README are limited to what was
verified that way; unverified items are listed under Limitations.

## License

MIT © Robert Ramos — see [LICENSE](LICENSE).
