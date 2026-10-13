# Testing strategy

`npm test` runs Vitest with four projects, defined in `vitest.config.ts`:

| Project | Location | What it covers |
| --- | --- | --- |
| `engine` | `packages/engine/src/**/*.test.ts` | lexer/parser/evaluator, sandbox and limits, builtins, templates, a fuzz test, cron parsing and next-fire computation (checked against a brute-force reference), scheduler misfire policies, schema/graph/config validation, diff, and engine semantics (branches, joins, retries, timeouts, delays, approvals, sub-workflows, end nodes, deadlines, crash recovery) |
| `server` | `apps/server/src/**/*.test.ts` | JWT, passwords, permissions, rate limiter, config, error envelopes, CIDR math and egress policy, the SSRF-safe client against a local server, migrations and savepoints, `SqliteRunStore` and statistics, router/static hosting, services (trigger sync, webhook replay window, event filters, approvals, notifications), CLI |
| `web` | `apps/web/src/**/*.test.{ts,tsx}` | editor reducer (add/connect/delete/rename/undo), canvas geometry (zoom anchoring, hit-testing, fit, free-spot placement), API client and SSE parser, SVG rendering of the canvas, timeline, chart and diff through `react-dom/server` |
| `integration` | `tests/integration/*.test.ts` | the real HTTP server started in-process over a temporary SQLite file (`tests/helpers.ts → startTestApp`) |

## Integration scenarios

- **`api.test.ts`** covers:
  - auth and user management;
  - the workflow lifecycle: optimistic concurrency, validation errors, the publish gate, immutable versions, diff, and
    runs pinned to a version;
  - per-workflow ACL enforcement;
  - error envelopes (404/405/400/415/413);
  - health, catalog and metrics.
- **`runs.test.ts`** covers:
  - a webhook-triggered run with a branch, three parallel actions (set variable, HTTP call to a local stub, approval)
    and a join, approved through the API;
  - HMAC and token auth, the replay window, idempotency keys, and the false branch;
  - retries with backoff on the fake clock, SSRF blocking with a failure notification, event triggers with filters,
    sub-workflows, cancellation, dashboard statistics and pagination;
  - SSE streaming, approval escalation and timeout, and webhook notifications.
- **`recovery.test.ts`** restarts the whole application over the same database:
  - in the middle of an HTTP step (the stub holds the first request open);
  - during a delay;
  - with a pending approval.

  It also checks cron firing, republishing a changed cron, archiving, and the catch-up run after downtime.
- **`durable-engine.test.ts`** is a crash-consistency check. A workflow with fan-out, a retry, a delay, a join, a branch
  and an approval is executed once without interruption. It is then executed 30 more times, each time stopped right after
  the k-th persisted event and resumed by a new `WorkflowEngine` over a new SQLite connection to the same file. Every
  variant must reach the same output.

## Determinism rules

- There are **no sleeps** and no real timers in tests. Everything time-related (delays, retries, timeouts, schedules,
  approval timeouts, run deadlines, JWT expiry, webhook timestamps, rate-limit windows) uses an injected `Clock`.
  `ManualClock.advance()` fires due timers in chronological order, including timers armed by those callbacks.
- Async completion is awaited with `engine.idle()` (all in-flight step executions settled). Network-dependent tests
  wait on deferred promises that resolve when the stub actually receives a request.
- Randomised tests use a seeded PRNG (mulberry32).
- Each integration test file gets its own temporary database and ephemeral port, so the projects run in parallel safely.

The full suite was run three consecutive times with identical results; the counts are recorded in the README and the
CHANGELOG.

## Running subsets

```bash
npx vitest run --project engine
npx vitest run tests/integration/recovery.test.ts
npx vitest run -t "approval"
```
