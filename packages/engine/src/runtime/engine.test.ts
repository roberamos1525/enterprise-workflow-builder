import { describe, expect, it } from "vitest";
import { branch, definition, edge, join, manual, node, setVar, transform } from "../__tests__/builders.js";
import { deferred, Harness, ok } from "../__tests__/harness.js";
import type { HttpResponse } from "./handlers.js";
import { retryDelay } from "./engine.js";
import { EngineError } from "./types.js";

const http = (id: string, url: string, extra: Parameters<typeof node>[3] = {}, config: Record<string, unknown> = {}) =>
  node(id, "action.http", { method: "GET", url, ...config }, extra);
const retry = { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 10_000 };

describe("sequential execution", () => {
  it("runs transforms and variables in order and completes with vars as output", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition(
        [manual(), setVar("total", "total", "sum(map(trigger.items, i => i.price))"), transform("label", "'total=' + vars.total"), setVar("done", "label", "steps.label.output")],
        [edge("start", "total"), edge("total", "label"), edge("label", "done")],
        { variables: { currency: "EUR" } },
      ),
    );
    const run = h.start("wf", { items: [{ price: 3 }, { price: 4 }] });
    expect(run.status).toBe("running");
    await h.settle();
    const done = h.run(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ currency: "EUR", total: 7, label: "total=7" });
    expect(h.step(run.id, "label").output).toBe("total=7");
    expect(h.eventTypes(run.id)).toEqual([
      "run.started", "step.succeeded",
      "step.started", "step.succeeded",
      "step.started", "step.succeeded",
      "step.started", "step.succeeded",
      "run.succeeded",
    ]);
    expect(h.live).toHaveLength(9);
  });

  it("completes immediately for a trigger-only workflow", () => {
    const h = new Harness();
    h.publish("wf", definition([manual()], []));
    expect(h.start("wf").status).toBe("succeeded");
  });

  it("validates trigger input and publication state", () => {
    const h = new Harness();
    h.publish("wf", definition([manual("start", { requiredFields: ["orderId"] })], []));
    expect(() => h.start("wf", {})).toThrow(/missing: orderId/);
    expect(() => h.start("wf", [1])).toThrow(/must be an object/);
    expect(() => h.start("other")).toThrow(EngineError);
    expect(() => h.engine.startRun({ workflowId: "wf", version: 9, trigger: { type: "manual" } })).toThrow(/v9 not found/);
  });

  it("refuses invalid definitions", () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), transform("a", "1 +")], [edge("start", "a")]));
    expect(() => h.start("wf")).toThrow(/definition is invalid/);
  });

  it("pins runs to the version they started with", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), transform("a", "'v1'")], [edge("start", "a")]));
    const gate = deferred<HttpResponse>();
    h.publish("wf", definition([manual(), http("a", "https://api.test/v2")], [edge("start", "a")]));
    h.http = () => gate.promise;
    const run2 = h.start("wf");
    const run1 = h.engine.startRun({ workflowId: "wf", version: 1, trigger: { type: "manual" } });
    await Promise.resolve();
    gate.resolve(ok());
    await h.settle();
    expect(h.run(run1.id)).toMatchObject({ version: 1, status: "succeeded" });
    expect(h.step(run1.id, "a").output).toBe("v1");
    expect(h.run(run2.id).version).toBe(2);
  });
});

