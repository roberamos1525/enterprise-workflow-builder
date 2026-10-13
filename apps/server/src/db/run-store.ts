import type { RunEvent, RunRecord, RunStatus, RunStore, StepRecord } from "@ewb/engine";
import { json, parseJson, type Database } from "./database.js";

interface RunRow {
  id: string;
  workflow_id: string;
  version: number;
  status: string;
  trigger: string;
  input: string;
  vars: string;
  output: string | null;
  error: string | null;
  parent_run_id: string | null;
  parent_node_id: string | null;
  depth: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  deadline_at: number | null;
}

interface StepRow {
  run_id: string;
  node_id: string;
  node_type: string;
  status: string;
  attempt: number;
  port: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  state: string | null;
  wake_at: number | null;
  wake_reason: string | null;
  pending_event: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    status: row.status as RunStatus,
    trigger: parseJson(row.trigger, { type: "manual" }),
    input: parseJson(row.input, null),
    vars: parseJson(row.vars, {}),
    output: parseJson(row.output, null),
    error: parseJson(row.error, null),
    parentRunId: row.parent_run_id,
    parentNodeId: row.parent_node_id,
    depth: row.depth,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    deadlineAt: row.deadline_at,
  };
}

function toStep(row: StepRow): StepRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status as StepRecord["status"],
    attempt: row.attempt,
    port: row.port,
    input: parseJson(row.input, null),
    output: parseJson(row.output, null),
    error: parseJson(row.error, null),
    state: parseJson(row.state, null),
    wakeAt: row.wake_at,
    wakeReason: row.wake_reason as StepRecord["wakeReason"],
    pendingEvent: parseJson(row.pending_event, null),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export interface RunQuery {
  workflowIds?: string[];
  status?: RunStatus;
  before?: number;
  limit: number;
}

