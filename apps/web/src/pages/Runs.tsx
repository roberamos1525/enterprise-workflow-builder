import type { RunRecord, StepRecord } from "@ewb/engine";
import { useMemo, useState } from "react";
import { api } from "../api.js";
import { Link, useSession } from "../App.js";
import { Canvas } from "../editor/Canvas.js";
import { formatDuration, formatTime, useAsync, useLiveRuns } from "../hooks.js";

const STATUSES = ["", "running", "waiting", "succeeded", "failed", "cancelled"];

export function RunsPage() {
  const [status, setStatus] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [extra, setExtra] = useState<RunRecord[]>([]);
  const { data: workflows } = useAsync(() => api.workflows(), []);
  const { data, reload } = useAsync(() => {
    setExtra([]);
    return api.runs({ status, workflowId, limit: 50 });
  }, [status, workflowId]);
  useLiveRuns((e) => {
    if (e.type.startsWith("run.")) reload();
  });
  const names = new Map((workflows ?? []).map((w) => [w.id, w.name]));
  const items = [...(data?.items ?? []), ...extra];
  const nextBefore = extra.length > 0 ? extra.at(-1)?.createdAt : data?.nextBefore;

  const loadMore = async () => {
    if (!nextBefore) return;
    const page = await api.runs({ status, workflowId, before: nextBefore, limit: 50 });
    setExtra((x) => [...x, ...page.items]);
  };

  return (
    <section>
      <div className="page-head">
        <h2>Runs</h2>
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          <option value="">All workflows</option>
          {(workflows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "Any status"}</option>)}
        </select>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Workflow</th>
            <th>Version</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/runs/${r.id}`} className="mono">{r.id.slice(0, 8)}</Link></td>
              <td>{names.get(r.workflowId) ?? r.workflowId}</td>
              <td>v{r.version}</td>
              <td>{r.trigger.type}</td>
              <td><span className={`pill status-${r.status}`}>{r.status}</span></td>
              <td>{formatTime(r.createdAt)}</td>
              <td>{formatDuration(r.finishedAt ? r.finishedAt - r.createdAt : null)}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={7} className="muted">No runs match.</td></tr>}
        </tbody>
      </table>
      {nextBefore && <button type="button" onClick={() => void loadMore()}>Load more</button>}
    </section>
  );
}

const BAR_COLORS: Record<string, string> = {
  succeeded: "var(--ok)",
  failed: "var(--bad)",
  running: "var(--accent)",
  waiting: "var(--warn)",
  skipped: "var(--muted)",
  cancelled: "var(--muted)",
};

/** Gantt-style timeline: one bar per step from start to finish, relative to the run start. */
export function Timeline({ run, steps, now }: { run: RunRecord; steps: StepRecord[]; now: number }) {
  const executed = steps.filter((s) => s.status !== "skipped");
  const end = Math.max(run.finishedAt ?? now, ...executed.map((s) => s.finishedAt ?? now));
  const span = Math.max(1, end - run.createdAt);
  const rowH = 22;
  const labelW = 140;
  const width = 640;
  return (
    <svg className="timeline" viewBox={`0 0 ${width} ${executed.length * rowH + 24}`} role="img" aria-label="Step timeline">
      {executed.map((s, i) => {
        const x0 = labelW + ((s.startedAt - run.createdAt) / span) * (width - labelW - 10);
        const x1 = labelW + (((s.finishedAt ?? end) - run.createdAt) / span) * (width - labelW - 10);
        return (
          <g key={s.nodeId} transform={`translate(0 ${i * rowH})`}>
            <text x={0} y={15} className="tl-label">{s.nodeId}</text>
            <rect x={x0} y={4} width={Math.max(3, x1 - x0)} height={14} rx={3} fill={BAR_COLORS[s.status] ?? "var(--muted)"}>
              <title>{`${s.nodeId}: ${s.status}, ${formatDuration((s.finishedAt ?? end) - s.startedAt)}, attempt ${s.attempt}`}</title>
            </rect>
          </g>
        );
      })}
      <text x={labelW} y={executed.length * rowH + 18} className="tl-axis">0</text>
      <text x={width - 10} y={executed.length * rowH + 18} textAnchor="end" className="tl-axis">{formatDuration(span)}</text>
    </svg>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const user = useSession();
  const { data, error, reload } = useAsync(() => api.run(id), [id]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  useLiveRuns((e) => {
    if (e.runId === id || e.runId === data?.run.parentRunId) reload();
  });
  const overlay = useMemo(() => new Map((data?.steps ?? []).map((s) => [s.nodeId, s.status])), [data]);
  if (error) return <p className="field-error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { run, steps, events, definition, children } = data;
  const active = run.status === "running" || run.status === "waiting";

  return (
    <section className="run-detail">
      <div className="page-head">
        <h2>
          Run <span className="mono">{run.id.slice(0, 8)}</span> <span className={`pill status-${run.status}`}>{run.status}</span>
        </h2>
        <div className="spacer" />
        {active && user.role !== "viewer" && (
          <button type="button" className="danger" onClick={() => api.cancelRun(run.id).then(reload, (err: Error) => setCancelError(err.message))}>
            Cancel run
          </button>
        )}
      </div>
      {cancelError && <p className="field-error">{cancelError}</p>}
      <dl className="facts">
        <dt>Workflow</dt>
        <dd><Link to={`/workflows/${run.workflowId}`}>{run.workflowId}</Link> v{run.version}</dd>
        <dt>Trigger</dt>
        <dd>{run.trigger.type}</dd>
        <dt>Started</dt>
        <dd>{formatTime(run.createdAt)}</dd>
        <dt>Duration</dt>
        <dd>{formatDuration((run.finishedAt ?? Date.now()) - run.createdAt)}{active ? " (so far)" : ""}</dd>
        {run.parentRunId && (<><dt>Parent</dt><dd><Link to={`/runs/${run.parentRunId}`}>{run.parentRunId.slice(0, 8)}</Link></dd></>)}
        {run.error && (<><dt>Error</dt><dd className="field-error">{run.error.code}: {run.error.message}{run.error.nodeId ? ` (at ${run.error.nodeId})` : ""}</dd></>)}
      </dl>
      {definition && <Canvas def={definition} selected={null} status={overlay} readOnly height={320} />}
      <h3>Timeline</h3>
      <Timeline run={run} steps={steps} now={Date.now()} />
      <h3>Steps</h3>
      <table className="table">
        <thead>
          <tr><th>Node</th><th>Type</th><th>Status</th><th>Port</th><th>Attempts</th><th>Duration</th><th>Output / error</th></tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.nodeId}>
              <td className="mono">{s.nodeId}</td>
              <td>{s.nodeType}</td>
              <td><span className={`pill status-${s.status}`}>{s.status}</span></td>
              <td>{s.port ?? "—"}</td>
              <td>{s.attempt}</td>
              <td>{s.status === "skipped" ? "—" : formatDuration((s.finishedAt ?? Date.now()) - s.startedAt)}</td>
              <td>
                <details>
                  <summary className="small">{s.error ? s.error.message : "show"}</summary>
                  <pre className="json">{JSON.stringify({ input: s.input, output: s.output, error: s.error }, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children.length > 0 && (
        <>
          <h3>Sub-workflow runs</h3>
          <ul>{children.map((c) => <li key={c.id}><Link to={`/runs/${c.id}`}>{c.id.slice(0, 8)}</Link> {c.workflowId} — {c.status}</li>)}</ul>
        </>
      )}
      <h3>Events</h3>
      <ol className="events">
        {events.map((ev, i) => (
          <li key={i}>
            <span className="muted small">+{formatDuration(ev.at - run.createdAt)}</span> <strong>{ev.type}</strong> {ev.nodeId && <span className="mono">{ev.nodeId}</span>}{" "}
            {ev.data && Object.keys(ev.data).length > 0 && <span className="muted small">{JSON.stringify(ev.data)}</span>}
          </li>
        ))}
      </ol>
      <h3>Run variables / output</h3>
      <pre className="json">{JSON.stringify(run.status === "succeeded" ? run.output : run.vars, null, 2)}</pre>
    </section>
  );
}