describe("branching", () => {
  const def = definition(
    [
      manual(),
      branch("check", "trigger.amount > 1000"),
      transform("high", "'manual review'"),
      transform("high2", "steps.high.output + '!'"),
      transform("low", "'auto'"),
      transform("after", "input"),
    ],
    [edge("start", "check"), edge("check.true", "high"), edge("high", "high2"), edge("check.false", "low"), edge("high2", "after"), edge("low", "after")],
  );

  it("takes the true branch and skips the false branch", async () => {
    const h = new Harness();
    h.publish("wf", def);
    const run = h.start("wf", { amount: 5000 });
    await h.settle();
    expect(h.statuses(run.id)).toEqual({ start: "succeeded", check: "succeeded", high: "succeeded", high2: "succeeded", low: "skipped", after: "succeeded" });
    expect(h.step(run.id, "check").port).toBe("true");
    expect(h.step(run.id, "after").output).toBe("manual review!");
  });

  it("propagates skips down the untaken path", async () => {
    const h = new Harness();
    h.publish("wf", def);
    const run = h.start("wf", { amount: 10 });
    await h.settle();
    expect(h.statuses(run.id)).toMatchObject({ high: "skipped", high2: "skipped", low: "succeeded", after: "succeeded" });
    expect(h.step(run.id, "after").input).toBe("auto");
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("fails the step (not the engine) on expression errors", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), branch("check", "trigger.amount > 'x'")], [edge("start", "check")]));
    const run = h.start("wf", { amount: 1 });
    await h.settle();
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: { code: "EXPRESSION_ERROR", nodeId: "check" } });
  });
});

describe("parallel fan-out and join", () => {
  const parallel = (mode: "all" | "any") =>
    definition(
      [manual(), http("a", "https://a.test"), http("b", "https://b.test"), http("c", "https://c.test"), join("merge", mode), transform("sum", "input")],
      [edge("start", "a"), edge("start", "b"), edge("start", "c"), edge("a.success", "merge"), edge("b.success", "merge"), edge("c.success", "merge"), edge("merge", "sum")],
    );

  it("runs branches concurrently and joins when all have finished", async () => {
    const h = new Harness();
    h.publish("wf", parallel("all"));
    const gates = new Map<string, ReturnType<typeof deferred<HttpResponse>>>();
    h.http = (req) => {
      const d = deferred<HttpResponse>();
      gates.set(req.url, d);
      return d.promise;
    };
    const run = h.start("wf");
    await Promise.resolve();
    await Promise.resolve();
    expect([...gates.keys()].sort()).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
    expect(h.statuses(run.id)).toMatchObject({ a: "running", b: "running", c: "running" });
    gates.get("https://c.test")!.resolve(ok({ n: 3 }));
    gates.get("https://a.test")!.resolve(ok({ n: 1 }));
    await new Promise((r) => setImmediate(r));
    expect(h.store.getStep(run.id, "merge")).toBeUndefined();
    gates.get("https://b.test")!.resolve(ok({ n: 2 }));
    await h.settle();
    const merged = h.step(run.id, "merge").output as Record<string, { body: { n: number } }>;
    expect(Object.keys(merged).sort()).toEqual(["a", "b", "c"]);
    expect(merged["b"]?.body.n).toBe(2);
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("fires an `any` join on the first arrival and ignores later ones", async () => {
    const h = new Harness();
    h.publish("wf", parallel("any"));
    const gates: Record<string, ReturnType<typeof deferred<HttpResponse>>> = {};
    h.http = (req) => {
      gates[req.url] = deferred<HttpResponse>();
      return gates[req.url]!.promise;
    };
    const run = h.start("wf");
    await new Promise((r) => setImmediate(r));
    gates["https://b.test"]!.resolve(ok({ first: true }));
    await new Promise((r) => setImmediate(r));
    expect(h.step(run.id, "merge").status).toBe("succeeded");
    expect(Object.keys(h.step(run.id, "merge").output as object)).toEqual(["b"]);
    gates["https://a.test"]!.resolve(ok());
    gates["https://c.test"]!.resolve(ok());
    await h.settle();
    expect(h.run(run.id).status).toBe("succeeded");
    expect(h.eventTypes(run.id, "merge").filter((t) => t === "step.started")).toHaveLength(1);
  });

  it("joins a branch whose other side was skipped", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition(
        [manual(), branch("b", "true"), transform("yes", "1"), transform("no", "2"), join("j")],
        [edge("start", "b"), edge("b.true", "yes"), edge("b.false", "no"), edge("yes", "j"), edge("no", "j")],
      ),
    );
    const run = h.start("wf");
    await h.settle();
    expect(h.step(run.id, "j").output).toEqual({ yes: 1 });
  });
});

