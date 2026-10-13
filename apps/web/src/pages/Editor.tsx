import { NODE_TYPES, validateDefinition, type DefinitionDiff } from "@ewb/engine";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, ApiError, type AclEntry, type User, type VersionInfo, type WorkflowDetail } from "../api.js";
import { Link } from "../App.js";
import { Canvas, NODE_DRAG_TYPE, type CanvasHandle } from "../editor/Canvas.js";
import { ConfigPanel } from "../editor/ConfigPanel.js";
import { editorReducer, initialState } from "../editor/state.js";
import { formatTime, useAsync, useLiveRuns } from "../hooks.js";

const EVENT_STATUS: Record<string, string> = {
  "step.started": "running",
  "step.resumed": "running",
  "step.succeeded": "succeeded",
  "step.failed": "failed",
  "step.waiting": "waiting",
  "step.retry_scheduled": "retrying",
  "step.skipped": "skipped",
  "step.cancelled": "cancelled",
};

export function EditorPage({ id }: { id: string }) {
  const { data, error } = useAsync(() => api.workflow(id), [id]);
  if (error) return <p className="field-error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return <Editor initial={data} />;
}

function Editor({ initial }: { initial: WorkflowDetail }) {
  const [meta, setMeta] = useState(initial);
  const [state, dispatch] = useReducer(editorReducer, initial.draft, initialState);
  const [name, setName] = useState(initial.name);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [panel, setPanel] = useState<"config" | "versions" | "share" | "run">("config");
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Map<string, string>>(new Map());
  const canvas = useRef<CanvasHandle | null>(null);
  const onCanvasReady = useCallback((handle: CanvasHandle) => {
    canvas.current = handle;
  }, []);
  const readOnly = meta.myRole !== "editor" && meta.myRole !== "admin";
  const canRun = readOnly ? meta.myRole === "operator" : true;

  const validation = useMemo(() => validateDefinition(state.def), [state.def]);
  const issueCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of validation.issues) if (i.nodeId && i.severity === "error") m.set(i.nodeId, (m.get(i.nodeId) ?? 0) + 1);
    return m;
  }, [validation]);
  const errors = validation.issues.filter((i) => i.severity === "error").length;
  const dirty = state.dirty || name !== meta.name;

  const save = useCallback(async () => {
    try {
      const updated = await api.saveWorkflow(meta.id, meta.draftRevision, { name, definition: state.def });
      setMeta(updated);
      dispatch({ type: "saved" });
      setMessage({ kind: "ok", text: `Saved revision ${updated.draftRevision}` });
      return true;
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      setMessage({ kind: "error", text: conflict ? "Someone else saved this workflow. Reload to get their changes." : (err as Error).message });
      return false;
    }
  }, [meta.id, meta.draftRevision, name, state.def]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!readOnly) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, readOnly]);

  useEffect(() => {
    if (!state.error) return;
    setMessage({ kind: "error", text: state.error });
    dispatch({ type: "clearError" });
  }, [state.error]);

  const publish = async () => {
    if (dirty && !(await save())) return;
    const notes = window.prompt("Release notes for this version (optional)", "") ?? "";
    try {
      const v = await api.publish(meta.id, notes);
      setMeta({ ...meta, publishedVersion: v.version });
      setMessage({ kind: "ok", text: `Published version ${v.version}` });
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? ` (${err.details.length} problems)` : "";
      setMessage({ kind: "error", text: `${(err as Error).message}${details}` });
    }
  };

  useLiveRuns((event) => {
    if (event.runId !== runId) return;
    setRunStatus(event.runStatus);
    const status = EVENT_STATUS[event.type];
    if (event.nodeId && status) setOverlay((m) => new Map(m).set(event.nodeId as string, status));
    if (event.type.startsWith("run.") && event.type !== "run.started") setRunStatus(event.type.slice(4));
  });

  const startRun = async (input: unknown) => {
    try {
      const run = await api.startRun(meta.id, input);
      setRunId(run.id);
      setRunStatus(run.status);
      const detail = await api.run(run.id);
      setOverlay(new Map(detail.steps.map((s) => [s.nodeId, s.status])));
      setRunStatus(detail.run.status);
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    }
  };

  return (
    <div className="editor">
      <div className="toolbar">
        <Link to="/">← Workflows</Link>
        <input className="title-input" value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
        <span className={`pill ${errors ? "bad" : "ok"}`} title="Validation runs locally with the same rules as the server">
          {errors ? `${errors} error${errors > 1 ? "s" : ""}` : "valid"}
        </span>
        <span className="muted small">
          rev {meta.draftRevision}
          {dirty ? " • unsaved" : ""} • {meta.publishedVersion ? `published v${meta.publishedVersion}` : "not published"}
        </span>
        <div className="spacer" />
        {!readOnly && (
          <>
            <button type="button" onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0} title="Undo (Ctrl+Z)">↶</button>
            <button type="button" onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0} title="Redo (Ctrl+Y)">↷</button>
            <button type="button" onClick={() => void save()} disabled={!dirty}>Save</button>
            <button type="button" className="primary" onClick={() => void publish()} disabled={errors > 0}>Publish</button>
          </>
        )}
        {canRun && meta.publishedVersion && (
          <button type="button" onClick={() => setPanel("run")}>Run…</button>
        )}
        <button type="button" className={panel === "versions" ? "active" : ""} onClick={() => setPanel(panel === "versions" ? "config" : "versions")}>Versions</button>
        <button type="button" className={panel === "share" ? "active" : ""} onClick={() => setPanel(panel === "share" ? "config" : "share")}>Share</button>
      </div>
      {message && (
        <div className={`toast ${message.kind}`} onClick={() => setMessage(null)}>
          {message.text}
        </div>
      )}
      {runId && (
        <div className="run-banner">
          Run <Link to={`/runs/${runId}`}>{runId.slice(0, 8)}</Link> — <span className={`pill status-${runStatus}`}>{runStatus}</span>
          <button type="button" className="link" onClick={() => { setRunId(null); setOverlay(new Map()); }}>clear overlay</button>
        </div>
      )}
      <div className="editor-body">
        {!readOnly && <Palette onAdd={(type) => dispatch({ type: "addNode", nodeType: type, position: canvas.current?.freeSpot() ?? { x: 100, y: 100 } })} />}
        <Canvas onReady={onCanvasReady} def={state.def} selected={state.selected} dispatch={dispatch} issues={issueCounts} status={overlay} readOnly={readOnly} />
        {panel === "config" && <ConfigPanel def={state.def} selected={state.selected} issues={validation.issues} dispatch={dispatch} readOnly={readOnly} />}
        {panel === "versions" && <VersionsPanel workflowId={meta.id} />}
        {panel === "share" && <SharePanel detail={meta} readOnly={readOnly} onRotated={(secret) => setMeta({ ...meta, webhook: { ...meta.webhook, secret } })} />}
        {panel === "run" && <RunPanel triggerType={meta.triggerType} onRun={(input) => { void startRun(input); setPanel("config"); }} />}
      </div>
    </div>
  );
}

