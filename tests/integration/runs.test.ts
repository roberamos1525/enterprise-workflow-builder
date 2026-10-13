import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhookSignature } from "../../apps/server/src/auth.js";
import { createPublished, def, e, n, startStub, startTestApp, type StubServer, type TestApp } from "../helpers.js";

let t: TestApp;
let stub: StubServer;
beforeAll(async () => {
  t = await startTestApp();
  stub = await startStub();
});
afterAll(async () => {
  await t.close();
  await stub.close();
});

const stepOf = (detail: { steps: { nodeId: string }[] }, id: string) => detail.steps.find((s) => s.nodeId === id) as Record<string, any>;

/** webhook -> branch -> parallel(setVariable, http, approval) -> join; false branch -> transform. */
function orderFlow(stubUrl: string) {
  return def(
    [
      n("hook", "trigger.webhook", { requiredFields: ["orderId", "amount"] }),
      n("large", "flow.branch", { condition: "trigger.amount > 1000" }),
      n("record", "action.setVariable", { name: "orderId", expression: "trigger.orderId" }),
      n("erp", "action.http", { method: "POST", url: `${stubUrl}/orders/{{ trigger.orderId }}`, body: "{{ { id: trigger.orderId, amount: trigger.amount } }}" }),
      n("approve", "action.approval", { title: "Approve {{ trigger.orderId }}", assignees: ["role:operator"] }),
      n("tell", "action.notify", { channel: "inApp", recipients: ["editor@test.dev"], title: "Order {{ trigger.orderId }} {{ input.decision }}", message: "by {{ input.by }}" }),
      n("join", "flow.join", { mode: "all" }),
      n("auto", "action.transform", { expression: "'auto-approved ' + trigger.orderId" }),
    ],
    [e("hook", "large"), e("large.true", "record"), e("large.true", "erp"), e("large.true", "approve"), e("approve.approved", "tell"), e("record", "join"), e("erp.success", "join"), e("tell", "join"), e("large.false", "auto")],
  );
}