describe("retries, timeouts and error paths", () => {
  it("retries with exponential backoff driven by the clock", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), http("call", "https://flaky.test", { retry })], [edge("start", "call")]));
    h.http = (_req, call) => (call < 3 ? ok({ err: true }, 503) : ok({ fine: true }));
    const run = h.start("wf");
    await h.settle();
    expect(h.step(run.id, "call")).toMatchObject({ status: "waiting", wakeReason: "retry", attempt: 1 });
    expect(h.run(run.id).status).toBe("waiting");
    await h.advance(999);
    expect(h.httpCalls).toHaveLength(1);
    await h.advance(1);
    expect(h.httpCalls).toHaveLength(2);
    expect(h.step(run.id, "call").attempt).toBe(2);
    await h.advance(1999);
    expect(h.httpCalls).toHaveLength(2);
    await h.advance(1);
    expect(h.run(run.id).status).toBe("succeeded");
    expect(h.step(run.id, "call")).toMatchObject({ status: "succeeded", attempt: 3, port: "success", error: null });
    const retries = h.store.eventsFor(run.id).filter((e) => e.type === "step.retry_scheduled").map((e) => e.data?.["delayMs"]);
    expect(retries).toEqual([1000, 2000]);
  });

  it("routes exhausted retries to the error port", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition(
        [manual(), http("call", "https://down.test", { retry: { ...retry, maxAttempts: 2 } }), node("alert", "action.notify", { channel: "inApp", recipients: ["role:admin"], title: "Failed", message: "{{ input.error.message }}" })],
        [edge("start", "call"), edge("call.error", "alert")],
      ),
    );
    h.http = () => ok({}, 500);
    const run = h.start("wf");
    await h.settle();
    await h.advance(1000);
    expect(h.step(run.id, "call")).toMatchObject({ status: "failed", port: "error", attempt: 2 });
    expect(h.notifier.inAppSent[0]?.message).toBe("HTTP 500 from GET https://down.test");
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("does not retry non-retryable errors and fails the run when unhandled", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), http("call", "https://x.test", { retry })], [edge("start", "call")]));
    h.http = () => ok({}, 404);
    const run = h.start("wf");
    await h.settle();
    expect(h.httpCalls).toHaveLength(1);
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: { code: "HTTP_STATUS", nodeId: "call" } });
  });

  it("treats SSRF blocks as permanent failures", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), http("call", "http://10.0.0.1", { retry })], [edge("start", "call")]));
    h.http = () => {
      throw Object.assign(new Error("blocked private address"), { code: "SSRF_BLOCKED" });
    };
    const run = h.start("wf");
    await h.settle();
    expect(h.run(run.id).error).toMatchObject({ code: "SSRF_BLOCKED" });
    expect(h.httpCalls).toHaveLength(1);
  });

  it("times out hung steps, aborts them and retries", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), http("call", "https://slow.test", { timeoutMs: 5000, retry: { ...retry, maxAttempts: 2 } })], [edge("start", "call")]));
    const aborted: unknown[] = [];
    const started = deferred<void>();
    h.http = (req, call) => {
      if (call === 2) return ok({ second: true });
      started.resolve();
      return new Promise((_, reject) => req.signal.addEventListener("abort", () => {
        aborted.push(req.signal.reason);
        reject(req.signal.reason);
      }));
    };
    const run = h.start("wf");
    await started.promise;
    h.clock.advance(4999);
    expect(aborted).toHaveLength(0);
    await h.advance(1);
    expect(aborted).toHaveLength(1);
    expect(h.step(run.id, "call")).toMatchObject({ status: "waiting", error: { code: "TIMEOUT" } });
    await h.advance(1000);
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("cancels running siblings when one branch fails", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition([manual(), http("slow", "https://slow.test"), transform("bad", "1 / 0")], [edge("start", "slow"), edge("start", "bad")]),
    );
    let signal: AbortSignal | undefined;
    h.http = (req) => {
      signal = req.signal;
      return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const run = h.start("wf");
    await h.settle();
    expect(h.run(run.id).status).toBe("failed");
    expect(h.statuses(run.id)).toMatchObject({ slow: "cancelled", bad: "failed" });
    expect(signal?.aborted).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("rejects oversized outputs", async () => {
    const h = new Harness({ maxOutputBytes: 100 });
    h.publish("wf", definition([manual(), transform("big", "repeat('x', 500)")], [edge("start", "big")]));
    const run = h.start("wf");
    await h.settle();
    expect(h.run(run.id).error?.code).toBe("OUTPUT_TOO_LARGE");
  });

  it("computes capped exponential delays", () => {
    expect([1, 2, 3, 4, 5].map((a) => retryDelay({ maxAttempts: 9, initialDelayMs: 500, backoffMultiplier: 3, maxDelayMs: 10_000 }, a))).toEqual([500, 1500, 4500, 10_000, 10_000]);
  });
});