function Palette({ onAdd }: { onAdd: (type: string) => void }) {
  const groups = ["trigger", "action", "flow"] as const;
  return (
    <aside className="palette">
      {groups.map((g) => (
        <div key={g}>
          <h4>{g === "trigger" ? "Triggers" : g === "action" ? "Actions" : "Flow"}</h4>
          {NODE_TYPES.filter((t) => t.category === g).map((t) => (
            <div
              key={t.type}
              className={`palette-item cat-${g}`}
              draggable
              title={t.description}
              onDragStart={(e) => e.dataTransfer.setData(NODE_DRAG_TYPE, t.type)}
              onClick={() => onAdd(t.type)}
            >
              {t.label}
            </div>
          ))}
        </div>
      ))}
      <p className="muted small">Drag onto the canvas or click to add. Adding a trigger replaces the current one.</p>
    </aside>
  );
}

function RunPanel({ triggerType, onRun }: { triggerType: string | null; onRun: (input: unknown) => void }) {
  const [text, setText] = useState("{\n  \n}");
  const [error, setError] = useState<string | null>(null);
  return (
    <aside className="panel">
      <h3>Start a run</h3>
      <p className="muted small">Runs the published version. Trigger: {triggerType ?? "none"}. The input becomes <code>trigger</code> in expressions.</p>
      <textarea className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      {error && <p className="field-error">{error}</p>}
      <button
        type="button"
        className="primary"
        onClick={() => {
          try {
            onRun(JSON.parse(text));
          } catch (err) {
            setError(`Invalid JSON: ${(err as Error).message}`);
          }
        }}
      >
        Run now
      </button>
    </aside>
  );
}

