# Architecture

```
┌──────────────────────────── apps/web (React SPA) ────────────────────────────┐
│ Editor: SVG Canvas · ConfigPanel · Palette · Versions/Diff · Share           │
│ Runs · Run detail (timeline) · Dashboard · Approvals · Users · Bell          │
│ editor/state.ts (reducer)  editor/geometry.ts  api.ts (REST + SSE parser)    │
└───────────────▲───────────────────────────────┬──────────────────────────────┘
                │ JSON over HTTP, SSE (fetch)   │ imports @ewb/engine for live validation,
                │                               │ catalog, cron preview, expression checks
┌───────────────┴──────────── apps/server (Node) ───────────────────────────────┐
│ http.ts Router (auth, body limits, error envelope, metrics, SPA hosting)      │
│ routes.ts (zod-validated endpoints)                                           │
│ services/: workflows (drafts, versions, ACL, triggers) · runs (manual,        │
│   webhook, events, schedule store) · collaboration (approvals, notifications, │
│   LiveHub SSE) · users                                                        │
│ net/safe-http.ts (egress policy + pinned DNS)   auth.ts (JWT, scrypt, roles)  │
│ db/: Database (node:sqlite, savepoints) · migrations · SqliteRunStore         │
│ app.ts wires: WorkflowEngine + CronScheduler + services + Router              │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ interfaces: RunStore, DefinitionProvider, Clock, HttpClient,
                │ Notifier, ApprovalHost, ScheduleStore
┌───────────────┴──────────── packages/engine (pure TS) ────────────────────────┐
│ model/ types · catalog (14 node types) · validate (schema+graph) · diff       │
│ expr/  lexer → Pratt parser → AST → sandboxed evaluator · builtins · templates│
│ cron/  parser · nextFireTime · CronScheduler                                  │
│ runtime/ WorkflowEngine · handlers · Clock (System/Manual) · MemoryRunStore   │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Package boundaries

- **`@ewb/engine` has no I/O.** Everything with side effects is behind an interface: `RunStore` (persistence),
  `DefinitionProvider` (published versions), `Clock` (time and timers), `HttpClient`, `Notifier` and `ApprovalHost`. That
  is why the same engine runs in unit tests (memory store, manual clock), in integration tests (SQLite) and in production.
  The web app imports the engine too, so the editor uses exactly the validation rules the server enforces at publish time.
- **`@ewb/server`** owns persistence, security and transport. Services are plain classes over a shared `Database`. Routes
  translate HTTP to service calls and validate input with zod. Errors are typed (`AppError`, `EngineError`, `ZodError`)
  and mapped to one JSON envelope: `{ "error": { code, message, details?, requestId } }`.
- **`@ewb/web`** is presentation only. The editor state is a pure reducer (`editor/state.ts`), canvas math is pure
  functions (`editor/geometry.ts`), and both are unit-tested without a DOM.

## Execution model (summary)

A run is a set of **step records**, one per node, each persisted with its status (`running`, `waiting`, `succeeded`,
`failed`, `skipped`, `cancelled`), attempt, chosen output port, input, output, error, handler state and wake-up time. An
edge is *active* when its source finished through the edge's port, *dead* when the source finished any other way, and
*pending* otherwise. `advance()` walks nodes in topological order:

- A node whose incoming edges are all resolved starts if at least one edge is active.
- If every incoming edge is dead, the node is marked `skipped`. This is dead-path elimination, and it is why joins after
  branches never deadlock.
- An `any` join starts on the first active edge.
- When nothing is running or waiting, the run succeeds.

Handlers return an outcome:

- `complete` with a port, an output and optional vars.
- `wait` with an optional `wakeAt` and durable handler state (delays, approvals, sub-workflows).
- `end` (the End node).

Thrown errors go through the retry policy, then to the `error` port if one is connected, and otherwise fail the run,
which cancels the other branches. The engine relies on every store write being synchronous (`node:sqlite`), so each
transition is atomic with respect to the event loop. Details and the recovery algorithm are in
[docs/execution-engine.md](docs/execution-engine.md).

## Triggers

| Trigger | Entry point | Notes |
| --- | --- | --- |
| Manual | `POST /api/workflows/:id/runs` | operator access; optional explicit `version` |
| Webhook | `POST /api/hooks/:id` (no JWT) | `X-EWB-Token` or HMAC `X-EWB-Signature` + `X-EWB-Timestamp`; `Idempotency-Key`; rate limited |
| Schedule | `CronScheduler` over the `triggers` table | next fire time persisted; one clock timer for the earliest entry; misfire policy |
| Event | `POST /api/events` | subscribers looked up by `event_type`; per-workflow filter expression over `event` |

On publish, the `triggers` row of the workflow is upserted from the trigger node of the new version. A schedule keeps its
next fire time when the cron expression did not change, and the scheduler is refreshed.

## Security design

- **Authentication**: HS256 JWT signed with `JWT_SECRET`, verified against the injectable clock, and checked against the
  current user record so that disabled users are rejected immediately. Passwords are hashed with scrypt (N=16384) and
  compared in constant time; logins for unknown users still perform a hash to avoid a timing oracle.
- **Authorisation**: global roles plus a per-workflow ACL. Workflows the user cannot see return 404 (no existence leaks),
  and insufficient roles return 403. Approvals can only be decided by assignees or admins.
- **SSRF**: the HTTP action and webhook notifications resolve DNS first and block private, loopback, link-local, CGNAT,
  multicast, documentation and IPv4-mapped IPv6 ranges unless allow-listed. The vetted address is pinned for the
  connection (`lookup` override, which defeats DNS rebinding), and redirects (at most 3) are re-validated. Credentials in
  URLs are rejected and the response size is capped.
- **Expression sandbox**: there is no `eval` or `Function`. Property access is restricted to own properties of plain
  objects, arrays and strings. `__proto__`, `constructor` and `prototype` are rejected at parse time and at runtime. Only
  whitelisted builtins can be called, and lambdas cannot escape. Step, string-length, array-length, nesting and
  source-length limits apply. Host data is copied into null-prototype objects.
- **HTTP hardening**: body size limits (413), JSON content-type enforcement (415), security headers, a CSP on the SPA
  HTML, `no-store` on API responses, request IDs, and rate limits on login and webhooks.

## Observability

Logs are written as JSON lines and include a request ID; the level is set with `LOG_LEVEL`. `/metrics` exposes
Prometheus counters and histograms: HTTP requests by route and status, request duration, runs started by trigger, runs
finished by status, steps finished by node type, and rejected webhooks by reason. Run and step events are also persisted
(`run_events`) and streamed to clients over SSE.