describe("delays and run deadlines", () => {
  it("waits durably for a delay and resumes on the clock", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), node("wait", "action.delay", { mode: "duration", durationMs: 60_000 }), transform("after", "now()")], [edge("start", "wait"), edge("wait", "after")]));
    const run = h.start("wf");
    await h.settle();
    expect(h.run(run.id).status).toBe("waiting");
    expect(h.step(run.id, "wait").wakeAt).toBe(h.clock.now() + 60_000);
    await h.advance(60_000);
    expect(h.run(run.id).status).toBe("succeeded");
    expect(h.step(run.id, "after").output).toBe(Date.parse("2026-06-01T00:01:00Z"));
  });

  it("supports `until` delays and skips past timestamps", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), node("wait", "action.delay", { mode: "until", until: "trigger.at" })], [edge("start", "wait")]));
    const past = h.start("wf", { at: 0 });
    await h.settle();
    expect(h.run(past.id).status).toBe("succeeded");
    const future = h.start("wf", { at: h.clock.now() + 5000 });
    await h.settle();
    await h.advance(5000);
    expect(h.run(future.id).status).toBe("succeeded");
  });

  it("fails runs that exceed maxRunDurationMs", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), node("wait", "action.delay", { durationMs: 3_600_000 })], [edge("start", "wait")], { settings: { maxRunDurationMs: 60_000 } }));
    const run = h.start("wf");
    await h.settle();
    await h.advance(60_000);
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: { code: "RUN_TIMEOUT" } });
    expect(h.step(run.id, "wait").status).toBe("cancelled");
    expect(h.clock.pendingTimers).toBe(0);
  });
});

