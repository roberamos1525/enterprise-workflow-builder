# Operations runbook

## Starting and stopping

```bash
NODE_ENV=production JWT_SECRET=… DATABASE_PATH=/data/ewb.db WEB_DIST=apps/web/dist node apps/server/dist/index.js
```

Startup applies pending migrations, then calls `engine.recover()` (logged as `recovered interrupted runs`), starts the cron
scheduler, and finally listens. `/api/health` returns 503 until the listener is ready.

`SIGINT`/`SIGTERM` stop the scheduler and the engine (in-flight steps are abandoned, not marked failed), close SSE
streams and connections, and close the database. The next start resumes everything. Because steps are executed at least
once, a step that was running during the shutdown runs again.

## Health and metrics

- `GET /api/health` is for liveness and readiness.
- `GET /metrics` serves Prometheus text. Useful series:
  - `ewb_runs_finished_total{status="failed"}`: the failure rate.
  - `ewb_steps_finished_total{type,status}`: which node types fail.
  - `ewb_webhook_rejected_total{reason}`: `auth`, `stale` (replay window) or `not_webhook`.
  - `ewb_http_request_duration_ms_bucket{route}`: API latency.
- Logs are JSON lines on stdout (info/debug) and stderr (warn/error), and each carries `requestId` when it relates to an
  HTTP request. The response header `x-request-id` correlates client errors with server logs.

## Backups

SQLite runs in WAL mode. For a consistent online backup:

```bash
sqlite3 /data/ewb.db ".backup /backups/ewb-$(date +%F).db"
```

Alternatively, stop the service and copy `ewb.db`, `ewb.db-wal` and `ewb.db-shm` together. Restoring means replacing
these files while the service is stopped. Runs resume on the next start.

## Common tasks

| Task | How |
| --- | --- |
| Create the first admin | `npm run cli -- create-user --email you@corp --name You --role admin --password '…'` |
| Validate a definition file | `npm run cli -- validate file.json` (exit code 1 if invalid) |
| Check a cron expression | `npm run cli -- cron "0 6 * * MON-FRI" --count 5` |
| Rotate a webhook secret | UI → Share → Rotate secret, or `POST /api/workflows/:id/webhook/rotate` |
| Stop a runaway run | `POST /api/runs/:id/cancel` (closes approvals and cancels child runs) |
| Allow an internal API | `HTTP_ALLOW_LIST=billing.internal,10.20.0.0/16` and restart |

## Troubleshooting

- **The HTTP step fails with `SSRF_BLOCKED`.** The destination resolves to a private or reserved address. Add the host
  or CIDR to `HTTP_ALLOW_LIST` if it is intended. The error message names the offending IP.
- **A webhook returns 401 "outside the allowed window".** The sender's clock is off by more than 5 minutes, or it is
  reusing an old signature.
- **A webhook returns 409 `NOT_WEBHOOK`.** The published version does not have a webhook trigger. Publish the draft.
- **A schedule did not fire during downtime.** With `SCHEDULER_MISFIRE=fire_once`, one catch-up run fires on startup
  (its `scheduledFor` is the first missed slot); with `skip`, none does. Check `triggers.next_fire_at` for the workflow.
- **A run is stuck in `waiting`.** Look at the run detail. A waiting approval needs a decision (or reaches its timeout),
  a delay waits for `wakeAt`, and a sub-workflow waits for its child run (linked under "Sub-workflow runs").
- **A user cannot see a workflow.** Check the workflow's Share panel. Access requires an ACL entry unless the user is an
  admin, and the effective role is capped by the user's global role.

## Capacity notes

The engine runs in one process. Every step transition is a small synchronous SQLite write, and a run's timeline adds
about two events per step. With no retention job yet, periodically archive old `runs`, `steps` and `run_events` rows if
the database grows large (see README → Roadmap).
