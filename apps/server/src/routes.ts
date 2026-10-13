import { listBuiltins, NODE_TYPES, validateDefinition } from "@ewb/engine";
import { z } from "zod";
import { RateLimiter, roleAtLeast, ROLES, signToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import { forbidden, rateLimited } from "./errors.js";
import { reply, type RequestContext, type Router } from "./http.js";
import type { Metrics } from "./observability.js";
import type { ApprovalService, LiveHub, NotificationService } from "./services/collaboration.js";
import type { RunService } from "./services/runs.js";
import type { UserService } from "./services/users.js";
import type { WorkflowService } from "./services/workflows.js";

export interface RouteDeps {
  config: AppConfig;
  users: UserService;
  workflows: WorkflowService;
  runs: RunService;
  approvals: ApprovalService;
  notifications: NotificationService;
  hub: LiveHub;
  metrics: Metrics;
  now: () => number;
  ready: () => boolean;
}

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, "password must be at least 8 characters").max(200);
const role = z.enum(ROLES);
const name = z.string().trim().min(1).max(120);
const limit = (dflt: number, max: number) => z.coerce.number().int().min(1).max(max).default(dflt);
const RUN_STATUSES = ["running", "waiting", "succeeded", "failed", "cancelled"] as const;

function query<T extends z.ZodType>(ctx: RequestContext, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(ctx.query.entries()));
}

function requireAdmin(ctx: RequestContext): void {
  if (ctx.user.role !== "admin") throw forbidden("admin role required");
}

