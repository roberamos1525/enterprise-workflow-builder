import { describe, expect, it } from "vitest";
import { node } from "../__tests__/builders.js";
import { compileExpression, renderDeep, renderTemplate } from "../expr/index.js";
import {
  createApprovalHandler,
  createHttpHandler,
  createNotifyHandler,
  delayHandler,
  endHandler,
  type HttpRequest,
  type HttpResponse,
  type Notifier,
} from "./handlers.js";
import { StepError, type RunRecord, type StepContext } from "./types.js";

const run = { id: "r1", workflowId: "wf", version: 1, createdBy: null } as unknown as RunRecord;

function ctx(config: Record<string, unknown>, extra: Partial<StepContext> = {}): StepContext {
  const scope = { trigger: { id: 7, name: "Ada" }, input: { total: 3 }, vars: {}, steps: {}, run: { id: "r1" } };
  return {
    run,
    node: node("n", "action.http", config),
    attempt: 1,
    input: scope.input,
    state: null,
    signal: new AbortController().signal,
    scope,
    now: () => 1_000,
    evaluate: (s) => compileExpression(s).evaluate(scope),
    render: (t) => renderTemplate(t, scope),
    renderDeep: (v) => renderDeep(v, scope),
    startChildRun: () => "child",
    ...extra,
  };
}

const response = (status: number, body: string, type = "application/json"): HttpResponse => ({ status, headers: { "content-type": type }, body });

async function failure(promise: unknown): Promise<StepError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(StepError);
    return err as StepError;
  }
  throw new Error("expected a StepError");
}

describe("HTTP handler", () => {
  it("renders url, lower-cases headers and sends single-expression bodies as JSON", async () => {
    const seen: HttpRequest[] = [];
    const handler = createHttpHandler({ request: async (r) => (seen.push(r), response(201, '{"ok":true}')) });
    const outcome = await handler.execute(
      ctx({ method: "post", url: "https://api.test/u/{{ trigger.id }}", headers: { "X-Name": "{{ trigger.name }}" }, body: "{{ { id: trigger.id, total: input.total } }}" }),
    );
    expect(seen[0]).toMatchObject({ method: "POST", url: "https://api.test/u/7", headers: { "x-name": "Ada", "content-type": "application/json" }, body: '{"id":7,"total":3}' });
    expect(outcome).toEqual({ type: "complete", port: "success", output: { status: 201, headers: { "content-type": "application/json" }, body: { ok: true } } });
  });

  it("sends text templates verbatim, skips bodies for GET and keeps non-JSON responses as text", async () => {
    const seen: HttpRequest[] = [];
    const handler = createHttpHandler({ request: async (r) => (seen.push(r), response(200, "<html/>", "text/html")) });
    await handler.execute(ctx({ method: "PUT", url: "https://x.test", body: "name={{ trigger.name }}" }));
    expect(seen[0]?.body).toBe("name=Ada");
    expect(seen[0]?.headers["content-type"]).toBeUndefined();
    const out = await handler.execute(ctx({ method: "GET", url: "https://x.test", body: "ignored" }));
    expect(seen[1]?.body).toBeUndefined();
    expect(out).toMatchObject({ output: { body: "<html/>" } });
  });

  it("classifies HTTP status failures and respects failOnHttpError=false", async () => {
    const status = (code: number) => createHttpHandler({ request: async () => response(code, "{}") });
    expect((await failure(status(503).execute(ctx({ url: "https://x" })))).retryable).toBe(true);
    expect((await failure(status(429).execute(ctx({ url: "https://x" })))).retryable).toBe(true);
    const notFound = await failure(status(404).execute(ctx({ url: "https://x" })));
    expect(notFound).toMatchObject({ code: "HTTP_STATUS", retryable: false, details: { status: 404 } });
    expect(await status(500).execute(ctx({ url: "https://x", failOnHttpError: false }))).toMatchObject({ port: "success", output: { status: 500 } });
  });

  it("maps client errors to retryable network failures unless the code is permanent", async () => {
    const throwing = (err: Error) => createHttpHandler({ request: async () => { throw err; } });
    expect(await failure(throwing(new Error("ECONNRESET")).execute(ctx({ url: "https://x" })))).toMatchObject({ code: "HTTP_NETWORK", retryable: true });
    const tooLarge = Object.assign(new Error("too big"), { code: "RESPONSE_TOO_LARGE" });
    expect(await failure(throwing(tooLarge).execute(ctx({ url: "https://x" })))).toMatchObject({ code: "RESPONSE_TOO_LARGE", retryable: false });
  });

  it("tolerates malformed JSON responses", async () => {
    const handler = createHttpHandler({ request: async () => response(200, "{nope") });
    expect(await handler.execute(ctx({ url: "https://x" }))).toMatchObject({ output: { body: "{nope" } });
  });
});

