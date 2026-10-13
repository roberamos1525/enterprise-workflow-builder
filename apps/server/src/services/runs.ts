import { randomUUID } from "node:crypto";
import {
  compileExpression,
  ExpressionError,
  isTriggerType,
  truthy,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  type ScheduleEntry,
  type ScheduleStore,
  type StepRecord,
  type WorkflowDefinition,
  type WorkflowEngine,
} from "@ewb/engine";
import { roleAtLeast, safeEqual, webhookSignature, type AuthUser } from "../auth.js";
import { json, type Database } from "../db/database.js";
import type { RunSummaryStats, SqliteRunStore } from "../db/run-store.js";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import type { Logger, Metrics } from "../observability.js";
import type { WorkflowService } from "./workflows.js";

export interface RunDetail {
  run: RunRecord;
  steps: StepRecord[];
  events: RunEvent[];
  definition: WorkflowDefinition | null;
  children: RunRecord[];
}

export interface WebhookRequest {
  workflowId: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
}

/** Signed webhook timestamps older/newer than this are rejected (replay protection). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export class RunService implements ScheduleStore {
  engine!: WorkflowEngine;

  constructor(
    private readonly db: Database,
    private readonly store: SqliteRunStore,
    private readonly workflows: WorkflowService,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly now: () => number,
  ) {}

  // ---------------------------------------------------------------- manual & queries

  startManual(user: AuthUser, workflowId: string, input: unknown, version?: number): RunRecord {
    this.workflows.require(user, workflowId, "operator");
    return this.start(workflowId, input, { type: "manual", meta: { by: user.email } }, user.id, version);
  }

  private start(workflowId: string, input: unknown, trigger: RunRecord["trigger"], createdBy: string | null, version?: number): RunRecord {
    const run = this.engine.startRun({ workflowId, input, trigger, createdBy, ...(version !== undefined ? { version } : {}) });
    this.metrics.runsStarted.inc({ trigger: trigger.type });
    this.logger.info("run started", { runId: run.id, workflowId, version: run.version, trigger: trigger.type });
    return run;
  }

  list(user: AuthUser, query: { workflowId?: string | undefined; status?: RunStatus | undefined; before?: number | undefined; limit: number }): RunRecord[] {
    let ids = this.workflows.visibleIds(user);
    if (query.workflowId) {
      this.workflows.require(user, query.workflowId, "viewer");
      ids = [query.workflowId];
    }
    return this.store.queryRuns({
      ...(ids ? { workflowIds: ids } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.before !== undefined ? { before: query.before } : {}),
      limit: query.limit,
    });
  }

  private requireRun(user: AuthUser, runId: string, min: "viewer" | "operator"): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw notFound("run");
    const role = this.workflows.roleFor(user, run.workflowId);
    if (!role) throw notFound("run");
    if (!roleAtLeast(role, min)) throw forbidden(`requires ${min} access`);
    return run;
  }

  detail(user: AuthUser, runId: string): RunDetail {
    const run = this.requireRun(user, runId, "viewer");
    return {
      run,
      steps: this.store.listSteps(runId),
      events: this.store.listEvents(runId),
      definition: this.workflows.getVersion(run.workflowId, run.version) ?? null,
      children: this.store.findChildRuns(runId),
    };
  }

  cancel(user: AuthUser, runId: string, reason?: string): RunRecord {
    this.requireRun(user, runId, "operator");
    return this.engine.cancel(runId, reason ?? `cancelled by ${user.email}`);
  }

  stats(user: AuthUser, workflowId: string | undefined, days: number): RunSummaryStats {
    let ids = this.workflows.visibleIds(user);
    if (workflowId) {
      this.workflows.require(user, workflowId, "viewer");
      ids = [workflowId];
    }
    const now = this.now();
    const since = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (days - 1) * 86_400_000;
    return this.store.stats(ids, since, now);
  }

  // ---------------------------------------------------------------- webhook trigger

  /**
   * Authenticates a webhook call with either `X-EWB-Token: <secret>` or an HMAC
   * signature `X-EWB-Signature: sha256=<hex>` over `<timestamp>.<body>` with
   * `X-EWB-Timestamp` (epoch seconds) within the tolerance window.
   */
  handleWebhook(req: WebhookRequest): { runId: string; duplicate: boolean } {
    const secret = this.workflows.webhookSecret(req.workflowId);
    if (!secret) throw notFound("webhook");
    const token = req.headers["x-ewb-token"];
    const signature = req.headers["x-ewb-signature"];
    const timestamp = req.headers["x-ewb-timestamp"];
    let authenticated = false;
    if (token !== undefined) authenticated = safeEqual(token, secret);
    else if (signature !== undefined && timestamp !== undefined) {
      const ts = Number(timestamp) * 1000;
      if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > WEBHOOK_TOLERANCE_MS) {
        this.metrics.webhookRejected.inc({ reason: "stale" });
        throw unauthorized("webhook timestamp outside the allowed window");
      }
      authenticated = safeEqual(signature, webhookSignature(secret, timestamp, req.rawBody));
    }
    if (!authenticated) {
      this.metrics.webhookRejected.inc({ reason: "auth" });
      throw unauthorized("invalid webhook credentials");
    }
    const published = this.workflows.getPublished(req.workflowId);
    const trigger = published?.definition.nodes.find((n) => isTriggerType(n.type));
    if (!published || trigger?.type !== "trigger.webhook") {
      this.metrics.webhookRejected.inc({ reason: "not_webhook" });
      throw new AppError(409, "NOT_WEBHOOK", "the published version of this workflow has no webhook trigger");
    }
    let body: unknown = {};
    if (req.rawBody.trim() !== "") {
      try {
        body = JSON.parse(req.rawBody);
      } catch {
        throw badRequest("webhook body must be JSON");
      }
    }
    const idempotencyKey = req.headers["idempotency-key"];
    if (idempotencyKey !== undefined) {
      if (idempotencyKey.length > 200) throw badRequest("Idempotency-Key is too long");
      const prior = this.db.get<{ run_id: string }>(
        "SELECT run_id FROM webhook_receipts WHERE workflow_id = ? AND idempotency_key = ?", req.workflowId, idempotencyKey,
      );
      if (prior) return { runId: prior.run_id, duplicate: true };
    }
    const run = this.db.transaction(() => {
      const started = this.start(req.workflowId, body, { type: "webhook", meta: { idempotencyKey: idempotencyKey ?? null } }, null);
      if (idempotencyKey !== undefined) {
        this.db.run(
          "INSERT INTO webhook_receipts (workflow_id, idempotency_key, run_id, created_at) VALUES (?, ?, ?, ?)",
          req.workflowId, idempotencyKey, started.id, this.now(),
        );
      }
      return started;
    });
    return { runId: run.id, duplicate: false };
  }

  // ---------------------------------------------------------------- event trigger

  publishEvent(user: AuthUser, type: string, payload: unknown): { eventId: string; runIds: string[]; skipped: { workflowId: string; reason: string }[] } {
    if (!roleAtLeast(user.role, "operator")) throw forbidden("publishing events requires the operator role");
    const eventId = randomUUID();
    const event = { id: eventId, type, payload };
    const runIds: string[] = [];
    const skipped: { workflowId: string; reason: string }[] = [];
    const subscribers = this.db.all<{ workflow_id: string }>(
      "SELECT workflow_id FROM triggers WHERE type = 'trigger.event' AND event_type = ? AND enabled = 1 ORDER BY workflow_id", type,
    );
    for (const { workflow_id: workflowId } of subscribers) {
      const published = this.workflows.getPublished(workflowId);
      const trigger = published?.definition.nodes.find((n) => n.type === "trigger.event");
      if (!trigger) continue;
      const filter = trigger.config["filter"];
      try {
        if (typeof filter === "string" && filter.trim() !== "" && !truthy(compileExpression(filter).evaluate({ event }, { now: this.now }))) {
          skipped.push({ workflowId, reason: "filter" });
          continue;
        }
        runIds.push(this.start(workflowId, event, { type: "event", meta: { eventId, eventType: type } }, user.id).id);
      } catch (err) {
        const reason = err instanceof ExpressionError ? `filter error: ${err.message}` : (err as Error).message;
        skipped.push({ workflowId, reason });
        this.logger.warn("event trigger failed", { workflowId, eventType: type, reason });
      }
    }
    this.db.run(
      "INSERT INTO events (id, type, payload, published_by, run_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      eventId, type, json(payload), user.id, json(runIds), this.now(),
    );
    return { eventId, runIds, skipped };
  }

  // ---------------------------------------------------------------- schedule trigger (ScheduleStore)

  listSchedules(): ScheduleEntry[] {
    return this.db
      .all<{ workflow_id: string; cron: string; enabled: number; next_fire_at: number | null; last_fired_at: number | null }>(
        "SELECT workflow_id, cron, enabled, next_fire_at, last_fired_at FROM triggers WHERE type = 'trigger.schedule' AND cron IS NOT NULL",
      )
      .map((r) => ({
        id: r.workflow_id,
        workflowId: r.workflow_id,
        cron: r.cron,
        enabled: r.enabled === 1,
        nextFireAt: r.next_fire_at,
        lastFiredAt: r.last_fired_at,
      }));
  }

  updateSchedule(id: string, patch: { nextFireAt: number | null; lastFiredAt?: number | null }): void {
    this.db.run("UPDATE triggers SET next_fire_at = ? WHERE workflow_id = ?", patch.nextFireAt, id);
    if (patch.lastFiredAt !== undefined) this.db.run("UPDATE triggers SET last_fired_at = ? WHERE workflow_id = ?", patch.lastFiredAt, id);
  }

  fireSchedule(entry: ScheduleEntry, scheduledFor: number): void {
    const published = this.workflows.getPublished(entry.workflowId);
    const trigger = published?.definition.nodes.find((n) => n.type === "trigger.schedule");
    if (!trigger) return;
    const payload = trigger.config["payload"];
    const input = { ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}), scheduledFor: new Date(scheduledFor).toISOString() };
    this.start(entry.workflowId, input, { type: "schedule", meta: { cron: entry.cron, scheduledFor } }, null);
  }
}
