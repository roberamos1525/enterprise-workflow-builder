import type { RunRecord, StepRecord } from "@ewb/engine";
import { describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { SqliteRunStore } from "./run-store.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.migrate();
  return db;
}

const run = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  workflowId: "wf",
  version: 1,
  status: "running",
  trigger: { type: "manual", meta: { by: "x" } },
  input: { a: [1, 2] },
  vars: {},
  output: null,
  error: null,
  parentRunId: null,
  parentNodeId: null,
  depth: 0,
  createdBy: null,
  createdAt: 1000,
  updatedAt: 1000,
  finishedAt: null,
  deadlineAt: null,
  ...extra,
});

const step = (runId: string, nodeId: string, extra: Partial<StepRecord> = {}): StepRecord => ({
  runId,
  nodeId,
  nodeType: "action.transform",
  status: "running",
  attempt: 1,
  port: null,
  input: { x: 1 },
  output: null,
  error: null,
  state: null,
  wakeAt: null,
  wakeReason: null,
  pendingEvent: null,
  startedAt: 1000,
  finishedAt: null,
  updatedAt: 1000,
  ...extra,
});

describe("Database", () => {
  it("applies migrations once and records them", () => {
    const db = new Database(":memory:");
    expect(db.migrate()).toEqual(MIGRATIONS.map((m) => `${m.version}_${m.name}`));
    expect(db.migrate()).toEqual([]);
    expect(db.all<{ version: number }>("SELECT version FROM schema_migrations")).toHaveLength(MIGRATIONS.length);
  });

  it("supports nested transactions with savepoint rollback", () => {
    const db = freshDb();
    const insert = (id: string) =>
      db.run("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, 'n', 'viewer', 'h', 0)", id, `${id}@x`);
    db.transaction(() => {
      insert("outer");
      expect(() =>
        db.transaction(() => {
          insert("inner");
          throw new Error("inner failure");
        }),
      ).toThrow("inner failure");
      insert("after");
    });
    expect(db.all<{ id: string }>("SELECT id FROM users ORDER BY id").map((r) => r.id)).toEqual(["after", "outer"]);
    expect(() => db.transaction(() => { insert("doomed"); throw new Error("outer failure"); })).toThrow();
    expect(db.get("SELECT 1 FROM users WHERE id = 'doomed'")).toBeUndefined();
  });

  it("enforces schema constraints", () => {
    const db = freshDb();
    expect(() => db.run("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES ('u', 'e', 'n', 'superuser', 'h', 0)")).toThrow(/CHECK/);
  });
});

describe("SqliteRunStore", () => {
  it("round-trips runs and steps including JSON columns", () => {
    const store = new SqliteRunStore(freshDb());
    store.insertRun(run("r1"));
    store.saveStep(step("r1", "a", { state: { approvalId: "x" }, pendingEvent: { kind: "signal", payload: { ok: true } } }));
    const updated = { ...run("r1"), status: "succeeded" as const, output: { done: true }, vars: { v: 1 }, finishedAt: 2000 };
    store.updateRun(updated);
    store.saveStep(step("r1", "a", { status: "succeeded", port: "out", output: [1, "two"], finishedAt: 2000 }));
    expect(store.getRun("r1")).toEqual(updated);
    expect(store.getStep("r1", "a")).toMatchObject({ status: "succeeded", port: "out", output: [1, "two"], state: null, pendingEvent: null });
    expect(store.listSteps("r1")).toHaveLength(1);
    expect(store.getRun("nope")).toBeUndefined();
  });

  it("lists active runs, children and events", () => {
    const store = new SqliteRunStore(freshDb());
    store.insertRun(run("p"));
    store.insertRun(run("c", { parentRunId: "p", parentNodeId: "sub", status: "waiting" }));
    store.insertRun(run("done", { status: "failed" }));
    store.appendEvent({ runId: "p", nodeId: null, type: "run.started", at: 1 });
    store.appendEvent({ runId: "p", nodeId: "x", type: "step.started", at: 2, data: { attempt: 1 } });
    expect(store.listActiveRuns().map((r) => r.id).sort()).toEqual(["c", "p"]);
    expect(store.findChildRuns("p").map((r) => r.id)).toEqual(["c"]);
    expect(store.listEvents("p")).toEqual([
      { runId: "p", nodeId: null, type: "run.started", at: 1, data: {} },
      { runId: "p", nodeId: "x", type: "step.started", at: 2, data: { attempt: 1 } },
    ]);
  });

  it("pages runs by creation time and filters by workflow/status", () => {
    const store = new SqliteRunStore(freshDb());
    for (let i = 0; i < 5; i++) store.insertRun(run(`r${i}`, { createdAt: 1000 + i, workflowId: i % 2 ? "odd" : "even", status: i === 4 ? "failed" : "succeeded" }));
    expect(store.queryRuns({ limit: 2 }).map((r) => r.id)).toEqual(["r4", "r3"]);
    expect(store.queryRuns({ limit: 10, before: 1003 }).map((r) => r.id)).toEqual(["r2", "r1", "r0"]);
    expect(store.queryRuns({ limit: 10, workflowIds: ["odd"] }).map((r) => r.id)).toEqual(["r3", "r1"]);
    expect(store.queryRuns({ limit: 10, status: "failed" }).map((r) => r.id)).toEqual(["r4"]);
    expect(store.queryRuns({ limit: 10, workflowIds: [] })).toEqual([]);
  });

  it("computes dashboard statistics", () => {
    const store = new SqliteRunStore(freshDb());
    const day = Date.UTC(2026, 5, 10);
    const durations = [100, 200, 300, 400, 1000];
    durations.forEach((d, i) => store.insertRun(run(`ok${i}`, { status: "succeeded", createdAt: day + i, finishedAt: day + i + d })));
    store.insertRun(run("bad", { status: "failed", createdAt: day - 86_400_000, finishedAt: day }));
    store.insertRun(run("live", { status: "running", createdAt: day + 10 }));
    store.insertRun(run("child", { status: "succeeded", createdAt: day, finishedAt: day + 5, parentRunId: "ok0" }));
    const stats = store.stats(undefined, day - 86_400_000, day + 1000);
    expect(stats).toMatchObject({
      total: 7,
      byStatus: { succeeded: 5, failed: 1, running: 1 },
      successRate: 5 / 6,
      avgDurationMs: 400,
      p50DurationMs: 300,
      p95DurationMs: 1000,
    });
    expect(stats.perDay).toEqual([
      { day: "2026-06-09", succeeded: 0, failed: 1, other: 0 },
      { day: "2026-06-10", succeeded: 5, failed: 0, other: 1 },
    ]);
    expect(stats.byWorkflow).toEqual([{ workflowId: "wf", total: 7, succeeded: 5, failed: 1 }]);
    expect(store.stats([], 0, 1).total).toBe(0);
  });
});
