import { ManualClock } from "@ewb/engine";
import { afterEach, describe, expect, it } from "vitest";
import { createPublished, def, e, n, startStub, startTestApp, tempDbPath, type StubServer, type TestApp } from "../helpers.js";

const open: TestApp[] = [];
const stubs: StubServer[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close().catch(() => undefined);
  for (const s of stubs.splice(0)) await s.close();
});

async function boot(dbPath: string, clock: ManualClock): Promise<TestApp> {
  const t = await startTestApp({ dbPath, clock });
  open.push(t);
  return t;
}

/** Stops an app like a crashed process: the engine abandons in-flight work, DB state is left as-is. */
async function crash(t: TestApp): Promise<void> {
  open.splice(open.indexOf(t), 1);
  await t.close();
}

describe("durable execution across restarts", () => {
  it("resumes a run that was in the middle of an HTTP step when the server died", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock(Date.parse("2026-06-01T08:00:00Z"));
    const stub = await startStub();
    stubs.push(stub);
    let received!: () => void;
    const firstRequest = new Promise<void>((resolve) => (received = resolve));
    stub.handler = () => received(); // never responds: the step stays "running"

    const t1 = await boot(dbPath, clock);
    const id = await createPublished(
      t1,
      "Crashy",
      def(
        [n("s", "trigger.manual"), n("call", "action.http", { url: `${stub.url}/work` }), n("after", "action.setVariable", { name: "result", expression: "input.body.answer" })],
        [e("s", "call"), e("call.success", "after")],
      ),
    );
    const run = (await t1.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    await firstRequest;
    const before = (await t1.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(before.steps.find((s: { nodeId: string }) => s.nodeId === "call").status).toBe("running");
    await crash(t1);

    stub.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer: 42 }));
    };
    const t2 = await boot(dbPath, clock);
    await t2.settle();
    const after = (await t2.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(after.run).toMatchObject({ status: "succeeded", output: { result: 42 } });
    expect(stub.requests).toHaveLength(2);
    expect(after.events.map((ev: { type: string }) => ev.type)).toContain("run.recovered");
  });

  it("re-arms a persisted delay so the run completes after restart", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock(Date.parse("2026-06-01T08:00:00Z"));
    const t1 = await boot(dbPath, clock);
    const id = await createPublished(
      t1,
      "Sleepy",
      def([n("s", "trigger.manual"), n("wait", "action.delay", { durationMs: 600_000 }), n("done", "action.setVariable", { name: "woke", expression: "now()" })], [e("s", "wait"), e("wait", "done")]),
    );
    const run = (await t1.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    await t1.settle();
    await crash(t1);
    expect(clock.pendingTimers).toBe(0);

    const t2 = await boot(dbPath, clock);
    expect((await t2.as("operator")("GET", `/api/runs/${run.id}`)).body.run.status).toBe("waiting");
    await t2.advance(600_000);
    const detail = (await t2.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(detail.run).toMatchObject({ status: "succeeded", output: { woke: Date.parse("2026-06-01T08:10:00Z") } });
  });

  it("keeps pending approvals decidable after a restart", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock(Date.parse("2026-06-01T08:00:00Z"));
    const t1 = await boot(dbPath, clock);
    const id = await createPublished(
      t1,
      "Approve later",
      def([n("s", "trigger.manual"), n("a", "action.approval", { title: "t", assignees: ["operator@test.dev"], timeoutMs: 3_600_000 })], [e("s", "a")]),
    );
    const run = (await t1.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    await t1.settle();
    const approval = (await t1.as("operator")("GET", "/api/approvals?mine=true")).body[0];
    await crash(t1);

    const t2 = await boot(dbPath, clock);
    await t2.as("operator")("POST", `/api/approvals/${approval.id}/decision`, { decision: "rejected", comment: "after restart" });
    await t2.settle();
    const detail = (await t2.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(detail.run.status).toBe("succeeded");
    expect(detail.steps.find((s: { nodeId: string }) => s.nodeId === "a")).toMatchObject({ port: "rejected", output: { comment: "after restart" } });
    // The timeout timer was re-armed and cancelled by the decision; advancing does nothing.
    await t2.advance(3_600_000);
    expect((await t2.as("operator")("GET", `/api/runs/${run.id}`)).body.run.status).toBe("succeeded");
  });
});

describe("scheduled workflows", () => {
  const scheduleDef = (cron: string) =>
    def([n("cron", "trigger.schedule", { cron, payload: { source: "test" } }), n("v", "action.setVariable", { name: "at", expression: "trigger.scheduledFor" })], [e("cron", "v")]);

  it("fires on the cron schedule using the injected clock", async () => {
    const clock = new ManualClock(Date.parse("2026-06-01T08:00:30Z"));
    const t = await boot(tempDbPath(), clock);
    const id = await createPublished(t, "Every 15", scheduleDef("*/15 * * * *"));
    await t.advance(14 * 60_000);
    expect((await t.as("viewer")("GET", `/api/runs?workflowId=${id}`)).body.items).toHaveLength(0);
    await t.advance(60_000);
    await t.advance(30 * 60_000);
    const runs = (await t.as("viewer")("GET", `/api/runs?workflowId=${id}`)).body.items;
    expect(runs.map((r: { output: { at: string } }) => r.output.at)).toEqual(["2026-06-01T08:45:00.000Z", "2026-06-01T08:30:00.000Z", "2026-06-01T08:15:00.000Z"]);
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: { type: "schedule" }, input: { source: "test" } });
  });

  it("stops firing when archived and picks up a changed cron on republish", async () => {
    const clock = new ManualClock(Date.parse("2026-06-01T08:00:00Z"));
    const t = await boot(tempDbPath(), clock);
    const id = await createPublished(t, "Hourly", scheduleDef("0 * * * *"));
    const detail = (await t.as("editor")("GET", `/api/workflows/${id}`)).body;
    await t.as("editor")("PUT", `/api/workflows/${id}`, { revision: detail.draftRevision, definition: scheduleDef("30 8 * * *") });
    await t.as("editor")("POST", `/api/workflows/${id}/publish`, {});
    await t.advance(30 * 60_000);
    const runs = (await t.as("viewer")("GET", `/api/runs?workflowId=${id}`)).body.items;
    expect(runs).toHaveLength(1);
    expect(runs[0].version).toBe(2);
    await t.as("editor")("DELETE", `/api/workflows/${id}`);
    await t.advance(24 * 3600_000);
    expect(t.app.runs.listSchedules().find((s) => s.workflowId === id)?.enabled).toBe(false);
  });

  it("fires a missed schedule once after downtime", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock(Date.parse("2026-06-01T08:00:30Z"));
    const t1 = await boot(dbPath, clock);
    const id = await createPublished(t1, "Daily", scheduleDef("0 9 * * *"));
    await crash(t1);
    clock.advance(5 * 3600_000); // down from 08:00 until 13:00; the 09:00 run was missed
    const t2 = await boot(dbPath, clock);
    await t2.settle();
    const runs = (await t2.as("viewer")("GET", `/api/runs?workflowId=${id}`)).body.items;
    expect(runs).toHaveLength(1);
    expect(runs[0].output.at).toBe("2026-06-01T09:00:00.000Z");
    const next = t2.app.runs.listSchedules().find((s) => s.workflowId === id)!;
    expect(new Date(next.nextFireAt!).toISOString()).toBe("2026-06-02T09:00:00.000Z");
  });
});
