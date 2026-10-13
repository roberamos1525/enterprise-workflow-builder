# HTTP API

Base path: `/api`. JSON in and out (`Content-Type: application/json` is required for request bodies). Authenticate with
`Authorization: Bearer <token>` from `POST /api/auth/login`, except where noted.

Errors always use this envelope:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "the draft has validation errors", "details": [ … ], "requestId": "…" } }
```

| Status | Codes |
| --- | --- |
| 400 | `BAD_REQUEST` (zod details as `[{ path, message }]`, malformed JSON) |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` (also returned when the caller has no access to a workflow) |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CONFLICT`, `NOT_WAITING`, `ALREADY_FINISHED`, `NOT_PUBLISHED`, `NOT_WEBHOOK` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_FAILED`, `INVALID_INPUT`, `INVALID_DEFINITION` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 500 | `INTERNAL` (no internals leaked; logged with the request ID) |

Roles: `viewer` < `operator` < `editor` < `admin`. "Workflow role" means the effective role on that workflow: the lower
of the global role and the ACL entry, with admins always allowed.

## System

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | none | `{ "status": "ok" }`, or 503 while starting |
| GET | `/metrics` | none | Prometheus text format |
| GET | `/api/catalog` | any | node types (ports, fields, defaults) and expression functions |
| GET | `/api/stream` | any | Server-Sent Events: `hello`, `run` (run/step events for visible workflows), `notification` |

## Auth & users

| Method | Path | Role | Body / notes |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | none | `{ email, password }` → `{ token, expiresIn, user }`; rate limited per IP |
| GET | `/api/auth/me` | any | current user |
| GET | `/api/users` | editor+ | admins get full records; editors get identities (for sharing) |
| POST | `/api/users` | admin | `{ email, name, role, password(≥8) }` → 201 |
| PATCH | `/api/users/:id` | admin | `{ name?, role?, disabled?, password? }`; you cannot demote or disable yourself |

## Workflows

| Method | Path | Workflow role | Notes |
| --- | --- | --- | --- |
| GET | `/api/workflows` | — | workflows visible to the caller, with `myRole` |
| POST | `/api/workflows` | global editor | `{ name, description?, definition? }`; the creator gets an `editor` ACL entry |
| GET | `/api/workflows/:id` | viewer | draft, `draftRevision`, `publishedVersion`, `validation`, `webhook.path`, and `webhook.secret` for editors |
| PUT | `/api/workflows/:id` | editor | `{ revision, name?, description?, definition? }`; 409 with `details.currentRevision` if stale |
| DELETE | `/api/workflows/:id` | editor | archive (disables triggers) → 204 |
| POST | `/api/workflows/:id/validate` | viewer | `{ definition? }` → `{ valid, issues[] }` (defaults to the current draft) |
| POST | `/api/workflows/:id/publish` | editor | `{ notes? }` → 201 version info; 422 with issues if invalid; 409 if identical to the latest version |
| GET | `/api/workflows/:id/versions` | viewer | newest first |
| GET | `/api/workflows/:id/versions/:v` | viewer | includes the immutable `definition` |
| GET | `/api/workflows/:id/diff?from=1&to=draft` | viewer | added/removed/changed/moved nodes, edges, settings |
| POST | `/api/workflows/:id/webhook/rotate` | editor | `{ secret }` |
| GET / PUT | `/api/workflows/:id/acl` | viewer / editor | PUT `{ entries: [{ userId, role: editor\|operator\|viewer }] }`; one editor must remain |
| POST | `/api/workflows/:id/runs` | operator | `{ input?, version? }` → 201 run |

### Definition format

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "start", "type": "trigger.manual", "name": "Start", "position": { "x": 0, "y": 0 }, "config": {} },
    { "id": "call", "type": "action.http", "name": "Call", "position": { "x": 260, "y": 0 },
      "config": { "method": "GET", "url": "https://api.example.com/{{ trigger.id }}" },
      "retry": { "maxAttempts": 3, "initialDelayMs": 1000, "backoffMultiplier": 2, "maxDelayMs": 30000 },
      "timeoutMs": 10000 }
  ],
  "edges": [ { "id": "e1", "source": { "node": "start", "port": "out" }, "target": { "node": "call", "port": "in" } } ],
  "variables": { "region": "eu" },
  "settings": { "maxRunDurationMs": 3600000 }
}
```

Node types, their ports and their config fields come from `GET /api/catalog`:

| Group | Types |
| --- | --- |
| Triggers | `trigger.manual`, `trigger.webhook`, `trigger.schedule`, `trigger.event` |
| Actions | `action.http`, `action.transform`, `action.delay`, `action.setVariable`, `action.notify`, `action.approval`, `action.subworkflow` |
| Flow | `flow.branch`, `flow.join`, `flow.end` |

The expression language is described in [docs/expression-language.md](docs/expression-language.md).

## Runs & dashboard

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/api/runs?workflowId&status&before&limit` | viewer of each workflow | newest first; `nextBefore` cursor |
| GET | `/api/runs/:id` | viewer | `{ run, steps[], events[], definition (pinned version), children[] }` |
| POST | `/api/runs/:id/cancel` | operator | `{ reason? }`; 409 if already finished |
| GET | `/api/metrics/summary?workflowId&days=14` | viewer | `total`, `byStatus`, `successRate`, `avg/p50/p95DurationMs`, `perDay[]`, `byWorkflow[]` (top-level runs only) |

Run statuses are `running`, `waiting`, `succeeded`, `failed` and `cancelled`. Step statuses add `skipped`.

## Approvals & notifications

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/approvals?status=pending&mine=true` | `canDecide` per item; `mine` means you are an assignee |
| GET | `/api/approvals/:id` | |
| POST | `/api/approvals/:id/decision` | `{ decision: "approved" \| "rejected", comment? }`; assignee or admin; 409 if already decided |
| GET | `/api/notifications?unread=true&limit=50` | `{ items, unread }` |
| POST | `/api/notifications/:id/read` · `/api/notifications/read-all` | |

## Triggers

### Webhook — `POST /api/hooks/:workflowId` (no JWT)

Choose one of two authentication modes:

- Shared secret: send `X-EWB-Token: <secret>`.
- HMAC: send `X-EWB-Timestamp: <epoch seconds>` and `X-EWB-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
  Requests outside ±5 minutes are rejected.

Other rules:

- Optional `Idempotency-Key` header (≤ 200 characters). A repeated key returns `200 { runId, duplicate: true }`; a new
  run returns `202 { runId, duplicate: false }`.
- The workflow's **published** version must have a webhook trigger. The body (JSON) becomes `trigger` in expressions.

### Events — `POST /api/events` (operator)

Send `{ type, payload? }`. The response is `202 { eventId, runIds[], skipped[{ workflowId, reason }] }`. Workflows whose
published trigger is `trigger.event` with a matching `eventType` and a truthy `filter` (evaluated over `event`) are
started with `trigger = { id, type, payload }`.

### Schedules

These have no endpoint. Publishing a workflow with a `trigger.schedule` node registers it, and each run receives
`trigger = { ...payload, scheduledFor }`.