describe("approvals", () => {
  const approvalDef = (config: Record<string, unknown> = {}) =>
    definition(
      [
        manual(),
        node("approve", "action.approval", { title: "Approve {{ trigger.amount }}", assignees: ["manager@example.com"], ...config }),
        transform("yes", "'approved by ' + input.by"),
        transform("no", "'rejected: ' + input.comment"),
        transform("late", "'timeout'"),
      ],
      [edge("start", "approve"), edge("approve.approved", "yes"), edge("approve.rejected", "no"), edge("approve.timeout", "late")],
    );

  it("waits for an approval and follows the approved port", async () => {
    const h = new Harness();
    h.publish("wf", approvalDef());
    const run = h.start("wf", { amount: 50 });
    await h.settle();
    expect(h.run(run.id).status).toBe("waiting");
    const record = [...h.approvals.records.values()][0]!;
    expect(record).toMatchObject({ title: "Approve 50", assignees: ["manager@example.com"], dueAt: null });
    h.engine.signal(run.id, "approve", { decision: "approved", by: "manager@example.com" });
    await h.settle();
    expect(h.step(run.id, "yes").output).toBe("approved by manager@example.com");
    expect(h.statuses(run.id)).toMatchObject({ no: "skipped", late: "skipped" });
  });

  it("follows the rejected port with the comment", async () => {
    const h = new Harness();
    h.publish("wf", approvalDef());
    const run = h.start("wf", { amount: 50 });
    await h.settle();
    h.engine.signal(run.id, "approve", { decision: "rejected", by: "m", comment: "too expensive" });
    await h.settle();
    expect(h.step(run.id, "no").output).toBe("rejected: too expensive");
  });

  it("escalates after the timeout and then times out", async () => {
    const h = new Harness();
    h.publish("wf", approvalDef({ timeoutMs: 3_600_000, escalateTo: ["director@example.com"], escalationTimeoutMs: 1_800_000 }));
    const run = h.start("wf", { amount: 50 });
    await h.settle();
    await h.advance(3_600_000);
    const record = [...h.approvals.records.values()][0]!;
    expect(record.status).toBe("escalated");
    expect(record.escalatedTo).toEqual(["director@example.com"]);
    expect(h.step(run.id, "approve").status).toBe("waiting");
    await h.advance(1_800_000);
    expect(record.status).toBe("timed_out");
    expect(h.step(run.id, "late").status).toBe("succeeded");
    expect(h.step(run.id, "approve").output).toMatchObject({ decision: "timeout", escalated: true });
  });

  it("rejects signals for steps that are not waiting", async () => {
    const h = new Harness();
    h.publish("wf", approvalDef());
    const run = h.start("wf", { amount: 1 });
    await h.settle();
    expect(() => h.engine.signal(run.id, "yes", {})).toThrow(/not waiting/);
    expect(() => h.engine.signal("nope", "approve", {})).toThrow(/not found/);
  });

  it("closes the approval when the run is cancelled", async () => {
    const h = new Harness();
    h.publish("wf", approvalDef({ timeoutMs: 60_000 }));
    const run = h.start("wf", { amount: 1 });
    await h.settle();
    const cancelled = h.engine.cancel(run.id, "no longer needed");
    expect(cancelled).toMatchObject({ status: "cancelled", error: { message: "no longer needed" } });
    expect([...h.approvals.records.values()][0]?.status).toBe("cancelled");
    expect(h.clock.pendingTimers).toBe(0);
    expect(() => h.engine.cancel(run.id)).toThrow(/already cancelled/);
  });
});

describe("sub-workflows and end nodes", () => {
  it("runs a child workflow and returns its output", async () => {
    const h = new Harness();
    h.publish("child", definition([manual(), setVar("double", "result", "trigger.n * 2")], [edge("start", "double")]));
    h.publish("parent", definition([manual(), node("sub", "action.subworkflow", { workflowId: "child", input: "{ n: trigger.n }" }), transform("use", "input.output.result")], [edge("start", "sub"), edge("sub", "use")]));
    const run = h.start("parent", { n: 21 });
    await h.settle();
    expect(h.step(run.id, "use").output).toBe(42);
    const child = h.store.findChildRuns(run.id)[0]!;
    expect(child).toMatchObject({ workflowId: "child", depth: 1, parentNodeId: "sub", trigger: { type: "subworkflow" } });
  });

  it("handles children that complete synchronously", async () => {
    const h = new Harness();
    h.publish("child", definition([manual()], []));
    h.publish("parent", definition([manual(), node("sub", "action.subworkflow", { workflowId: "child" })], [edge("start", "sub")]));
    const run = h.start("parent");
    await h.settle();
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("routes child failures to the error port", async () => {
    const h = new Harness();
    h.publish("child", definition([manual(), node("end", "flow.end", { status: "failed", message: "bad {{ trigger.x }}" })], [edge("start", "end")]));
    h.publish("parent", definition([manual(), node("sub", "action.subworkflow", { workflowId: "child" }), transform("handle", "input.error.message")], [edge("start", "sub"), edge("sub.error", "handle")]));
    const run = h.start("parent", { x: "input" });
    await h.settle();
    expect(h.step(run.id, "handle").output).toBe("sub-workflow failed: bad input");
  });

  it("fails when the child cannot start and blocks self-recursion", async () => {
    const h = new Harness();
    h.publish("parent", definition([manual(), node("sub", "action.subworkflow", { workflowId: "missing" })], [edge("start", "sub")]));
    const run = h.start("parent");
    await h.settle();
    expect(h.run(run.id).error?.message).toMatch(/has no published version/);
    h.publish("self", definition([manual(), node("sub", "action.subworkflow", { workflowId: "self" })], [edge("start", "sub")]));
    const selfRun = h.start("self");
    await h.settle();
    expect(h.run(selfRun.id).error?.code).toBe("RECURSIVE_SUBWORKFLOW");
  });

  it("cancels children when the parent is cancelled", async () => {
    const h = new Harness();
    h.publish("child", definition([manual(), node("wait", "action.delay", { durationMs: 60_000 })], [edge("start", "wait")]));
    h.publish("parent", definition([manual(), node("sub", "action.subworkflow", { workflowId: "child" })], [edge("start", "sub")]));
    const run = h.start("parent");
    await h.settle();
    h.engine.cancel(run.id);
    expect(h.store.findChildRuns(run.id)[0]?.status).toBe("cancelled");
  });

  it("ends the run early from an end node, cancelling other branches", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition(
        [manual(), node("wait", "action.delay", { durationMs: 10_000 }), node("end", "flow.end", { status: "succeeded", output: "{ ok: true }" })],
        [edge("start", "wait"), edge("start", "end")],
      ),
    );
    const run = h.start("wf");
    await h.settle();
    expect(h.run(run.id)).toMatchObject({ status: "succeeded", output: { ok: true } });
    expect(h.step(run.id, "wait").status).toBe("cancelled");
  });
});

