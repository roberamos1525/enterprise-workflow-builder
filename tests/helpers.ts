import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, type WorkflowDefinition } from "@ewb/engine";
import { createApp, type App } from "../apps/server/src/app.js";
import type { Role } from "../apps/server/src/auth.js";
import { loadConfig } from "../apps/server/src/config.js";

export const PASSWORD = "Integration#Pass1";
export const ROLE_USERS: Role[] = ["admin", "editor", "operator", "viewer"];

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestApp {
  app: App;
  clock: ManualClock;
  base: string;
  dbPath: string;
  tokens: Record<Role | "outsider", string>;
  userIds: Record<Role | "outsider", string>;
  api<T = any>(method: string, path: string, options?: { token?: string | null; body?: unknown; headers?: Record<string, string>; raw?: string }): Promise<ApiResponse<T>>;
  as(who: Role | "outsider"): <T = any>(method: string, path: string, body?: unknown) => Promise<ApiResponse<T>>;
  /** Waits until the engine has no in-flight step executions. */
  settle(): Promise<void>;
  /** Advances the fake clock, then waits for resulting work. */
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ewb-test-")), "test.db");
}

export async function startTestApp(options: { dbPath?: string; clock?: ManualClock; httpAllowList?: string[] } = {}): Promise<TestApp> {
  const dbPath = options.dbPath ?? tempDbPath();
  const clock = options.clock ?? new ManualClock(Date.parse("2026-06-01T08:00:00Z"));
  const config = loadConfig(
    {},
    {
      env: "test",
      port: 0,
      databasePath: dbPath,
      jwtSecret: "integration-test-secret-0123456789abcdef",
      logLevel: "silent",
      httpAllowList: options.httpAllowList ?? ["127.0.0.1"],
      loginRateLimitPerMinute: 1000,
      bodyLimitBytes: 64 * 1024,
    },
  );
  const app = createApp(config, { clock });
  if (app.users.count() === 0) {
    for (const role of ROLE_USERS) app.users.create({ email: `${role}@test.dev`, name: role, role, password: PASSWORD });
    app.users.create({ email: "outsider@test.dev", name: "outsider", role: "editor", password: PASSWORD });
  }
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;

  const api: TestApp["api"] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    let payload: string | undefined = opts.raw;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers["content-type"] ??= "application/json";
    }
    const res = await fetch(`${base}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (metrics) */
    }
    return { status: res.status, body, headers: res.headers };
  };

  const tokens = {} as Record<Role | "outsider", string>;
  const userIds = {} as Record<Role | "outsider", string>;
  for (const who of [...ROLE_USERS, "outsider"] as const) {
    const res = await api("POST", "/api/auth/login", { body: { email: `${who}@test.dev`, password: PASSWORD } });
    if (res.status !== 200) throw new Error(`login failed for ${who}: ${JSON.stringify(res.body)}`);
    tokens[who] = res.body.token;
    userIds[who] = res.body.user.id;
  }

  return {
    app,
    clock,
    base,
    dbPath,
    tokens,
    userIds,
    api,
    as: (who) => (method, path, body) => api(method, path, { token: tokens[who], body }),
    settle: () => app.engine.idle(),
    async advance(ms) {
      clock.advance(ms);
      await app.engine.idle();
    },
    close: () => app.stop(),
  };
}

/** Creates a workflow as `editor`, shares it with operator+viewer and publishes it. */
export async function createPublished(t: TestApp, name: string, definition: WorkflowDefinition): Promise<string> {
  const created = await t.as("editor")("POST", "/api/workflows", { name, definition });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const id: string = created.body.id;
  await t.as("editor")("PUT", `/api/workflows/${id}/acl`, {
    entries: [
      { userId: t.userIds.editor, role: "editor" },
      { userId: t.userIds.operator, role: "operator" },
      { userId: t.userIds.viewer, role: "viewer" },
    ],
  });
  const published = await t.as("editor")("POST", `/api/workflows/${id}/publish`, { notes: "test" });
  if (published.status !== 201) throw new Error(`publish failed: ${JSON.stringify(published.body)}`);
  return id;
}

export interface StubServer {
  url: string;
  requests: { method: string; url: string; body: string }[];
  /** Replace to script responses; may leave the response pending. */
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  close(): Promise<void>;
}

/** A local HTTP endpoint the workflow HTTP action can call (allow-listed in tests). */
export async function startStub(): Promise<StubServer> {
  const stub: StubServer = {
    url: "",
    requests: [],
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      stub.requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body });
      stub.handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

let edgeId = 0;
export const n = (id: string, type: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  config,
  ...extra,
});
export const e = (from: string, to: string) => {
  const [sn, sp = "out"] = from.split(".");
  return { id: `e${++edgeId}`, source: { node: sn!, port: sp }, target: { node: to, port: "in" } };
};
export const def = (nodes: ReturnType<typeof n>[], edges: ReturnType<typeof e>[], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
  ({ schemaVersion: 1, nodes, edges, ...extra }) as WorkflowDefinition;
