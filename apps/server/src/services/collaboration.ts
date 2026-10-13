import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ApprovalHost, ApprovalRequest, HttpClient, Notifier, RunEvent, RunRecord, WorkflowEngine } from "@ewb/engine";
import { matchesAssignee, type AuthUser } from "../auth.js";
import { json, parseJson, type Database } from "../db/database.js";
import { conflict, forbidden, notFound } from "../errors.js";
import type { Logger } from "../observability.js";
import type { UserService } from "./users.js";
import type { WorkflowService } from "./workflows.js";

// ------------------------------------------------------------------ live updates (SSE)

interface LiveClient {
  user: AuthUser;
  res: ServerResponse;
  canView: (workflowId: string) => boolean;
}

/** Fan-out of run events and notifications to connected Server-Sent-Events clients. */
export class LiveHub {
  private readonly clients = new Set<LiveClient>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(heartbeatMs = 25_000) {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(": ping\n\n");
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  subscribe(client: LiveClient): () => void {
    this.clients.add(client);
    client.res.write(`event: hello\ndata: ${JSON.stringify({ userId: client.user.id })}\n\n`);
    return () => this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  publishRun(event: RunEvent, run: RunRecord): void {
    const payload = JSON.stringify({ ...event, workflowId: run.workflowId, runStatus: run.status });
    for (const c of this.clients) {
      if (c.canView(run.workflowId)) c.res.write(`event: run\ndata: ${payload}\n\n`);
    }
  }

  publishUser(userId: string, type: string, data: unknown): void {
    const payload = JSON.stringify(data);
    for (const c of this.clients) if (c.user.id === userId) c.res.write(`event: ${type}\ndata: ${payload}\n\n`);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}

// ------------------------------------------------------------------ notifications

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: number | null;
  createdAt: number;
}

export class NotificationService implements Notifier {
  constructor(
    private readonly db: Database,
    private readonly users: UserService,
    private readonly http: HttpClient,
    private readonly hub: LiveHub,
    private readonly now: () => number,
  ) {}

  notifyUsers(userIds: string[], kind: string, title: string, body: string, link: string | null): number {
    const now = this.now();
    for (const userId of new Set(userIds)) {
      const id = randomUUID();
      this.db.run(
        "INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, userId, kind, title.slice(0, 200), body.slice(0, 4000), link, now,
      );
      this.hub.publishUser(userId, "notification", { id, kind, title, link });
    }
    return new Set(userIds).size;
  }

  inApp(req: { recipients: string[]; title: string; message: string; runId: string; workflowId: string }): { delivered: number } {
    const users = this.users.resolve(req.recipients);
    return { delivered: this.notifyUsers(users.map((u) => u.id), "workflow", req.title, req.message, `/runs/${req.runId}`) };
  }

  async webhook(req: { url: string; payload: Record<string, unknown>; signal: AbortSignal }): Promise<{ status: number }> {
    const response = await this.http.request({
      method: "POST",
      url: req.url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.payload),
      signal: req.signal,
    });
    return { status: response.status };
  }

  list(user: AuthUser, unreadOnly: boolean, limit: number): { items: NotificationView[]; unread: number } {
    const rows = this.db.all<{ id: string; kind: string; title: string; body: string; link: string | null; read_at: number | null; created_at: number }>(
      `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, id LIMIT ?`,
      user.id, limit,
    );
    const unread = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", user.id)?.n ?? 0;
    return {
      items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, readAt: r.read_at, createdAt: r.created_at })),
      unread,
    };
  }

  markRead(user: AuthUser, id: string | "all"): number {
    const now = this.now();
    if (id === "all") return this.db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now, user.id).changes;
    const result = this.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?", now, id, user.id);
    if (result.changes === 0) throw notFound("notification");
    return 1;
  }
}

// ------------------------------------------------------------------ approvals

interface ApprovalRow {
  id: string;
  run_id: string;
  node_id: string;
  workflow_id: string;
  title: string;
  description: string;
  assignees: string;
  status: string;
  level: number;
  due_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  comment: string | null;
  created_at: number;
}

export interface ApprovalView {
  id: string;
  runId: string;
  nodeId: string;
  workflowId: string;
  title: string;
  description: string;
  assignees: string[];
  status: string;
  escalated: boolean;
  dueAt: number | null;
  decidedBy: string | null;
  decidedAt: number | null;
  comment: string | null;
  createdAt: number;
  canDecide: boolean;
}