describe("notification handler", () => {
  const notifier = (status: number | Error): Notifier & { sent: unknown[] } => {
    const sent: unknown[] = [];
    return {
      sent,
      inApp: (r) => (sent.push(r), { delivered: r.recipients.length }),
      webhook: async (r) => {
        sent.push(r);
        if (status instanceof Error) throw status;
        return { status };
      },
    };
  };

  it("renders title/message and delivers in-app", async () => {
    const n = notifier(200);
    const out = await createNotifyHandler(n).execute(ctx({ channel: "inApp", recipients: ["a@x", "role:admin", ""], title: "Hi {{ trigger.name }}", message: "Total {{ input.total }}" }));
    expect(n.sent[0]).toMatchObject({ recipients: ["a@x", "role:admin"], title: "Hi Ada", message: "Total 3", runId: "r1" });
    expect(out).toEqual({ type: "complete", port: "out", output: { channel: "inApp", delivered: 2, title: "Hi Ada" } });
  });

  it("classifies webhook failures", async () => {
    const config = { channel: "webhook", url: "https://hooks.test", title: "t", message: "m" };
    expect(await failure(createNotifyHandler(notifier(502)).execute(ctx(config)))).toMatchObject({ code: "NOTIFY_FAILED", retryable: true });
    expect(await failure(createNotifyHandler(notifier(400)).execute(ctx(config)))).toMatchObject({ retryable: false });
    const blocked = Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" });
    expect(await failure(createNotifyHandler(notifier(blocked)).execute(ctx(config)))).toMatchObject({ code: "SSRF_BLOCKED", retryable: false });
  });
});

describe("approval, delay and end handlers", () => {
  const host = { create: () => "ap1", escalate: () => undefined, close: () => undefined };

  it("rejects invalid approval decisions and closes on cancel", async () => {
    const closed: string[] = [];
    const handler = createApprovalHandler({ ...host, close: (id, status) => closed.push(`${id}:${status}`) });
    const c = ctx({ title: "t", assignees: ["x@y"] }, { state: { approvalId: "ap1", level: 0 } });
    expect(await failure(Promise.resolve().then(() => handler.resume!(c, { kind: "signal", payload: { decision: "maybe" } })))).toMatchObject({ code: "BAD_SIGNAL" });
    handler.cancel!(c);
    expect(closed).toEqual(["ap1:cancelled"]);
    expect(handler.execute(ctx({ title: "t", assignees: ["x"], timeoutMs: 500 }))).toEqual({ type: "wait", wakeAt: 1_500, state: { approvalId: "ap1", level: 0 } });
  });

  it("validates delay targets and refuses signals", async () => {
    expect(await failure(Promise.resolve().then(() => delayHandler.execute(ctx({ mode: "until", until: "'soon'" }))))).toMatchObject({ code: "BAD_DELAY" });
    expect(delayHandler.execute(ctx({ mode: "duration", durationMs: 0 }))).toMatchObject({ type: "complete" });
    expect(await failure(Promise.resolve().then(() => delayHandler.resume!(ctx({}), { kind: "signal", payload: {} })))).toMatchObject({ code: "BAD_SIGNAL" });
  });

  it("renders end-node failure messages and outputs", () => {
    expect(endHandler.execute(ctx({ status: "failed", message: "order {{ trigger.id }} rejected" }))).toEqual({ type: "end", status: "failed", message: "order 7 rejected" });
    expect(endHandler.execute(ctx({ output: "{ n: input.total }" }))).toEqual({ type: "end", status: "succeeded", output: { n: 3 } });
  });
});
