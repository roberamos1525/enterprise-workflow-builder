# Data model

The SQLite schema is defined in `apps/server/src/db/migrations.ts` and applied by `Database.migrate()`. Applied
migrations are tracked in `schema_migrations`. The database runs in WAL mode with foreign keys enabled.

| Table | Key | Purpose |
| --- | --- | --- |
| `users` | `id` | `email` (unique, case-insensitive), `name`, `role` (CHECK admin/editor/operator/viewer), scrypt `password_hash`, `disabled` |
| `workflows` | `id` (`wf_` + 12 hex) | `name`, `description`, mutable `draft` (JSON), `draft_revision` (optimistic concurrency), `published_version`, `webhook_secret`, `archived` |
| `workflow_versions` | (`workflow_id`, `version`) | immutable `definition` JSON, `checksum` (sha256 prefix), `notes`, `published_by`, `published_at` |
| `workflow_acl` | (`workflow_id`, `user_id`) | `role` editor/operator/viewer |
| `triggers` | `workflow_id` | trigger of the published version: `type`, `event_type`, `cron`, `enabled`, `next_fire_at`, `last_fired_at` (scheduler state) |
| `runs` | `id` (UUID) | pinned `version`, `status`, `trigger` JSON, `input`, `vars`, `output`, `error`, `parent_run_id`/`parent_node_id`, `depth`, timestamps, `deadline_at` |
| `steps` | (`run_id`, `node_id`) | engine step record (see [execution-engine.md](execution-engine.md)) |
| `run_events` | autoincrement `id` | append-only timeline per run |
| `approvals` | `id`; unique (`run_id`, `node_id`) | `title`, `description`, `assignees` JSON, `status` (pending/approved/rejected/timed_out/cancelled), `level` (escalations), `due_at`, decision fields |
| `notifications` | `id` | per-user in-app notifications: `kind`, `title`, `body`, `link`, `read_at` |
| `webhook_receipts` | (`workflow_id`, `idempotency_key`) | deduplicates webhook deliveries |
| `events` | `id` | audit of published events and the runs they started |

Indexes: `runs(workflow_id, created_at DESC)`, `runs(status)`, `runs(parent_run_id)`, `run_events(run_id, id)`,
`approvals(status)`, `notifications(user_id, created_at DESC)`, `triggers(type, event_type)`.

## Lifecycle

1. **Create** — the draft starts with a manual trigger (or the definition supplied), `draft_revision = 1`, and the
   creator gets an `editor` ACL entry. A random 24-byte webhook secret is generated.
2. **Edit** — `PUT` with the current `revision`. The update is conditional (`WHERE draft_revision = ?`), so concurrent
   editors get a 409 instead of overwriting each other. Drafts may be invalid; only structural problems are rejected.
3. **Publish** — the draft must validate without errors and differ from the latest version, and its sub-workflow targets
   must exist. A new `workflow_versions` row is inserted, `published_version` is moved, and the `triggers` row is
   upserted. All of this happens in one transaction. Versions are never updated or deleted.
4. **Run** — runs reference `(workflow_id, version)`. Definitions are cached in memory because versions are immutable.
5. **Archive** — `archived = 1` and the trigger is disabled. Runs and versions are kept.

## JSON columns

Definitions, inputs, outputs, vars, errors, handler state and event data are stored as JSON text. The engine never
mutates the objects it reads: `MemoryRunStore` deep-copies, and `SqliteRunStore` parses fresh copies. Tests therefore
behave the same against both stores.