describe("crash recovery", () => {
  it("re-executes a step that was running when the process died", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), http("call", "https://api.test"), transform("after", "input.body.v")], [edge("start", "call"), edge("call.success", "after")]));
    h.http = (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("killed"))));
    const run = h.start("wf");
    await Promise.resolve();
    expect(h.step(run.id, "call").status).toBe("running");

    h.http = () => ok({ v: "recovered" });
    const engine2 = h.restart();
    await engine2.idle();
    expect(h.run(run.id).status).toBe("succeeded");
    expect(h.step(run.id, "after").output).toBe("recovered");
    expect(h.httpCalls).toHaveLength(2);
    expect(h.eventTypes(run.id)).toContain("run.recovered");
  });

  it("re-arms persisted delay and retry timers after restart", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition(
        [manual(), node("wait", "action.delay", { durationMs: 30_000 }), http("call", "https://api.test", { retry })],
        [edge("start", "wait"), edge("wait", "call")],
      ),
    );
    h.http = (_r, n) => (n === 1 ? ok({}, 500) : ok());
    const run = h.start("wf");
    await h.settle();
    h.restart();
    expect(h.clock.pendingTimers).toBe(1);
    await h.advance(30_000);
    expect(h.step(run.id, "call").wakeReason).toBe("retry");
    h.restart();
    await h.advance(1000);
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("replays an accepted signal whose processing was interrupted", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), node("approve", "action.approval", { title: "t", assignees: ["a@x"] }), transform("done", "input.decision")], [edge("start", "approve"), edge("approve.approved", "done")]));
    const run = h.start("wf");
    await h.settle();
    h.engine.signal(run.id, "approve", { decision: "approved", by: "a@x" });
    expect(h.step(run.id, "approve")).toMatchObject({ status: "running", pendingEvent: { kind: "signal" } });
    h.restart();
    await h.settle();
    expect(h.step(run.id, "done").output).toBe("approved");
    expect(h.approvals.records.size).toBe(1);
  });

  it("starts a reserved child run that was lost in a crash", async () => {
    const h = new Harness();
    h.publish("child", definition([manual(), transform("t", "trigger.v")], [edge("start", "t")]));
    h.publish("parent", definition([manual(), node("sub", "action.subworkflow", { workflowId: "child", input: "{ v: 7 }" })], [edge("start", "sub")]));
    const run = h.start("parent");
    await h.settle();
    const childId = (h.step(run.id, "sub").state as { childRunId: string }).childRunId;
    // Simulate a crash after the parent step became waiting but before the child was persisted.
    h.store.transaction(() => {
      const step = h.step(run.id, "sub");
      step.status = "waiting";
      step.port = null;
      step.finishedAt = null;
      h.store.saveStep(step);
      const parent = h.run(run.id);
      parent.status = "waiting";
      parent.finishedAt = null;
      h.store.updateRun(parent);
    });
    // Remove the child completely to model "never persisted".
    (h.store as unknown as { runs: Map<string, unknown> }).runs.delete(childId);
    h.restart();
    await h.settle();
    expect(h.run(run.id).status).toBe("succeeded");
    expect(h.run(childId).status).toBe("succeeded");
  });

  it("fails runs whose definition disappeared", () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), node("wait", "action.delay", { durationMs: 1000 })], [edge("start", "wait")]));
    const run = h.start("wf");
    const store = h.store;
    const r = store.getRun(run.id)!;
    store.updateRun({ ...r, version: 99 });
    h.restart();
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: { code: "DEFINITION_MISSING" } });
  });

  it("refuses work after shutdown", () => {
    const h = new Harness();
    h.publish("wf", definition([manual()], []));
    h.engine.shutdown();
    expect(h.engine.isStopped).toBe(true);
    expect(() => h.start("wf")).toThrow(/shut down/);
  });
});