export class ApprovalService implements ApprovalHost {
  private engine: WorkflowEngine | undefined;

  constructor(
    private readonly db: Database,
    private readonly users: UserService,
    private readonly workflows: WorkflowService,
    private readonly notifications: NotificationService,
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {}

  attachEngine(engine: WorkflowEngine): void {
    this.engine = engine;
  }

  create(req: ApprovalRequest): string {
    const existing = this.db.get<{ id: string }>("SELECT id FROM approvals WHERE run_id = ? AND node_id = ?", req.runId, req.nodeId);
    if (existing) return existing.id;
    const id = randomUUID();
    this.db.run(
      `INSERT INTO approvals (id, run_id, node_id, workflow_id, title, description, assignees, status, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id, req.runId, req.nodeId, req.workflowId, req.title, req.description, json(req.assignees), req.dueAt, this.now(),
    );
    this.notifyAssignees(req.assignees, "Approval requested", req.title, id);
    return id;
  }

  escalate(approvalId: string, addAssignees: string[], dueAt: number | null): void {
    const row = this.row(approvalId);
    const assignees = [...new Set([...parseJson<string[]>(row.assignees, []), ...addAssignees])];
    this.db.run("UPDATE approvals SET assignees = ?, level = level + 1, due_at = ? WHERE id = ?", json(assignees), dueAt, approvalId);
    this.notifyAssignees(addAssignees, "Approval escalated to you", row.title, approvalId);
    this.logger.info("approval escalated", { approvalId, runId: row.run_id });
  }

  close(approvalId: string, status: "timed_out" | "cancelled"): void {
    this.db.run("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'", status, this.now(), approvalId);
  }

  private notifyAssignees(specs: string[], title: string, body: string, approvalId: string): void {
    const ids = this.users.resolve(specs).map((u) => u.id);
    this.notifications.notifyUsers(ids, "approval", title, body, `/approvals?focus=${approvalId}`);
  }

  private row(id: string): ApprovalRow {
    const row = this.db.get<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id);
    if (!row) throw notFound("approval");
    return row;
  }

  private view(row: ApprovalRow, user: AuthUser): ApprovalView {
    const assignees = parseJson<string[]>(row.assignees, []);
    return {
      id: row.id,
      runId: row.run_id,
      nodeId: row.node_id,
      workflowId: row.workflow_id,
      title: row.title,
      description: row.description,
      assignees,
      status: row.status,
      escalated: row.level > 0,
      dueAt: row.due_at,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      comment: row.comment,
      createdAt: row.created_at,
      canDecide: row.status === "pending" && (user.role === "admin" || matchesAssignee(user, assignees)),
    };
  }

  list(user: AuthUser, filter: { status?: string | undefined; mine: boolean; limit: number }): ApprovalView[] {
    const visible = this.workflows.visibleIds(user);
    const rows = this.db.all<ApprovalRow>(
      `SELECT * FROM approvals ${filter.status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 500`,
      ...(filter.status ? [filter.status] : []),
    );
    return rows
      .map((r) => this.view(r, user))
      .filter((a) => (filter.mine ? a.canDecide || matchesAssignee(user, a.assignees) : !visible || visible.includes(a.workflowId) || matchesAssignee(user, a.assignees)))
      .slice(0, filter.limit);
  }

  get(user: AuthUser, id: string): ApprovalView {
    const view = this.view(this.row(id), user);
    const visible = this.workflows.visibleIds(user);
    if (visible && !visible.includes(view.workflowId) && !matchesAssignee(user, view.assignees)) throw notFound("approval");
    return view;
  }

  decide(user: AuthUser, id: string, decision: "approved" | "rejected", comment: string | undefined): ApprovalView {
    const row = this.row(id);
    const current = this.view(row, user);
    if (row.status !== "pending") throw conflict(`approval is already ${row.status}`);
    if (!current.canDecide) throw forbidden("you are not an assignee of this approval");
    if (!this.engine) throw new Error("engine not attached");
    const engine = this.engine;
    this.db.transaction(() => {
      this.db.run(
        "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ? AND status = 'pending'",
        decision, user.email, this.now(), comment ?? null, id,
      );
      engine.signal(row.run_id, row.node_id, { decision, by: user.email, comment });
    });
    return this.view(this.row(id), user);
  }
}