export interface RunSummaryStats {
  total: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  perDay: { day: string; succeeded: number; failed: number; other: number }[];
  byWorkflow: { workflowId: string; total: number; succeeded: number; failed: number }[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/** SQLite implementation of the engine's RunStore plus read models for the API. */
export class SqliteRunStore implements RunStore {
  constructor(private readonly db: Database) {}

  insertRun(run: RunRecord): void {
    this.db.run(
      `INSERT INTO runs (id, workflow_id, version, status, trigger, trigger_type, input, vars, output, error, parent_run_id,
        parent_node_id, depth, created_by, created_at, updated_at, finished_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id, run.workflowId, run.version, run.status, json(run.trigger), run.trigger.type, json(run.input), json(run.vars),
      json(run.output), json(run.error), run.parentRunId, run.parentNodeId, run.depth, run.createdBy, run.createdAt,
      run.updatedAt, run.finishedAt, run.deadlineAt,
    );
  }

  updateRun(run: RunRecord): void {
    this.db.run(
      `UPDATE runs SET status = ?, vars = ?, output = ?, error = ?, updated_at = ?, finished_at = ?, deadline_at = ? WHERE id = ?`,
      run.status, json(run.vars), json(run.output), json(run.error), run.updatedAt, run.finishedAt, run.deadlineAt, run.id,
    );
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
    return row ? toRun(row) : undefined;
  }

  listActiveRuns(): RunRecord[] {
    return this.db.all<RunRow>("SELECT * FROM runs WHERE status IN ('running','waiting') ORDER BY created_at").map(toRun);
  }

  findChildRuns(parentRunId: string): RunRecord[] {
    return this.db.all<RunRow>("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at", parentRunId).map(toRun);
  }

  listSteps(runId: string): StepRecord[] {
    return this.db.all<StepRow>("SELECT * FROM steps WHERE run_id = ? ORDER BY started_at, node_id", runId).map(toStep);
  }

  getStep(runId: string, nodeId: string): StepRecord | undefined {
    const row = this.db.get<StepRow>("SELECT * FROM steps WHERE run_id = ? AND node_id = ?", runId, nodeId);
    return row ? toStep(row) : undefined;
  }

  saveStep(step: StepRecord): void {
    this.db.run(
      `INSERT INTO steps (run_id, node_id, node_type, status, attempt, port, input, output, error, state, wake_at, wake_reason,
        pending_event, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, node_id) DO UPDATE SET status = excluded.status, attempt = excluded.attempt, port = excluded.port,
         input = excluded.input, output = excluded.output, error = excluded.error, state = excluded.state,
         wake_at = excluded.wake_at, wake_reason = excluded.wake_reason, pending_event = excluded.pending_event,
         finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
      step.runId, step.nodeId, step.nodeType, step.status, step.attempt, step.port, json(step.input), json(step.output),
      json(step.error), json(step.state), step.wakeAt, step.wakeReason, json(step.pendingEvent), step.startedAt,
      step.finishedAt, step.updatedAt,
    );
  }

  appendEvent(event: RunEvent): void {
    this.db.run(
      "INSERT INTO run_events (run_id, node_id, type, at, data) VALUES (?, ?, ?, ?, ?)",
      event.runId, event.nodeId, event.type, event.at, json(event.data ?? {}),
    );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // ------------------------------------------------------------------ read models

  listEvents(runId: string): RunEvent[] {
    return this.db
      .all<{ run_id: string; node_id: string | null; type: string; at: number; data: string }>(
        "SELECT run_id, node_id, type, at, data FROM run_events WHERE run_id = ? ORDER BY id",
        runId,
      )
      .map((r) => ({ runId: r.run_id, nodeId: r.node_id, type: r.type as RunEvent["type"], at: r.at, data: parseJson(r.data, {}) }));
  }

  queryRuns(query: RunQuery): RunRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.workflowIds) {
      if (query.workflowIds.length === 0) return [];
      where.push(`workflow_id IN (${query.workflowIds.map(() => "?").join(",")})`);
      params.push(...query.workflowIds);
    }
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query.before !== undefined) {
      where.push("created_at < ?");
      params.push(query.before);
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db.all<RunRow>(sql, ...params, query.limit).map(toRun);
  }

  /** Aggregates for the dashboard over runs created since `since`. */
  stats(workflowIds: string[] | undefined, since: number, now: number): RunSummaryStats {
    const filter = workflowIds ? `AND workflow_id IN (${workflowIds.map(() => "?").join(",")})` : "";
    const params = workflowIds ?? [];
    if (workflowIds && workflowIds.length === 0) {
      return { total: 0, byStatus: {}, successRate: null, avgDurationMs: null, p50DurationMs: null, p95DurationMs: null, perDay: [], byWorkflow: [] };
    }
    const rows = this.db.all<{ workflow_id: string; status: string; created_at: number; finished_at: number | null }>(
      `SELECT workflow_id, status, created_at, finished_at FROM runs WHERE created_at >= ? AND parent_run_id IS NULL ${filter}`,
      since,
      ...params,
    );
    const byStatus: Record<string, number> = {};
    const durations: number[] = [];
    const days = new Map<string, { succeeded: number; failed: number; other: number }>();
    const workflows = new Map<string, { total: number; succeeded: number; failed: number }>();
    for (let t = since; t <= now; t += 86_400_000) days.set(new Date(t).toISOString().slice(0, 10), { succeeded: 0, failed: 0, other: 0 });
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.finished_at !== null && row.status === "succeeded") durations.push(row.finished_at - row.created_at);
      const day = days.get(new Date(row.created_at).toISOString().slice(0, 10));
      if (day) {
        if (row.status === "succeeded") day.succeeded++;
        else if (row.status === "failed") day.failed++;
        else day.other++;
      }
      const wf = workflows.get(row.workflow_id) ?? { total: 0, succeeded: 0, failed: 0 };
      wf.total++;
      if (row.status === "succeeded") wf.succeeded++;
      if (row.status === "failed") wf.failed++;
      workflows.set(row.workflow_id, wf);
    }
    const finished = (byStatus["succeeded"] ?? 0) + (byStatus["failed"] ?? 0) + (byStatus["cancelled"] ?? 0);
    durations.sort((a, b) => a - b);
    return {
      total: rows.length,
      byStatus,
      successRate: finished === 0 ? null : (byStatus["succeeded"] ?? 0) / finished,
      avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      perDay: [...days.entries()].map(([day, v]) => ({ day, ...v })),
      byWorkflow: [...workflows.entries()].map(([workflowId, v]) => ({ workflowId, ...v })).sort((a, b) => b.total - a.total),
    };
  }
}
