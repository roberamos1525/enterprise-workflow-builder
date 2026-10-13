import {
  checkExpression,
  checkTemplate,
  describeCron,
  getNodeType,
  nextFireTimes,
  type FieldSpec,
  type NodeDef,
  type RetryPolicy,
  type ValidationIssue,
  type WorkflowDefinition,
} from "@ewb/engine";
import { useEffect, useState, type Dispatch } from "react";
import type { EditorAction, Selection } from "./state.js";

interface Props {
  def: WorkflowDefinition;
  selected: Selection;
  issues: ValidationIssue[];
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
}

export function ConfigPanel({ def, selected, issues, dispatch, readOnly }: Props) {
  if (!selected) {
    const general = issues.filter((i) => !i.nodeId && !i.edgeId);
    return (
      <aside className="panel">
        <h3>Workflow</h3>
        <p className="muted">Select a node to configure it. Drag from an output port (right) to an input port (left) to connect nodes.</p>
        <IssueList issues={general.length ? general : issues.slice(0, 8)} />
      </aside>
    );
  }
  if (selected.kind === "edge") {
    const edge = def.edges.find((e) => e.id === selected.id);
    if (!edge) return <aside className="panel" />;
    return (
      <aside className="panel">
        <h3>Connection</h3>
        <p>
          <code>{edge.source.node}.{edge.source.port}</code> → <code>{edge.target.node}</code>
        </p>
        <IssueList issues={issues.filter((i) => i.edgeId === edge.id)} />
        {!readOnly && (
          <button type="button" className="danger" onClick={() => dispatch({ type: "deleteSelected" })}>
            Delete connection
          </button>
        )}
      </aside>
    );
  }
  const node = def.nodes.find((n) => n.id === selected.id);
  if (!node) return <aside className="panel" />;
  return <NodeConfig key={node.id} node={node} issues={issues.filter((i) => i.nodeId === node.id)} dispatch={dispatch} readOnly={readOnly} />;
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return <p className="ok">No problems found.</p>;
  return (
    <ul className="issues">
      {issues.map((i, k) => (
        <li key={k} className={i.severity}>
          {i.field ? <strong>{i.field}: </strong> : null}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function NodeConfig({ node, issues, dispatch, readOnly }: { node: NodeDef; issues: ValidationIssue[]; dispatch: Dispatch<EditorAction>; readOnly: boolean }) {
  const spec = getNodeType(node.type);
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => setIdDraft(node.id), [node.id]);
  const setConfig = (key: string, value: unknown) => {
    const config = { ...node.config };
    if (value === undefined) delete config[key];
    else config[key] = value;
    dispatch({ type: "updateNode", id: node.id, patch: { config } });
  };
  const fieldIssues = (key: string) => issues.filter((i) => i.field === key || i.field?.startsWith(`${key}.`));
  const visible = (f: FieldSpec) => !f.when || f.when.equals.includes(node.config[f.when.key]);

  return (
    <aside className="panel">
      <h3>{spec?.label ?? node.type}</h3>
      <p className="muted small">{spec?.description}</p>
      <fieldset disabled={readOnly}>
        <label>
          Name
          <input value={node.name} maxLength={120} onChange={(e) => dispatch({ type: "updateNode", id: node.id, patch: { name: e.target.value } })} />
        </label>
        <label>
          Node id <span className="muted small">(used as steps.&lt;id&gt; in expressions)</span>
          <input
            value={idDraft}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={() => dispatch({ type: "renameNode", from: node.id, to: idDraft.trim() })}
            className="mono"
          />
        </label>
        {spec?.fields.filter(visible).map((field) => (
          <FieldEditor key={field.key} field={field} value={node.config[field.key]} onChange={(v) => setConfig(field.key, v)} issues={fieldIssues(field.key)} />
        ))}
        {spec?.retryable && <RetryEditor node={node} dispatch={dispatch} issues={issues} />}
      </fieldset>
      <h4>Problems</h4>
      <IssueList issues={issues} />
      {!readOnly && spec?.category !== "trigger" && (
        <button type="button" className="danger" onClick={() => dispatch({ type: "deleteSelected" })}>
          Delete node
        </button>
      )}
    </aside>
  );
}

function RetryEditor({ node, dispatch, issues }: { node: NodeDef; dispatch: Dispatch<EditorAction>; issues: ValidationIssue[] }) {
  const retry: RetryPolicy = node.retry ?? { maxAttempts: 1, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 60_000 };
  const update = (patch: Partial<RetryPolicy>) => dispatch({ type: "updateNode", id: node.id, patch: { retry: { ...retry, ...patch } } });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <details className="retry" open={retry.maxAttempts > 1 || node.timeoutMs !== undefined}>
      <summary>Retries &amp; timeout</summary>
      <div className="grid2">
        <label>
          Max attempts
          <input type="number" min={1} max={10} value={retry.maxAttempts} onChange={(e) => update({ maxAttempts: num(e.target.value) })} />
        </label>
        <label>
          First delay (ms)
          <input type="number" min={0} value={retry.initialDelayMs} onChange={(e) => update({ initialDelayMs: num(e.target.value) })} />
        </label>
        <label>
          Backoff ×
          <input type="number" min={1} max={10} step={0.5} value={retry.backoffMultiplier} onChange={(e) => update({ backoffMultiplier: num(e.target.value) })} />
        </label>
        <label>
          Max delay (ms)
          <input type="number" min={0} value={retry.maxDelayMs} onChange={(e) => update({ maxDelayMs: num(e.target.value) })} />
        </label>
        <label>
          Timeout (ms)
          <input
            type="number"
            min={1}
            value={node.timeoutMs ?? ""}
            placeholder="default"
            onChange={(e) => dispatch({ type: "updateNode", id: node.id, patch: { timeoutMs: e.target.value === "" ? undefined : Number(e.target.value) } })}
          />
        </label>
      </div>
      <IssueList issues={issues.filter((i) => i.field?.startsWith("retry") || i.field === "timeoutMs")} />
    </details>
  );
}

interface FieldProps {
  field: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  issues: ValidationIssue[];
}

function FieldEditor({ field, value, onChange, issues }: FieldProps) {
  const label = (
    <>
      {field.label}
      {field.required && <span className="req">*</span>}
    </>
  );
  const errors = issues.length > 0 && (
    <span className="field-error">{issues.map((i) => i.message).join("; ")}</span>
  );
  const str = typeof value === "string" ? value : "";
  switch (field.kind) {
    case "boolean":
      return (
        <label className="check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case "select":
      return (
        <label>
          {label}
          <select value={str} onChange={(e) => onChange(e.target.value)}>
            {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {errors}
        </label>
      );
    case "number":
      return (
        <label>
          {label}
          <input type="number" value={typeof value === "number" ? value : ""} min={field.min} max={field.max} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
          {errors}
        </label>
      );
    case "expression":
    case "template": {
      const check = str.trim() === "" ? undefined : field.kind === "expression" ? checkExpression(str) : checkTemplate(str);
      return (
        <label>
          {label}
          <textarea className="mono" rows={field.kind === "expression" ? 2 : 3} value={str} placeholder={field.kind === "template" ? "Text with {{ expressions }}" : "e.g. trigger.amount > 100"} onChange={(e) => onChange(e.target.value)} />
          {check && !check.ok && <span className="field-error">Syntax: {check.error?.message} (col {(check.error?.position ?? 0) + 1})</span>}
          {(!check || check.ok) && errors}
          {field.help && <span className="muted small">{field.help}</span>}
        </label>
      );
    }
    case "cron":
      return (
        <label>
          {label}
          <input className="mono" value={str} onChange={(e) => onChange(e.target.value)} />
          <CronPreview expr={str} />
          {errors}
        </label>
      );
    case "stringList":
      return (
        <label>
          {label}
          <textarea rows={2} value={Array.isArray(value) ? value.join("\n") : ""} placeholder="one per line" onChange={(e) => onChange(e.target.value.split(/\n|,/).map((s) => s.trim()).filter(Boolean))} />
          {field.help && <span className="muted small">{field.help}</span>}
          {errors}
        </label>
      );
    case "json":
      return <JsonField label={label} value={value} onChange={onChange} errors={errors} />;
    case "keyValue":
      return <KeyValueField label={label} value={(value ?? {}) as Record<string, string>} onChange={onChange} errors={errors} />;
    default:
      return (
        <label>
          {label}
          <input className={field.kind === "url" ? "mono" : ""} value={str} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />
          {field.help && <span className="muted small">{field.help}</span>}
          {errors}
        </label>
      );
  }
}

function CronPreview({ expr }: { expr: string }) {
  try {
    const times = nextFireTimes(expr, Date.now(), 3);
    return (
      <span className="muted small">
        {describeCron(expr)} — next: {times.map((t) => new Date(t).toISOString().slice(0, 16).replace("T", " ")).join(", ")}
      </span>
    );
  } catch {
    return null;
  }
}

function JsonField({ label, value, onChange, errors }: { label: React.ReactNode; value: unknown; onChange: (v: unknown) => void; errors: React.ReactNode }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <label>
      {label}
      <textarea
        className="mono"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(text));
            setError(null);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error ? <span className="field-error">Invalid JSON: {error}</span> : errors}
    </label>
  );
}

function KeyValueField({ label, value, onChange, errors }: { label: React.ReactNode; value: Record<string, string>; onChange: (v: unknown) => void; errors: React.ReactNode }) {
  const entries = Object.entries(value);
  const set = (next: [string, string][]) => onChange(Object.fromEntries(next.filter(([k]) => k !== "" || next.length === 1)));
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      {entries.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input value={k} placeholder="name" onChange={(e) => set(entries.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
          <input value={v} placeholder="value or {{ expr }}" className="mono" onChange={(e) => set(entries.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} />
          <button type="button" className="icon" title="Remove" onClick={() => set(entries.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="link" onClick={() => onChange({ ...value, [`header${entries.length + 1}`]: "" })}>+ add</button>
      {errors}
    </div>
  );
}
