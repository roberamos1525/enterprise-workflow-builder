import { createHandlers, ManualClock, WorkflowEngine, type HttpClient, type WorkflowDefinition } from "@ewb/engine";
import { beforeEach, describe, expect, it } from "vitest";
import { webhookSignature, type AuthUser } from "../auth.js";
import { Database } from "../db/database.js";
import { SqliteRunStore } from "../db/run-store.js";
import { createLogger, Metrics } from "../observability.js";
import { ApprovalService, LiveHub, NotificationService } from "./collaboration.js";
import { RunService } from "./runs.js";
import { UserService } from "./users.js";
import { WorkflowService } from "./workflows.js";

const silent = createLogger("silent");
const nodes = {
  manual: { id: "s", type: "trigger.manual", name: "s", position: { x: 0, y: 0 }, config: {} },
  hook: { id: "s", type: "trigger.webhook", name: "s", position: { x: 0, y: 0 }, config: {} },
  cron: (cron: string) => ({ id: "s", type: "trigger.schedule", name: "s", position: { x: 0, y: 0 }, config: { cron } }),
  event: (filter: string) => ({ id: "s", type: "trigger.event", name: "s", position: { x: 0, y: 0 }, config: { eventType: "thing.happened", filter } }),
};
const defOf = (trigger: WorkflowDefinition["nodes"][number], extra: WorkflowDefinition["nodes"] = []): WorkflowDefinition => ({
  schemaVersion: 1,
  nodes: [trigger, ...extra],
  edges: extra.map((n, i) => ({ id: `e${i}`, source: { node: "s", port: "out" }, target: { node: n.id, port: "in" } })),
});

let clock: ManualClock;
let db: Database;
let users: UserService;
let workflows: WorkflowService;
let runs: RunService;
let approvals: ApprovalService;
let notifications: NotificationService;
let editor: AuthUser;
let operator: AuthUser;
let viewer: AuthUser;
let metrics: Metrics;

beforeEach(() => {
  clock = new ManualClock(Date.parse("2026-06-01T00:00:00Z"));
  const now = () => clock.now();
  db = new Database(":memory:");
  db.migrate();
  users = new UserService(db, now);
  workflows = new WorkflowService(db, now);
  metrics = new Metrics();
  const http: HttpClient = { request: async () => ({ status: 202, headers: {}, body: "" }) };
  const hub = new LiveHub(60_000);
  notifications = new NotificationService(db, users, http, hub, now);
  approvals = new ApprovalService(db, users, workflows, notifications, now, silent);
  const store = new SqliteRunStore(db);
  runs = new RunService(db, store, workflows, metrics, silent, now);
  const engine = new WorkflowEngine({ store, clock, definitions: workflows, handlers: createHandlers({ http, notifier: notifications, approvals }) });
  runs.engine = engine;
  approvals.attachEngine(engine);
  editor = users.create({ email: "ed@x.dev", name: "Ed", role: "editor", password: "password1" });
  operator = users.create({ email: "op@x.dev", name: "Op", role: "operator", password: "password1" });
  viewer = users.create({ email: "vi@x.dev", name: "Vi", role: "viewer", password: "password1" });
});

function publish(def: WorkflowDefinition, share = true): string {
  const wf = workflows.create(editor, { name: "wf", definition: def });
  if (share) {
    workflows.setAcl(editor, wf.id, [
      { userId: editor.id, role: "editor" },
      { userId: operator.id, role: "operator" },
      { userId: viewer.id, role: "viewer" },
    ]);
  }
  workflows.publish(editor, wf.id);
  return wf.id;
}

