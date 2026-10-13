export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only list; never edit a migration that has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','operator','viewer')),
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  draft TEXT NOT NULL,
  draft_revision INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER,
  webhook_secret TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  checksum TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  published_by TEXT REFERENCES users(id),
  published_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE workflow_acl (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('editor','operator','viewer')),
  PRIMARY KEY (workflow_id, user_id)
);

CREATE TABLE triggers (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id),
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  event_type TEXT,
  cron TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at INTEGER,
  last_fired_at INTEGER
);
CREATE INDEX triggers_event ON triggers(type, event_type);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  input TEXT NOT NULL,
  vars TEXT NOT NULL,
  output TEXT,
  error TEXT,
  parent_run_id TEXT,
  parent_node_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  deadline_at INTEGER
);
CREATE INDEX runs_workflow ON runs(workflow_id, created_at DESC);
CREATE INDEX runs_status ON runs(status);
CREATE INDEX runs_parent ON runs(parent_run_id);

CREATE TABLE steps (
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  port TEXT,
  input TEXT,
  output TEXT,
  error TEXT,
  state TEXT,
  wake_at INTEGER,
  wake_reason TEXT,
  pending_event TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT
);
CREATE INDEX run_events_run ON run_events(run_id, id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignees TEXT NOT NULL,
  status TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  decided_by TEXT,
  decided_at INTEGER,
  comment TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, node_id)
);
CREATE INDEX approvals_status ON approvals(status);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE webhook_receipts (
  workflow_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, idempotency_key)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  published_by TEXT,
  run_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
];
