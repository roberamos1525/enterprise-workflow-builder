import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublished, def, e, n, startTestApp, type TestApp } from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

const simple = () => def([n("start", "trigger.manual"), n("calc", "action.transform", { expression: "trigger.x * 2" })], [e("start", "calc")]);

describe("auth & users", () => {
  it("logs in and returns the current user", async () => {
    const me = await t.as("operator")("GET", "/api/auth/me");
    expect(me.body).toMatchObject({ email: "operator@test.dev", role: "operator" });
    expect(me.body).not.toHaveProperty("password_hash");
  });

  it("rejects bad credentials and missing/invalid tokens with the error envelope", async () => {
    const bad = await t.api("POST", "/api/auth/login", { body: { email: "admin@test.dev", password: "nope" } });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatchObject({ code: "UNAUTHORIZED", message: "invalid email or password" });
    expect(bad.body.error.requestId).toBeTruthy();
    expect((await t.api("GET", "/api/workflows")).status).toBe(401);
    expect((await t.api("GET", "/api/workflows", { token: "abc.def.ghi" })).status).toBe(401);
  });

  it("lets admins manage users and blocks everyone else", async () => {
    const created = await t.as("admin")("POST", "/api/users", { email: "new@test.dev", name: "New", role: "viewer", password: "longenough1" });
    expect(created.status).toBe(201);
    expect((await t.as("editor")("POST", "/api/users", { email: "x@test.dev", name: "X", role: "admin", password: "longenough1" })).status).toBe(403);
    expect((await t.as("admin")("POST", "/api/users", { email: "new@test.dev", name: "dup", role: "viewer", password: "longenough1" })).status).toBe(409);
    const invalid = await t.as("admin")("POST", "/api/users", { email: "not-an-email", name: "", role: "god", password: "x" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "name", "password", "role"]);
    const disabled = await t.as("admin")("PATCH", `/api/users/${created.body.id}`, { disabled: true });
    expect(disabled.body.disabled).toBe(true);
    const login = await t.api("POST", "/api/auth/login", { body: { email: "new@test.dev", password: "longenough1" } });
    expect(login.status).toBe(401);
    expect((await t.as("admin")("PATCH", `/api/users/${t.userIds.admin}`, { role: "viewer" })).status).toBe(403);
  });

  it("hides account state from non-admin user listings", async () => {
    const list = await t.as("editor")("GET", "/api/users");
    expect(list.body[0]).not.toHaveProperty("disabled");
    expect((await t.as("viewer")("GET", "/api/users")).status).toBe(403);
  });
});

describe("workflow lifecycle", () => {
  it("creates, edits with optimistic concurrency, validates and publishes immutable versions", async () => {
    const editor = t.as("editor");
    const created = await editor("POST", "/api/workflows", { name: "Doubler", definition: simple() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ draftRevision: 1, publishedVersion: null, myRole: "editor", validation: { valid: true } });
    const id = created.body.id;

    const broken = simple();
    broken.nodes.push(n("orphan", "action.transform", { expression: "1 +" }));
    const saved = await editor("PUT", `/api/workflows/${id}`, { revision: 1, definition: broken });
    expect(saved.status).toBe(200);
    expect(saved.body.validation.valid).toBe(false);
    expect(saved.body.validation.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["unreachable", "invalid_config"]));

    const stale = await editor("PUT", `/api/workflows/${id}`, { revision: 1, name: "stale" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toEqual({ currentRevision: 2 });

    const rejected = await editor("POST", `/api/workflows/${id}/publish`, {});
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe("VALIDATION_FAILED");

    await editor("PUT", `/api/workflows/${id}`, { revision: 2, definition: simple() });
    const v1 = await editor("POST", `/api/workflows/${id}/publish`, { notes: "first" });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, notes: "first" });
    expect((await editor("POST", `/api/workflows/${id}/publish`, {})).status).toBe(409);

    const changed = simple();
    changed.nodes[1]!.config = { expression: "trigger.x * 3" };
    await editor("PUT", `/api/workflows/${id}`, { revision: 3, definition: changed });
    expect((await editor("POST", `/api/workflows/${id}/publish`, {})).body.version).toBe(2);

    const versions = await editor("GET", `/api/workflows/${id}/versions`);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const old = await editor("GET", `/api/workflows/${id}/versions/1`);
    expect(old.body.definition.nodes[1].config.expression).toBe("trigger.x * 2");

    const diff = await editor("GET", `/api/workflows/${id}/diff?from=1&to=2`);
    expect(diff.body.changedNodes).toEqual([
      { nodeId: "calc", name: "calc", type: "action.transform", changes: [{ path: "config.expression", before: "trigger.x * 2", after: "trigger.x * 3" }] },
    ]);
    expect((await editor("GET", `/api/workflows/${id}/diff?from=2&to=draft`)).body.identical).toBe(true);
    expect((await editor("GET", `/api/workflows/${id}/diff?from=abc`)).status).toBe(400);

    // Runs are pinned to the version they started on.
    const runV1 = await editor("POST", `/api/workflows/${id}/runs`, { input: { x: 5 }, version: 1 });
    const runLatest = await editor("POST", `/api/workflows/${id}/runs`, { input: { x: 5 } });
    await t.settle();
    const d1 = await editor("GET", `/api/runs/${runV1.body.id}`);
    const d2 = await editor("GET", `/api/runs/${runLatest.body.id}`);
    expect(d1.body.steps.find((s: { nodeId: string }) => s.nodeId === "calc").output).toBe(10);
    expect(d2.body.steps.find((s: { nodeId: string }) => s.nodeId === "calc").output).toBe(15);
    expect(d1.body.definition.nodes[1].config.expression).toBe("trigger.x * 2");
  });

  it("rejects structurally malformed drafts", async () => {
    const res = await t.as("editor")("POST", "/api/workflows", { name: "bad", definition: { schemaVersion: 1, nodes: "x", edges: [] } });
    expect(res.status).toBe(422);
  });

  it("validates arbitrary definitions on demand", async () => {
    const id = (await t.as("editor")("POST", "/api/workflows", { name: "v" })).body.id;
    const res = await t.as("editor")("POST", `/api/workflows/${id}/validate`, {
      definition: def([n("a", "trigger.manual"), n("b", "flow.branch", {})], [e("a", "b"), e("b.true", "b")]),
    });
    expect(res.body.valid).toBe(false);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["missing_config", "self_loop"]));
  });

  it("archives workflows", async () => {
    const id = await createPublished(t, "Temp", simple());
    expect((await t.as("editor")("DELETE", `/api/workflows/${id}`)).status).toBe(204);
    expect((await t.as("editor")("GET", `/api/workflows/${id}`)).status).toBe(404);
  });
});