describe("WorkflowService triggers and versions", () => {
  it("keeps the next fire time when republishing the same cron and resets it when the cron changes", () => {
    const id = publish(defOf(nodes.cron("0 * * * *")));
    runs.updateSchedule(id, { nextFireAt: 12345 });
    const rev = workflows.detail(editor, id).draftRevision;
    workflows.updateDraft(editor, id, { revision: rev, definition: defOf(nodes.cron("0 * * * *"), [{ id: "t", type: "action.transform", name: "t", position: { x: 1, y: 1 }, config: { expression: "1" } }]) });
    workflows.publish(editor, id);
    expect(runs.listSchedules()[0]?.nextFireAt).toBe(12345);
    workflows.updateDraft(editor, id, { revision: rev + 1, definition: defOf(nodes.cron("30 * * * *")) });
    workflows.publish(editor, id);
    expect(runs.listSchedules()[0]).toMatchObject({ cron: "30 * * * *", nextFireAt: null, enabled: true });
  });

  it("disables triggers when archived and when switching away from schedules", () => {
    const id = publish(defOf(nodes.cron("0 * * * *")));
    workflows.updateDraft(editor, id, { revision: 1, definition: defOf(nodes.manual) });
    workflows.publish(editor, id);
    expect(runs.listSchedules()).toEqual([]);
    const other = publish(defOf(nodes.cron("0 0 * * *")));
    workflows.archive(editor, other);
    expect(runs.listSchedules().find((s) => s.workflowId === other)?.enabled).toBe(false);
    expect(workflows.getPublished(other)).toBeUndefined();
  });

  it("serves immutable versions independent of later drafts", () => {
    const id = publish(defOf(nodes.manual));
    const v1 = workflows.getVersion(id, 1);
    workflows.updateDraft(editor, id, { revision: 1, name: "renamed", definition: defOf(nodes.hook) });
    expect(workflows.getVersion(id, 1)).toEqual(v1);
    expect(workflows.getPublished(id)?.definition.nodes[0]?.type).toBe("trigger.manual");
    expect(workflows.detail(editor, id).name).toBe("renamed");
  });

  it("validates ACL updates and enforces roles", () => {
    const id = publish(defOf(nodes.manual));
    expect(() => workflows.setAcl(editor, id, [{ userId: editor.id, role: "editor" }, { userId: "ghost", role: "viewer" }])).toThrow(/unknown user/);
    expect(() => workflows.setAcl(operator, id, [])).toThrow(/requires editor/);
    expect(() => workflows.create(viewer, { name: "x" })).toThrow(/only editors/);
    expect(workflows.list(viewer).map((w) => w.myRole)).toEqual(["viewer"]);
  });
});

describe("RunService webhooks and events", () => {
  it("accepts HMAC signatures only inside the replay window", () => {
    const id = publish(defOf(nodes.hook));
    const secret = workflows.webhookSecret(id) as string;
    const body = JSON.stringify({ a: 1 });
    const sign = (offsetSeconds: number) => {
      const ts = String(Math.floor(clock.now() / 1000) + offsetSeconds);
      return { "x-ewb-timestamp": ts, "x-ewb-signature": webhookSignature(secret, ts, body) };
    };
    expect(runs.handleWebhook({ workflowId: id, rawBody: body, headers: sign(-299) }).duplicate).toBe(false);
    expect(() => runs.handleWebhook({ workflowId: id, rawBody: body, headers: sign(-301) })).toThrow(/outside the allowed window/);
    expect(() => runs.handleWebhook({ workflowId: id, rawBody: body, headers: sign(301) })).toThrow(/outside the allowed window/);
    expect(() => runs.handleWebhook({ workflowId: id, rawBody: "{oops", headers: { "x-ewb-token": secret } })).toThrow(/must be JSON/);
    expect(() => runs.handleWebhook({ workflowId: id, rawBody: body, headers: { "x-ewb-token": secret, "idempotency-key": "k".repeat(201) } })).toThrow(/too long/);
    expect(metrics.webhookRejected.get({ reason: "stale" })).toBe(2);
  });

  it("reports filter errors per subscriber without failing the publish", () => {
    const ok = publish(defOf(nodes.event("event.payload.n > 1")));
    const broken = publish(defOf(nodes.event("event.payload.n > 'x'")));
    const result = runs.publishEvent(operator, "thing.happened", { n: 5 });
    expect(result.runIds).toHaveLength(1);
    expect(result.skipped).toEqual([{ workflowId: broken, reason: expect.stringMatching(/filter error: cannot compare/) }]);
    expect(runs.list(operator, { workflowId: ok, limit: 10 })[0]?.trigger).toMatchObject({ type: "event" });
    expect(runs.publishEvent(operator, "unrelated", {}).runIds).toEqual([]);
  });

  it("hides runs of workflows the user cannot see", () => {
    const id = publish(defOf(nodes.manual), false);
    const run = runs.startManual(editor, id, {});
    expect(() => runs.detail(viewer, run.id)).toThrow(/run not found/);
    expect(() => runs.startManual(viewer, id, {})).toThrow(/workflow not found/);
    expect(runs.list(viewer, { limit: 10 })).toEqual([]);
  });
});