function VersionsPanel({ workflowId }: { workflowId: string }) {
  const { data: versions } = useAsync(() => api.versions(workflowId), [workflowId]);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("draft");
  const [diff, setDiff] = useState<DefinitionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compare = async () => {
    try {
      setDiff(await api.diff(workflowId, from, to));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const refs = ["draft", ...(versions ?? []).map((v) => String(v.version))];
  return (
    <aside className="panel">
      <h3>Versions</h3>
      <ul className="versions">
        {(versions ?? []).map((v: VersionInfo) => (
          <li key={v.version}>
            <strong>v{v.version}</strong> <span className="muted small">{formatTime(v.publishedAt)} • {v.checksum}</span>
            {v.notes && <div className="small">{v.notes}</div>}
          </li>
        ))}
        {versions?.length === 0 && <li className="muted">Not published yet.</li>}
      </ul>
      <h4>Compare</h4>
      <div className="grid2">
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">from…</option>
          {refs.map((r) => <option key={r} value={r}>{r === "draft" ? "draft" : `v${r}`}</option>)}
        </select>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {refs.map((r) => <option key={r} value={r}>{r === "draft" ? "draft" : `v${r}`}</option>)}
        </select>
      </div>
      <button type="button" disabled={!from} onClick={() => void compare()}>Show diff</button>
      {error && <p className="field-error">{error}</p>}
      {diff && <DiffView diff={diff} />}
    </aside>
  );
}

export function DiffView({ diff }: { diff: DefinitionDiff }) {
  if (diff.identical) return <p className="ok">No differences.</p>;
  return (
    <div className="diff">
      {diff.addedNodes.map((n) => <div key={`a${n.id}`} className="diff-add">+ node {n.id} ({n.type})</div>)}
      {diff.removedNodes.map((n) => <div key={`r${n.id}`} className="diff-del">− node {n.id} ({n.type})</div>)}
      {diff.changedNodes.map((c) => (
        <div key={`c${c.nodeId}`} className="diff-mod">
          ~ node {c.nodeId}
          {c.changes.map((ch) => (
            <div key={ch.path} className="diff-field mono small">
              {ch.path}: {JSON.stringify(ch.before)} → {JSON.stringify(ch.after)}
            </div>
          ))}
        </div>
      ))}
      {diff.movedNodes.length > 0 && <div className="muted small">moved: {diff.movedNodes.join(", ")}</div>}
      {diff.addedEdges.map((e) => <div key={`ae${e.id}`} className="diff-add">+ {e.source.node}.{e.source.port} → {e.target.node}</div>)}
      {diff.removedEdges.map((e) => <div key={`re${e.id}`} className="diff-del">− {e.source.node}.{e.source.port} → {e.target.node}</div>)}
      {diff.settingsChanges.map((s) => <div key={s.path} className="diff-mod mono small">~ {s.path}: {JSON.stringify(s.before)} → {JSON.stringify(s.after)}</div>)}
    </div>
  );
}

function SharePanel({ detail, readOnly, onRotated }: { detail: WorkflowDetail; readOnly: boolean; onRotated: (secret: string) => void }) {
  const { data: acl, reload } = useAsync(() => api.acl(detail.id), [detail.id]);
  const { data: users } = useAsync<User[]>(() => (readOnly ? Promise.resolve([]) : api.users()), [readOnly]);
  const [entries, setEntries] = useState<AclEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = entries ?? acl ?? [];
  const candidates = (users ?? []).filter((u) => !list.some((e) => e.userId === u.id));
  const save = async () => {
    try {
      await api.setAcl(detail.id, list.map((e) => ({ userId: e.userId, role: e.role })));
      setEntries(null);
      reload();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <aside className="panel">
      <h3>Access</h3>
      <table className="table compact">
        <tbody>
          {list.map((e) => (
            <tr key={e.userId}>
              <td>{e.email}</td>
              <td>
                <select disabled={readOnly} value={e.role} onChange={(ev) => setEntries(list.map((x) => (x.userId === e.userId ? { ...x, role: ev.target.value as AclEntry["role"] } : x)))}>
                  <option value="editor">editor</option>
                  <option value="operator">operator</option>
                  <option value="viewer">viewer</option>
                </select>
              </td>
              <td>{!readOnly && <button type="button" className="icon" onClick={() => setEntries(list.filter((x) => x.userId !== e.userId))}>×</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && candidates.length > 0 && (
        <select value="" onChange={(ev) => { const u = candidates.find((c) => c.id === ev.target.value); if (u) setEntries([...list, { userId: u.id, email: u.email, name: u.name, role: "viewer" }]); }}>
          <option value="">Add user…</option>
          {candidates.map((u) => <option key={u.id} value={u.id}>{u.email} ({u.role})</option>)}
        </select>
      )}
      {entries && <button type="button" className="primary" onClick={() => void save()}>Save access</button>}
      {error && <p className="field-error">{error}</p>}
      <p className="muted small">Effective access is the lower of the user's global role and this entry. Admins always have full access.</p>
      <h4>Webhook</h4>
      <p className="mono small">POST {detail.webhook.path}</p>
      {detail.webhook.secret ? (
        <>
          <p className="mono small break">secret: {detail.webhook.secret}</p>
          <p className="muted small">Send <code>X-EWB-Token: &lt;secret&gt;</code>, or sign: <code>X-EWB-Timestamp</code> + <code>X-EWB-Signature: sha256=HMAC(secret, ts + "." + body)</code>.</p>
          <button type="button" onClick={() => { if (window.confirm("Rotate the webhook secret? Existing callers will stop working.")) void api.rotateSecret(detail.id).then((r) => onRotated(r.secret)); }}>Rotate secret</button>
        </>
      ) : (
        <p className="muted small">Only editors can see the webhook secret.</p>
      )}
    </aside>
  );
}