describe("per-workflow permissions", () => {
  let id: string;
  beforeAll(async () => {
    id = await createPublished(t, "Shared", simple());
  });

  it("hides workflows from users without an ACL entry", async () => {
    expect((await t.as("outsider")("GET", `/api/workflows/${id}`)).status).toBe(404);
    expect((await t.as("outsider")("GET", "/api/workflows")).body.map((w: { id: string }) => w.id)).not.toContain(id);
    expect((await t.as("admin")("GET", `/api/workflows/${id}`)).body.myRole).toBe("admin");
  });

  it("lets operators run but not edit, and viewers only read", async () => {
    expect((await t.as("operator")("POST", `/api/workflows/${id}/runs`, { input: { x: 1 } })).status).toBe(201);
    expect((await t.as("operator")("PUT", `/api/workflows/${id}`, { revision: 1, name: "x" })).status).toBe(403);
    expect((await t.as("viewer")("POST", `/api/workflows/${id}/runs`, { input: {} })).status).toBe(403);
    const detail = await t.as("viewer")("GET", `/api/workflows/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.webhook.secret).toBeUndefined();
    expect((await t.as("editor")("GET", `/api/workflows/${id}`)).body.webhook.secret).toMatch(/^[0-9a-f]{48}$/);
    await t.settle();
  });

  it("manages the ACL and keeps at least one editor", async () => {
    const editor = t.as("editor");
    expect((await editor("PUT", `/api/workflows/${id}/acl`, { entries: [{ userId: t.userIds.viewer, role: "viewer" }] })).status).toBe(400);
    const acl = await editor("PUT", `/api/workflows/${id}/acl`, {
      entries: [{ userId: t.userIds.editor, role: "editor" }, { userId: t.userIds.outsider, role: "viewer" }],
    });
    expect(acl.body.map((a: { email: string }) => a.email)).toEqual(["editor@test.dev", "outsider@test.dev"]);
    expect((await t.as("outsider")("GET", `/api/workflows/${id}`)).body.myRole).toBe("viewer");
    expect((await t.as("operator")("GET", `/api/workflows/${id}`)).status).toBe(404);
  });

  it("filters run listings by visibility", async () => {
    const runs = await t.as("outsider")("GET", `/api/runs?workflowId=${id}`);
    expect(runs.status).toBe(200);
    expect(runs.body.items.length).toBeGreaterThan(0);
    expect((await t.as("viewer")("GET", `/api/runs?workflowId=${id}`)).status).toBe(404);
  });
});

describe("HTTP edge cases", () => {
  it("returns envelopes for unknown routes, wrong methods, bad JSON, wrong media types and big bodies", async () => {
    const token = t.tokens.editor;
    expect((await t.api("GET", "/api/nope", { token })).body.error.code).toBe("NOT_FOUND");
    expect((await t.api("PATCH", "/api/workflows", { token })).status).toBe(405);
    expect((await t.api("POST", "/api/workflows", { token, raw: "{oops", headers: { "content-type": "application/json" } })).body.error.message).toBe("malformed JSON body");
    expect((await t.api("POST", "/api/workflows", { token, raw: "name=x", headers: { "content-type": "text/plain" } })).status).toBe(415);
    const big = await t.api("POST", "/api/workflows", { token, raw: JSON.stringify({ name: "x".repeat(70_000) }), headers: { "content-type": "application/json" } });
    expect(big.status).toBe(413);
  });

  it("sets security headers and exposes health, catalog and Prometheus metrics", async () => {
    const health = await t.api("GET", "/api/health");
    expect(health.body).toEqual({ status: "ok" });
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-request-id")).toBeTruthy();
    const catalog = await t.as("viewer")("GET", "/api/catalog");
    expect(catalog.body.nodeTypes.map((x: { type: string }) => x.type)).toContain("action.approval");
    expect(catalog.body.functions.length).toBeGreaterThan(40);
    const metrics = await t.api("GET", "/metrics");
    expect(metrics.body).toContain("ewb_http_requests_total");
    expect(metrics.body).toContain('ewb_runs_started_total{trigger="manual"}');
  });
});
