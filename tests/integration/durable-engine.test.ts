import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHandlers,
  ManualClock,
  MemoryDefinitions,
  WorkflowEngine,
  type ApprovalHost,
  type HttpResponse,
  type RunRecord,
  type WorkflowDefinition,
} from "@ewb/engine";
import { describe, expect, it } from "vitest";
import { Database } from "../../apps/server/src/db/database.js";
import { SqliteRunStore } from "../../apps/server/src/db/run-store.js";
import { def, e, n, tempDbPath } from "../helpers.js";

/**
 * Crash-consistency check: the same workflow is executed once without
 * interruption and then, for every k, "killed" after k persisted events and
 * resumed by a brand-new engine (new Database handle, new store) over the
 * same SQLite file. Every interrupted execution must reach the same result.
 */

const workflow: WorkflowDefinition = def(
  [
    n("start", "trigger.manual"),
    n("fan", "action.setVariable", { name: "count", expression: "len(trigger.items)" }),
    n("a", "action.http", { url: "https://a.example/{{ trigger.items[0] }}" }, { retry: { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 10_000 } }),
    n("b", "action.delay", { durationMs: 5000 }),
    n("c", "action.transform", { expression: "map(trigger.items, i => upper(i))" }),
    n("join", "flow.join", { mode: "all" }),
    n("check", "flow.branch", { condition: "vars.count > 1" }),
    n("approve", "action.approval", { title: "ok?", assignees: ["role:admin"] }),
    n("result", "action.setVariable", { name: "summary", expression: "{ upper: steps.c.output, http: steps.a.output.body.n, decision: input.decision }" }),
    n("small", "action.setVariable", { name: "summary", expression: "'small'" }),
  ],
  [e("start", "fan"), e("fan", "a"), e("fan", "b"), e("fan", "c"), e("a.success", "join"), e("b", "join"), e("c", "join"), e("join", "check"), e("check.true", "approve"), e("approve.approved", "result"), e("check.false", "small")],
);

class Approvals implements ApprovalHost {
  ids = new Map<string, string>();
  create(req: { runId: string; nodeId: string }) {
    const key = `${req.runId}/${req.nodeId}`;
    if (!this.ids.has(key)) this.ids.set(key, `ap-${this.ids.size + 1}`);
    return this.ids.get(key)!;
  }
  escalate() {}
  close() {}
}

interface World {
  path: string;
  clock: ManualClock;
  definitions: MemoryDefinitions;
  approvals: Approvals;
  httpCalls: number;
  ids: number;
}

function boot(world: World, crashAfterEvents: number | null): { engine: WorkflowEngine; db: Database; store: SqliteRunStore; crashed: () => boolean } {
  const db = new Database(world.path);
  db.migrate();
  const store = new SqliteRunStore(db);
  let events = 0;
  let crashed = false;
  const engine = new WorkflowEngine({
    store,
    clock: world.clock,
    definitions: world.definitions,
    idGenerator: () => `run-${++world.ids}`,
    handlers: createHandlers({
      http: {
        request: async (): Promise<HttpResponse> => {
          world.httpCalls++;
          // The first call always fails with a 503 to exercise the retry path.
          if (world.httpCalls === 1) return { status: 503, headers: {}, body: "" };
          return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 7 }) };
        },
      },
      notifier: { inApp: () => ({ delivered: 0 }), webhook: async () => ({ status: 200 }) },
      approvals: world.approvals,
    }),
  });
  // Wrap appendEvent so we can "pull the plug" right after the k-th persisted transition.
  const original = store.appendEvent.bind(store);
  store.appendEvent = (event) => {
    original(event);
    events++;
    if (crashAfterEvents !== null && events === crashAfterEvents && !crashed) {
      crashed = true;
      queueMicrotask(() => engine.shutdown());
    }
  };
  return { engine, db, store, crashed: () => crashed };
}

/** Drives a run to completion, restarting the engine whenever it crashed. */
async function execute(crashAt: number | null): Promise<{ run: RunRecord; restarts: number }> {
  const path = tempDbPath();
  const world: World = { path, clock: new ManualClock(Date.parse("2026-06-01T00:00:00Z")), definitions: new MemoryDefinitions(), approvals: new Approvals(), httpCalls: 0, ids: 0 };
  world.definitions.publish("wf", workflow);
  let node = boot(world, crashAt);
  const runId = node.engine.startRun({ workflowId: "wf", input: { items: ["x", "y"] }, trigger: { type: "manual" } }).id;
  let restarts = 0;
  for (let guard = 0; guard < 50; guard++) {
    await node.engine.idle();
    if (node.crashed() || node.engine.isStopped) {
      node.engine.shutdown();
      node.db.close();
      node = boot(world, null);
      node.engine.recover();
      restarts++;
      await node.engine.idle();
    }
    const run = node.store.getRun(runId)!;
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
      node.db.close();
      rmSync(dirname(path), { recursive: true, force: true });
      return { run, restarts };
    }
    const approve = node.store.getStep(runId, "approve");
    if (approve?.status === "waiting") node.engine.signal(runId, "approve", { decision: "approved", by: "admin" });
    else world.clock.advance(1000);
  }
  throw new Error("run did not finish");
}

describe("durable execution over SQLite", () => {
  it("produces the same result no matter where the process is killed", async () => {
    const baseline = await execute(null);
    expect(baseline.run.status).toBe("succeeded");
    expect(baseline.run.output).toEqual({ count: 2, summary: { upper: ["X", "Y"], http: 7, decision: "approved" } });

    let interrupted = 0;
    for (let k = 1; k <= 30; k++) {
      const result = await execute(k);
      expect(result.run.status, `crash after event ${k}`).toBe("succeeded");
      expect(result.run.output, `crash after event ${k}`).toEqual(baseline.run.output);
      interrupted += result.restarts;
    }
    expect(interrupted).toBeGreaterThanOrEqual(25);
  });
});
