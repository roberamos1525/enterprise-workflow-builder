import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { signToken, type AuthUser } from "./auth.js";
import { AppError } from "./errors.js";
import { reply, Router } from "./http.js";
import { createLogger, Metrics } from "./observability.js";

const SECRET = "router-test-secret-0123456789abcdef";
const alice: AuthUser = { id: "u1", email: "alice@x", name: "Alice", role: "editor" };

let server: Server;
let base = "";
let metrics: Metrics;
const logLines: string[] = [];

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), "ewb-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<html>app</html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(tmpdir(), "ewb-outside.txt"), "secret");
  metrics = new Metrics();
  const router = new Router({
    bodyLimit: 2048,
    jwtSecret: SECRET,
    loadUser: (id) => (id === alice.id ? alice : undefined),
    logger: createLogger("error", {}, (l) => logLines.push(l)),
    metrics,
    webDist: dist,
    now: () => Date.now(),
  });
  router.get("/api/public", () => ({ hello: "world" }), { auth: false });
  router.get("/api/me", (ctx) => ctx.user);
  router.get("/api/items/:id/parts/:part", (ctx) => ctx.params);
  router.post("/api/echo", async (ctx) => reply(201, await ctx.body(z.object({ n: z.number().int() }))));
  router.get("/api/boom", () => {
    throw new Error("internal detail");
  }, { auth: false });
  router.get("/api/limited", () => {
    throw new AppError(429, "RATE_LIMITED", "slow down", { retryAfterSeconds: 7 });
  }, { auth: false });
  server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const token = signToken({ sub: alice.id, role: alice.role, email: alice.email }, SECRET, 60);
const auth = { authorization: `Bearer ${token}` };

describe("Router", () => {
  it("routes with params and authenticates bearer tokens", async () => {
    expect(await (await fetch(`${base}/api/public`)).json()).toEqual({ hello: "world" });
    expect(await (await fetch(`${base}/api/me`, { headers: auth })).json()).toEqual(alice);
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    const ghost = signToken({ sub: "deleted", role: "admin", email: "g@x" }, SECRET, 60);
    const res = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${ghost}` } });
    expect((await res.json()).error.message).toMatch(/disabled or no longer exists/);
    expect(await (await fetch(`${base}/api/items/a%20b/parts/7`, { headers: auth })).json()).toEqual({ id: "a b", part: "7" });
  });

  it("validates JSON bodies against schemas", async () => {
    const ok = await fetch(`${base}/api/echo`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"n":3}' });
    expect(ok.status).toBe(201);
    const bad = await fetch(`${base}/api/echo`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"n":"x"}' });
    expect((await bad.json()).error).toMatchObject({ code: "BAD_REQUEST", details: [{ path: "n" }] });
    const big = await fetch(`${base}/api/echo`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ n: 1, pad: "x".repeat(5000) }) });
    expect(big.status).toBe(413);
  });

  it("hides internal errors and logs them", async () => {
    const res = await fetch(`${base}/api/boom`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("internal detail");
    expect(logLines.some((l) => l.includes("internal detail"))).toBe(true);
  });

  it("sets Retry-After on rate limiting", async () => {
    const res = await fetch(`${base}/api/limited`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("serves the SPA with fallback, caching headers and no path traversal", async () => {
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const deep = await fetch(`${base}/workflows/wf_1`);
    expect(await deep.text()).toBe("<html>app</html>");
    expect(deep.headers.get("content-security-policy")).toContain("default-src 'self'");
    const traversal = await fetch(`${base}/..%2f..%2fewb-outside.txt`);
    expect(await traversal.text()).not.toBe("secret");
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });

  it("records request metrics per route", () => {
    const rendered = metrics.render();
    expect(rendered).toContain('route="/api/items/:id/parts/:part"');
    expect(rendered).toMatch(/ewb_http_request_duration_ms_bucket\{route="\/api\/public",le="\+Inf"\} \d+/);
  });
});