describe("more flow semantics", () => {
  it("lets an error path continue the run and exposes the error to expressions", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition(
        [manual(), transform("parse", "jsonParse(trigger.raw)"), transform("fallback", "{ recovered: true, why: input.error.code }"), join("j", "any")],
        [edge("start", "parse"), edge("parse.error", "fallback"), edge("parse", "j"), edge("fallback", "j")],
      ),
    );
    const run = h.start("wf", { raw: "{not json" });
    await h.settle();
    expect(h.step(run.id, "parse")).toMatchObject({ status: "failed", port: "error" });
    expect(h.step(run.id, "fallback").output).toEqual({ recovered: true, why: "EXPRESSION_ERROR" });
    expect(h.step(run.id, "j").output).toEqual({ fallback: { recovered: true, why: "EXPRESSION_ERROR" } });
    expect(h.run(run.id).status).toBe("succeeded");
  });

  it("skips an any-join when every incoming branch is dead", async () => {
    const h = new Harness();
    h.publish(
      "wf",
      definition([manual(), branch("b", "false"), transform("x", "1"), transform("y", "2"), join("j", "any"), transform("other", "3")], [edge("start", "b"), edge("b.true", "x"), edge("b.true", "y"), edge("x", "j"), edge("y", "j"), edge("b.false", "other")]),
    );
    const run = h.start("wf");
    await h.settle();
    expect(h.statuses(run.id)).toMatchObject({ x: "skipped", y: "skipped", j: "skipped", other: "succeeded" });
  });

  it("limits sub-workflow nesting depth", async () => {
    const h = new Harness({ maxDepth: 1 });
    h.publish("c", definition([manual()], []));
    h.publish("b", definition([manual(), node("sub", "action.subworkflow", { workflowId: "c" })], [edge("start", "sub")]));
    h.publish("a", definition([manual(), node("sub", "action.subworkflow", { workflowId: "b" })], [edge("start", "sub")]));
    const run = h.start("a");
    await h.settle();
    expect(h.run(run.id)).toMatchObject({ status: "failed" });
    expect(h.run(run.id).error?.message).toMatch(/nesting exceeds 1/);
  });

  it("merges variables from parallel branches into the run output", async () => {
    const h = new Harness();
    h.publish("wf", definition([manual(), setVar("a", "first", "1"), setVar("b", "second", "2")], [edge("start", "a"), edge("start", "b")]));
    const run = h.start("wf");
    await h.settle();
    expect(h.run(run.id).output).toEqual({ first: 1, second: 2 });
  });
});