export function registerRoutes(router: Router, deps: RouteDeps): void {
  const { config, users, workflows, runs, approvals, notifications, hub } = deps;
  const loginLimiter = new RateLimiter(config.loginRateLimitPerMinute, 60_000, deps.now);
  const webhookLimiter = new RateLimiter(config.webhookRateLimitPerMinute, 60_000, deps.now);

  // ---------------------------------------------------------------- system

  router.get("/api/health", () => (deps.ready() ? { status: "ok" } : reply(503, { status: "starting" })), { auth: false });
  router.get("/metrics", () => reply(200, deps.metrics.render(), { "content-type": "text/plain; version=0.0.4" }), { auth: false });
  router.get("/api/catalog", () => ({
    nodeTypes: NODE_TYPES.map(({ validate: _v, ...spec }) => spec),
    functions: listBuiltins(),
  }));

  // ---------------------------------------------------------------- auth & users

  router.post(
    "/api/auth/login",
    async (ctx) => {
      const retry = loginLimiter.hit(ctx.ip);
      if (retry > 0) throw rateLimited(retry);
      const body = await ctx.body(z.object({ email, password: z.string().min(1).max(200) }));
      const user = users.authenticate(body.email, body.password);
      const token = signToken({ sub: user.id, role: user.role, email: user.email }, config.jwtSecret, config.jwtTtlSeconds, deps.now());
      return { token, expiresIn: config.jwtTtlSeconds, user };
    },
    { auth: false },
  );
  router.get("/api/auth/me", (ctx) => users.get(ctx.user.id));
  router.get("/api/users", (ctx) => {
    if (!roleAtLeast(ctx.user.role, "editor")) throw forbidden("editor role required");
    const list = users.list();
    // Non-admins only need identities for sharing; hide account state.
    return ctx.user.role === "admin" ? list : list.filter((u) => !u.disabled).map(({ id, email: e, name: n, role: r }) => ({ id, email: e, name: n, role: r }));
  });
  router.post("/api/users", async (ctx) => {
    requireAdmin(ctx);
    return reply(201, users.create(await ctx.body(z.object({ email, name, role, password }))));
  });
  router.patch("/api/users/:id", async (ctx) => {
    requireAdmin(ctx);
    const patch = await ctx.body(z.object({ name: name.optional(), role: role.optional(), disabled: z.boolean().optional(), password: password.optional() }));
    if (ctx.params["id"] === ctx.user.id && (patch.disabled || (patch.role && patch.role !== "admin"))) {
      throw forbidden("you cannot demote or disable your own account");
    }
    return users.update(ctx.params["id"] as string, patch);
  });

  // ---------------------------------------------------------------- workflows

  const id = (ctx: RequestContext) => ctx.params["id"] as string;

  router.get("/api/workflows", (ctx) => workflows.list(ctx.user));
  router.post("/api/workflows", async (ctx) => {
    const body = await ctx.body(z.object({ name, description: z.string().max(2000).optional(), definition: z.unknown().optional() }));
    return reply(201, workflows.create(ctx.user, body));
  });
  router.get("/api/workflows/:id", (ctx) => workflows.detail(ctx.user, id(ctx)));
  router.put("/api/workflows/:id", async (ctx) => {
    const body = await ctx.body(
      z.object({ revision: z.number().int().min(1), name: name.optional(), description: z.string().max(2000).optional(), definition: z.unknown().optional() }),
    );
    return workflows.updateDraft(ctx.user, id(ctx), body);
  });
  router.delete("/api/workflows/:id", (ctx) => {
    workflows.archive(ctx.user, id(ctx));
  });
  router.post("/api/workflows/:id/validate", async (ctx) => {
    const body = await ctx.body(z.object({ definition: z.unknown().optional() }));
    const definition = body.definition ?? workflows.detail(ctx.user, id(ctx)).draft;
    const { valid, issues } = validateDefinition(definition);
    return { valid, issues };
  });
  router.post("/api/workflows/:id/publish", async (ctx) => {
    const body = await ctx.body(z.object({ notes: z.string().max(500).optional() }));
    return reply(201, workflows.publish(ctx.user, id(ctx), body.notes));
  });
  router.get("/api/workflows/:id/versions", (ctx) => workflows.versions(ctx.user, id(ctx)));
  router.get("/api/workflows/:id/versions/:version", (ctx) => {
    const version = z.coerce.number().int().min(1).parse(ctx.params["version"]);
    return workflows.versionDetail(ctx.user, id(ctx), version);
  });
  router.get("/api/workflows/:id/diff", (ctx) => {
    const q = query(ctx, z.object({ from: z.string().min(1).max(20), to: z.string().min(1).max(20).default("draft") }));
    return workflows.diff(ctx.user, id(ctx), q.from, q.to);
  });
  router.post("/api/workflows/:id/webhook/rotate", (ctx) => ({ secret: workflows.rotateSecret(ctx.user, id(ctx)) }));
  router.get("/api/workflows/:id/acl", (ctx) => workflows.acl(ctx.user, id(ctx)));
  router.put("/api/workflows/:id/acl", async (ctx) => {
    const body = await ctx.body(
      z.object({ entries: z.array(z.object({ userId: z.string().min(1), role: z.enum(["editor", "operator", "viewer"]) })).max(200) }),
    );
    return workflows.setAcl(ctx.user, id(ctx), body.entries);
  });
  router.post("/api/workflows/:id/runs", async (ctx) => {
    const body = await ctx.body(z.object({ input: z.unknown().optional(), version: z.number().int().min(1).optional() }));
    return reply(201, runs.startManual(ctx.user, id(ctx), body.input ?? {}, body.version));
  });

  // ---------------------------------------------------------------- runs & dashboard

  router.get("/api/runs", (ctx) => {
    const q = query(
      ctx,
      z.object({
        workflowId: z.string().max(64).optional(),
        status: z.enum(RUN_STATUSES).optional(),
        before: z.coerce.number().int().optional(),
        limit: limit(50, 200),
      }),
    );
    const items = runs.list(ctx.user, q);
    return { items, nextBefore: items.length === q.limit ? items.at(-1)?.createdAt : null };
  });
  router.get("/api/runs/:id", (ctx) => runs.detail(ctx.user, id(ctx)));
  router.post("/api/runs/:id/cancel", async (ctx) => {
    const body = await ctx.body(z.object({ reason: z.string().max(500).optional() }));
    return runs.cancel(ctx.user, id(ctx), body.reason);
  });
  router.get("/api/metrics/summary", (ctx) => {
    const q = query(ctx, z.object({ workflowId: z.string().max(64).optional(), days: z.coerce.number().int().min(1).max(90).default(14) }));
    return runs.stats(ctx.user, q.workflowId, q.days);
  });

  // ---------------------------------------------------------------- approvals & notifications

  router.get("/api/approvals", (ctx) => {
    const q = query(ctx, z.object({ status: z.enum(["pending", "approved", "rejected", "timed_out", "cancelled"]).optional(), mine: z.enum(["true", "false"]).default("false"), limit: limit(100, 500) }));
    return approvals.list(ctx.user, { status: q.status, mine: q.mine === "true", limit: q.limit });
  });
  router.get("/api/approvals/:id", (ctx) => approvals.get(ctx.user, id(ctx)));
  router.post("/api/approvals/:id/decision", async (ctx) => {
    const body = await ctx.body(z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(2000).optional() }));
    return approvals.decide(ctx.user, id(ctx), body.decision, body.comment);
  });
  router.get("/api/notifications", (ctx) => {
    const q = query(ctx, z.object({ unread: z.enum(["true", "false"]).default("false"), limit: limit(50, 200) }));
    return notifications.list(ctx.user, q.unread === "true", q.limit);
  });
  router.post("/api/notifications/read-all", (ctx) => ({ updated: notifications.markRead(ctx.user, "all") }));
  router.post("/api/notifications/:id/read", (ctx) => ({ updated: notifications.markRead(ctx.user, id(ctx)) }));

  // ---------------------------------------------------------------- triggers

  router.post(
    "/api/hooks/:id",
    async (ctx) => {
      const retry = webhookLimiter.hit(`${id(ctx)}:${ctx.ip}`);
      if (retry > 0) throw rateLimited(retry);
      const headers: Record<string, string | undefined> = {};
      for (const h of ["x-ewb-token", "x-ewb-signature", "x-ewb-timestamp", "idempotency-key"]) {
        const v = ctx.req.headers[h];
        headers[h] = Array.isArray(v) ? v[0] : v;
      }
      const result = runs.handleWebhook({ workflowId: id(ctx), rawBody: await ctx.rawBody(), headers });
      return reply(result.duplicate ? 200 : 202, result);
    },
    { auth: false },
  );
  router.post("/api/events", async (ctx) => {
    const body = await ctx.body(z.object({ type: z.string().trim().min(1).max(120), payload: z.unknown().optional() }));
    return reply(202, runs.publishEvent(ctx.user, body.type, body.payload ?? {}));
  });

  // ---------------------------------------------------------------- live stream (SSE over fetch)

  router.get("/api/stream", (ctx) => {
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const cache = new Map<string, boolean>();
    const unsubscribe = hub.subscribe({
      user: ctx.user,
      res: ctx.res,
      canView: (workflowId) => {
        let allowed = cache.get(workflowId);
        if (allowed === undefined) {
          allowed = workflows.roleFor(ctx.user, workflowId) !== undefined;
          cache.set(workflowId, allowed);
        }
        return allowed;
      },
    });
    ctx.req.on("close", unsubscribe);
  });
}
