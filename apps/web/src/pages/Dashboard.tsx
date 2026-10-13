import { useState } from "react";
import { api, type Summary } from "../api.js";
import { formatDuration, formatPercent, useAsync, useLiveRuns } from "../hooks.js";

/** Stacked daily bars (succeeded / failed / other) drawn as plain SVG. */
export function DailyChart({ days }: { days: Summary["perDay"] }) {
  const width = 720;
  const height = 180;
  const max = Math.max(1, ...days.map((d) => d.succeeded + d.failed + d.other));
  const slot = width / Math.max(1, days.length);
  const scale = (v: number) => (v / max) * (height - 30);
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Runs per day">
      {days.map((d, i) => {
        const x = i * slot + slot * 0.15;
        const w = slot * 0.7;
        let y = height - 20;
        const segments = [
          ["succeeded", d.succeeded, "var(--ok)"],
          ["failed", d.failed, "var(--bad)"],
          ["other", d.other, "var(--muted)"],
        ] as const;
        return (
          <g key={d.day}>
            {segments.map(([label, value, color]) => {
              const h = scale(value);
              y -= h;
              return value > 0 ? (
                <rect key={label} x={x} y={y} width={w} height={h} fill={color}>
                  <title>{`${d.day}: ${value} ${label}`}</title>
                </rect>
              ) : null;
            })}
            {(i % Math.ceil(days.length / 10) === 0 || i === days.length - 1) && (
              <text x={x + w / 2} y={height - 5} textAnchor="middle" className="tl-axis">{d.day.slice(5)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function DashboardPage() {
  const [days, setDays] = useState(14);
  const [workflowId, setWorkflowId] = useState("");
  const { data: workflows } = useAsync(() => api.workflows(), []);
  const { data, reload } = useAsync(() => api.summary(workflowId || undefined, days), [workflowId, days]);
  useLiveRuns((e) => {
    if (e.type === "run.succeeded" || e.type === "run.failed" || e.type === "run.cancelled") reload();
  });
  const names = new Map((workflows ?? []).map((w) => [w.id, w.name]));
  return (
    <section>
      <div className="page-head">
        <h2>Dashboard</h2>
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          <option value="">All workflows</option>
          {(workflows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      {data && (
        <>
          <div className="kpis">
            <Kpi label="Runs" value={String(data.total)} />
            <Kpi label="Success rate" value={formatPercent(data.successRate)} hint="succeeded / finished" />
            <Kpi label="Avg duration" value={formatDuration(data.avgDurationMs)} hint="successful runs" />
            <Kpi label="p50 / p95" value={`${formatDuration(data.p50DurationMs)} / ${formatDuration(data.p95DurationMs)}`} />
            <Kpi label="Active" value={String((data.byStatus["running"] ?? 0) + (data.byStatus["waiting"] ?? 0))} hint="running + waiting" />
            <Kpi label="Failed" value={String(data.byStatus["failed"] ?? 0)} />
          </div>
          <h3>Runs per day</h3>
          <DailyChart days={data.perDay} />
          <h3>By workflow</h3>
          <table className="table">
            <thead><tr><th>Workflow</th><th>Runs</th><th>Succeeded</th><th>Failed</th><th>Success rate</th></tr></thead>
            <tbody>
              {data.byWorkflow.map((w) => (
                <tr key={w.workflowId}>
                  <td>{names.get(w.workflowId) ?? w.workflowId}</td>
                  <td>{w.total}</td>
                  <td>{w.succeeded}</td>
                  <td>{w.failed}</td>
                  <td>{formatPercent(w.succeeded + w.failed === 0 ? null : w.succeeded / (w.succeeded + w.failed))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