describe("webhook-triggered approval flow", () => {
  let id: string;
  let secret: string;
  beforeAll(async () => {
    id = await createPublished(t, "Orders", orderFlow(stub.url));
    secret = (await t.as("editor")("GET", `/api/workflows/${id}`)).body.webhook.secret;
  });

  const hook = (body: unknown, headers: Record<string, string>) => t.api("POST", `/api/hooks/${id}`, { raw: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  it("rejects unauthenticated, badly signed and stale webhook calls", async () => {
    expect((await hook({}, {})).status).toBe(401);
    expect((await hook({}, { "x-ewb-token": "wrong" })).status).toBe(401);
    const ts = String(Math.floor(t.clock.now() / 1000));
    expect((await hook({ a: 1 }, { "x-ewb-timestamp": ts, "x-ewb-signature": webhookSignature(secret, ts, "{}") })).status).toBe(401);
    const old = String(Math.floor(t.clock.now() / 1000) - 3600);
    const body = JSON.stringify({ orderId: "o", amount: 1 });
    const stale = await t.api("POST", `/api/hooks/${id}`, { raw: body, headers: { "x-ewb-timestamp": old, "x-ewb-signature": webhookSignature(secret, old, body) } });
    expect(stale.body.error.message).toMatch(/timestamp/);
    expect((await t.api("POST", "/api/hooks/wf_missing", { raw: "{}", headers: { "x-ewb-token": "x" } })).status).toBe(404);
  });

  it("validates the trigger payload", async () => {
    const res = await hook({ orderId: "o-1" }, { "x-ewb-token": secret });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/missing: amount/);
  });

  it("runs branch + parallel actions, waits for approval, and completes after the decision", async () => {
    const body = JSON.stringify({ orderId: "PO-7", amount: 2500 });
    const ts = String(Math.floor(t.clock.now() / 1000));
    const res = await t.api("POST", `/api/hooks/${id}`, {
      raw: body,
      headers: { "x-ewb-timestamp": ts, "x-ewb-signature": webhookSignature(secret, ts, body), "idempotency-key": "po-7" },
    });
    expect(res.status).toBe(202);
    const runId = res.body.runId;
    await t.settle();

    let detail = (await t.as("viewer")("GET", `/api/runs/${runId}`)).body;
    expect(detail.run.status).toBe("waiting");
    expect(stepOf(detail, "auto").status).toBe("skipped");
    expect(stepOf(detail, "erp")).toMatchObject({ status: "succeeded", port: "success" });
    expect(stepOf(detail, "record").status).toBe("succeeded");
    expect(stepOf(detail, "approve").status).toBe("waiting");
    expect(stub.requests.at(-1)).toMatchObject({ method: "POST", url: "/orders/PO-7", body: '{"id":"PO-7","amount":2500}' });

    // Same idempotency key -> same run, no duplicate execution.
    const dup = await t.api("POST", `/api/hooks/${id}`, { raw: body, headers: { "x-ewb-token": secret, "idempotency-key": "po-7" } });
    expect(dup.body).toEqual({ runId, duplicate: true });

    // The approval shows up for the operator, who also got a notification.
    const mine = await t.as("operator")("GET", "/api/approvals?mine=true&status=pending");
    const approval = mine.body.find((a: { runId: string }) => a.runId === runId);
    expect(approval).toMatchObject({ title: "Approve PO-7", canDecide: true, assignees: ["role:operator"] });
    const inbox = await t.as("operator")("GET", "/api/notifications?unread=true");
    expect(inbox.body.items.some((x: { kind: string; title: string }) => x.kind === "approval" && x.title === "Approval requested")).toBe(true);

    // Viewers cannot decide; operators can.
    expect((await t.as("viewer")("POST", `/api/approvals/${approval.id}/decision`, { decision: "approved" })).status).toBe(403);
    const decided = await t.as("operator")("POST", `/api/approvals/${approval.id}/decision`, { decision: "approved", comment: "ok" });
    expect(decided.body).toMatchObject({ status: "approved", decidedBy: "operator@test.dev", comment: "ok" });
    expect((await t.as("operator")("POST", `/api/approvals/${approval.id}/decision`, { decision: "rejected" })).status).toBe(409);
    await t.settle();

    detail = (await t.as("viewer")("GET", `/api/runs/${runId}`)).body;
    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.output).toEqual({ orderId: "PO-7" });
    expect(Object.keys(stepOf(detail, "join").output).sort()).toEqual(["erp", "record", "tell"]);
    expect(detail.events.map((ev: { type: string }) => ev.type)).toEqual(expect.arrayContaining(["run.started", "step.waiting", "step.resumed", "run.succeeded"]));
    const editorInbox = await t.as("editor")("GET", "/api/notifications");
    expect(editorInbox.body.items[0]).toMatchObject({ kind: "workflow", title: "Order PO-7 approved", body: "by operator@test.dev", link: `/runs/${runId}` });
    expect((await t.as("editor")("POST", "/api/notifications/read-all")).body.updated).toBeGreaterThan(0);
  });

  it("takes the false branch for small orders without waiting", async () => {
    const res = await hook({ orderId: "PO-8", amount: 10 }, { "x-ewb-token": secret });
    await t.settle();
    const detail = (await t.as("viewer")("GET", `/api/runs/${res.body.runId}`)).body;
    expect(detail.run.status).toBe("succeeded");
    expect(stepOf(detail, "auto").output).toBe("auto-approved PO-8");
    expect(["record", "erp", "approve", "tell", "join"].map((s) => stepOf(detail, s).status)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"]);
  });

  it("rejects webhooks for workflows without a webhook trigger", async () => {
    const manualId = await createPublished(t, "Manual only", def([n("s", "trigger.manual")], []));
    const s = (await t.as("editor")("GET", `/api/workflows/${manualId}`)).body.webhook.secret;
    expect((await t.api("POST", `/api/hooks/${manualId}`, { raw: "{}", headers: { "x-ewb-token": s } })).status).toBe(409);
  });
});

describe("HTTP action behaviour", () => {
  it("retries 5xx responses with backoff on the injected clock", async () => {
    let calls = 0;
    stub.handler = (_req, res) => {
      calls++;
      res.writeHead(calls < 3 ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ calls }));
    };
    const retry = { maxAttempts: 3, initialDelayMs: 2000, backoffMultiplier: 2, maxDelayMs: 60_000 };
    const id = await createPublished(t, "Flaky", def([n("s", "trigger.manual"), n("call", "action.http", { url: `${stub.url}/flaky` }, { retry })], [e("s", "call")]));
    const run = (await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    await t.settle();
    expect((await t.as("operator")("GET", `/api/runs/${run.id}`)).body.run.status).toBe("waiting");
    await t.advance(2000);
    await t.advance(4000);
    const detail = (await t.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(detail.run.status).toBe("succeeded");
    expect(stepOf(detail, "call")).toMatchObject({ attempt: 3, output: { status: 200, body: { calls: 3 } } });
    expect(detail.events.filter((ev: { type: string }) => ev.type === "step.retry_scheduled").map((ev: { data: { delayMs: number } }) => ev.data.delayMs)).toEqual([2000, 4000]);
    stub.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
  });

  it("blocks requests to private networks that are not allow-listed and notifies the owner", async () => {
    const id = await createPublished(
      t,
      "SSRF",
      def([n("s", "trigger.manual"), n("call", "action.http", { url: "http://169.254.169.254/latest/meta-data" }, { retry: { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 1000 } })], [e("s", "call")]),
    );
    const run = (await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    await t.settle();
    const detail = (await t.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(detail.run).toMatchObject({ status: "failed", error: { code: "SSRF_BLOCKED" } });
    expect(stepOf(detail, "call").attempt).toBe(1);
    const inbox = await t.as("operator")("GET", "/api/notifications");
    expect(inbox.body.items.some((x: { kind: string; link: string }) => x.kind === "run_failed" && x.link === `/runs/${run.id}`)).toBe(true);
  });
});

describe("event triggers, sub-workflows, cancellation and dashboard", () => {
  it("starts subscribed workflows whose filter matches", async () => {
    const id = await createPublished(
      t,
      "Signup",
      def([n("ev", "trigger.event", { eventType: "customer.signup", filter: "event.payload.plan != 'free'" }), n("t", "action.transform", { expression: "upper(trigger.payload.plan)" })], [e("ev", "t")]),
    );
    const paid = await t.as("operator")("POST", "/api/events", { type: "customer.signup", payload: { plan: "pro" } });
    expect(paid.status).toBe(202);
    expect(paid.body.runIds).toHaveLength(1);
    const free = await t.as("operator")("POST", "/api/events", { type: "customer.signup", payload: { plan: "free" } });
    expect(free.body).toMatchObject({ runIds: [], skipped: [{ workflowId: id, reason: "filter" }] });
    expect((await t.as("viewer")("POST", "/api/events", { type: "x" })).status).toBe(403);
    await t.settle();
    const detail = (await t.as("operator")("GET", `/api/runs/${paid.body.runIds[0]}`)).body;
    expect(stepOf(detail, "t").output).toBe("PRO");
    expect(detail.run.trigger).toMatchObject({ type: "event", meta: { eventType: "customer.signup" } });
  });

  it("runs sub-workflows and lists child runs", async () => {
    const child = await createPublished(t, "Child", def([n("s", "trigger.manual"), n("v", "action.setVariable", { name: "doubled", expression: "trigger.n * 2" })], [e("s", "v")]));
    const parent = await createPublished(t, "Parent", def([n("s", "trigger.manual"), n("sub", "action.subworkflow", { workflowId: child, input: "{ n: trigger.n }" })], [e("s", "sub")]));
    const run = (await t.as("operator")("POST", `/api/workflows/${parent}/runs`, { input: { n: 4 } })).body;
    await t.settle();
    const detail = (await t.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(stepOf(detail, "sub").output.output).toEqual({ doubled: 8 });
    expect(detail.children).toHaveLength(1);
  });

  it("refuses to publish sub-workflow references to unknown workflows", async () => {
    const created = await t.as("editor")("POST", "/api/workflows", {
      name: "Dangling",
      definition: def([n("s", "trigger.manual"), n("sub", "action.subworkflow", { workflowId: "wf_nope" })], [e("s", "sub")]),
    });
    const res = await t.as("editor")("POST", `/api/workflows/${created.body.id}/publish`, {});
    expect(res.status).toBe(422);
  });

  it("cancels waiting runs and closes their approvals", async () => {
    const id = await createPublished(t, "Cancel me", def([n("s", "trigger.manual"), n("a", "action.approval", { title: "x", assignees: ["role:admin"] })], [e("s", "a")]));
    const run = (await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    await t.settle();
    expect((await t.as("viewer")("POST", `/api/runs/${run.id}/cancel`, {})).status).toBe(403);
    const cancelled = await t.as("operator")("POST", `/api/runs/${run.id}/cancel`, { reason: "duplicate" });
    expect(cancelled.body).toMatchObject({ status: "cancelled", error: { message: "duplicate" } });
    const approvals = await t.as("admin")("GET", "/api/approvals?status=cancelled");
    expect(approvals.body.some((a: { runId: string }) => a.runId === run.id)).toBe(true);
    expect((await t.as("operator")("POST", `/api/runs/${run.id}/cancel`, {})).status).toBe(409);
  });

  it("reports success rate and durations on the dashboard", async () => {
    const id = await createPublished(t, "Timed", def([n("s", "trigger.manual"), n("w", "action.delay", { durationMs: 30_000 })], [e("s", "w")]));
    for (let i = 0; i < 2; i++) await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} });
    await t.settle();
    await t.advance(30_000);
    const summary = (await t.as("operator")("GET", `/api/metrics/summary?workflowId=${id}&days=7`)).body;
    expect(summary).toMatchObject({ total: 2, byStatus: { succeeded: 2 }, successRate: 1, avgDurationMs: 30_000, p95DurationMs: 30_000 });
    expect(summary.perDay).toHaveLength(7);
    expect(summary.perDay.at(-1)).toMatchObject({ succeeded: 2 });
    const all = (await t.as("admin")("GET", "/api/metrics/summary")).body;
    expect(all.total).toBeGreaterThan(5);
    expect(all.successRate).toBeLessThan(1);
    const page = await t.as("admin")("GET", "/api/runs?limit=2");
    expect(page.body.items).toHaveLength(2);
    const next = await t.as("admin")("GET", `/api/runs?limit=2&before=${page.body.nextBefore}`);
    expect(next.body.items[0].createdAt).toBeLessThanOrEqual(page.body.nextBefore);
  });
});

describe("live stream", () => {
  it("streams run events to authorised subscribers over SSE", async () => {
    const id = await createPublished(t, "Live", def([n("s", "trigger.manual"), n("x", "action.transform", { expression: "1" })], [e("s", "x")]));
    const controller = new AbortController();
    const res = await fetch(`${t.base}/api/stream`, { headers: { authorization: `Bearer ${t.tokens.viewer}` }, signal: controller.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
    const run = (await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: {} })).body;
    while (!text.includes(`"type":"run.succeeded"`)) text += decoder.decode((await reader.read()).value);
    controller.abort();
    const events = text.split("\n\n").filter((b) => b.startsWith("event: run")).map((b) => JSON.parse(b.split("data: ")[1]!));
    expect(events.every((ev: { runId: string; workflowId: string }) => ev.runId === run.id && ev.workflowId === id)).toBe(true);
    expect(events.map((ev: { type: string }) => ev.type)).toEqual(["run.started", "step.succeeded", "step.started", "step.succeeded", "run.succeeded"]);
    await t.settle();
  });
});

describe("approval escalation and webhook notifications", () => {
  it("escalates an unanswered approval to the escalation assignees, then times out", async () => {
    const id = await createPublished(
      t,
      "Escalating",
      def(
        [
          n("s", "trigger.manual"),
          n("a", "action.approval", { title: "Sign off {{ trigger.ref }}", assignees: ["viewer@test.dev"], timeoutMs: 3_600_000, escalateTo: ["role:admin"], escalationTimeoutMs: 7_200_000 }),
          n("late", "action.setVariable", { name: "outcome", expression: "input.decision + (input.escalated ? '-escalated' : '')" }),
        ],
        [e("s", "a"), e("a.timeout", "late")],
      ),
    );
    const run = (await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: { ref: "X-1" } })).body;
    await t.settle();
    const before = (await t.as("admin")("GET", "/api/approvals?mine=true&status=pending")).body;
    expect(before.some((a: { runId: string }) => a.runId === run.id)).toBe(true); // admins may always decide

    await t.advance(3_600_000);
    const approval = (await t.as("admin")("GET", "/api/approvals?status=pending")).body.find((a: { runId: string }) => a.runId === run.id);
    expect(approval).toMatchObject({ escalated: true, assignees: ["viewer@test.dev", "role:admin"] });
    const adminInbox = (await t.as("admin")("GET", "/api/notifications")).body.items;
    expect(adminInbox.some((x: { title: string; body: string }) => x.title === "Approval escalated to you" && x.body === "Sign off X-1")).toBe(true);

    await t.advance(7_200_000);
    const detail = (await t.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(detail.run).toMatchObject({ status: "succeeded", output: { outcome: "timeout-escalated" } });
    expect((await t.as("admin")("GET", `/api/approvals/${approval.id}`)).body.status).toBe("timed_out");
  });

  it("delivers webhook notifications through the SSRF-guarded client", async () => {
    stub.requests.length = 0;
    const id = await createPublished(
      t,
      "Notify hook",
      def([n("s", "trigger.manual"), n("tell", "action.notify", { channel: "webhook", url: `${stub.url}/notify`, title: "Hi {{ trigger.who }}", message: "Run {{ run.id }}" })], [e("s", "tell")]),
    );
    const run = (await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: { who: "ops" } })).body;
    await t.settle();
    const sent = stub.requests.find((r) => r.url === "/notify");
    expect(JSON.parse(sent!.body)).toMatchObject({ title: "Hi ops", message: `Run ${run.id}`, runId: run.id, nodeId: "tell" });
    const detail = (await t.as("operator")("GET", `/api/runs/${run.id}`)).body;
    expect(stepOf(detail, "tell").output).toEqual({ channel: "webhook", status: 200, title: "Hi ops" });
  });
});