describe("approvals and notifications", () => {
  const approvalDef = () =>
    defOf(nodes.manual, [{ id: "a", type: "action.approval", name: "a", position: { x: 0, y: 0 }, config: { title: "T", assignees: ["op@x.dev"] } }]);

  it("creates approvals idempotently and notifies resolved assignees", async () => {
    const id = publish(approvalDef());
    const run = runs.startManual(operator, id, {});
    await runs.engine.idle();
    const again = approvals.create({ runId: run.id, nodeId: "a", workflowId: id, title: "T", description: "", assignees: ["op@x.dev"], dueAt: null });
    expect(approvals.list(operator, { mine: true, limit: 10 }).map((a) => a.id)).toEqual([again]);
    expect(notifications.list(operator, true, 10).unread).toBe(1);
    expect(approvals.list(viewer, { mine: true, limit: 10 })).toEqual([]);
    expect(approvals.list(viewer, { mine: false, limit: 10 })).toHaveLength(1);
    expect(() => approvals.decide(viewer, again, "approved", undefined)).toThrow(/not an assignee/);
  });

  it("marks notifications read individually and in bulk", () => {
    notifications.notifyUsers([viewer.id, viewer.id], "info", "a", "b", null);
    notifications.notifyUsers([viewer.id], "info", "c", "d", "/x");
    const { items, unread } = notifications.list(viewer, false, 10);
    expect(unread).toBe(2);
    expect(notifications.markRead(viewer, items[0]!.id)).toBe(1);
    expect(() => notifications.markRead(operator, items[1]!.id)).toThrow(/notification not found/);
    expect(notifications.markRead(viewer, "all")).toBe(1);
    expect(notifications.list(viewer, true, 10).items).toEqual([]);
  });

  it("resolves recipient specs to active users only", () => {
    users.update(viewer.id, { disabled: true });
    expect(users.resolve(["role:viewer", "OP@x.dev", "nobody@x.dev"]).map((u) => u.email)).toEqual(["op@x.dev"]);
  });
});

describe("observability", () => {
  it("filters log levels and renders Prometheus text", () => {
    const lines: string[] = [];
    const log = createLogger("warn", { svc: "t" }, (l) => lines.push(l));
    log.info("hidden");
    log.child({ req: 1 }).warn("shown", { n: 2 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ level: "warn", msg: "shown", svc: "t", req: 1, n: 2 })]);
    const m = new Metrics();
    m.runsStarted.inc({ trigger: "manual" });
    m.httpDuration.observe(30, { route: "/x" });
    const text = m.render();
    expect(text).toContain('ewb_runs_started_total{trigger="manual"} 1');
    expect(text).toContain('ewb_http_request_duration_ms_bucket{route="/x",le="25"} 0');
    expect(text).toContain('ewb_http_request_duration_ms_bucket{route="/x",le="100"} 1');
    expect(text).toContain('ewb_http_request_duration_ms_sum{route="/x"} 30');
  });
});

describe("LiveHub", () => {
  it("delivers run events only to clients allowed to see the workflow", () => {
    const hub = new LiveHub(60_000);
    const writes: Record<string, string[]> = { a: [], b: [] };
    const res = (k: "a" | "b") => ({ write: (chunk: string) => writes[k]!.push(chunk), end: () => undefined }) as never;
    hub.subscribe({ user: editor, res: res("a"), canView: (wf) => wf === "wf_visible" });
    const unsubscribe = hub.subscribe({ user: viewer, res: res("b"), canView: () => false });
    const run = { workflowId: "wf_visible", status: "running" } as never;
    hub.publishRun({ runId: "r1", nodeId: null, type: "run.started", at: 1 }, run);
    hub.publishUser(viewer.id, "notification", { id: "n1" });
    expect(writes.a!.filter((w) => w.startsWith("event: run"))).toHaveLength(1);
    expect(writes.a!.at(-1)).toContain('"runStatus":"running"');
    expect(writes.b!.filter((w) => w.startsWith("event: run"))).toHaveLength(0);
    expect(writes.b!.at(-1)).toBe('event: notification\ndata: {"id":"n1"}\n\n');
    unsubscribe();
    expect(hub.size).toBe(1);
    hub.close();
    expect(hub.size).toBe(0);
  });
});
