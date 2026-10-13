import { useState, type FormEvent } from "react";
import { api } from "../api.js";
import { Link, useSession } from "../App.js";
import { formatTime, navigate, useAsync } from "../hooks.js";

const TRIGGER_LABEL: Record<string, string> = {
  "trigger.manual": "Manual",
  "trigger.webhook": "Webhook",
  "trigger.schedule": "Schedule",
  "trigger.event": "Event",
};

export function WorkflowsPage() {
  const user = useSession();
  const { data, error, loading } = useAsync(() => api.workflows(), []);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const canCreate = user.role === "admin" || user.role === "editor";

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const wf = await api.createWorkflow(name.trim());
      navigate(`/workflows/${wf.id}`);
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  const items = (data ?? []).filter((w) => w.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section>
      <div className="page-head">
        <h2>Workflows</h2>
        <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {canCreate && (
          <form onSubmit={create} className="inline-form">
            <input placeholder="New workflow name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            <button type="submit" className="primary">Create</button>
          </form>
        )}
      </div>
      {createError && <p className="field-error">{createError}</p>}
      {error && <p className="field-error">{error.message}</p>}
      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Trigger</th>
              <th>Published</th>
              <th>Draft rev.</th>
              <th>Your access</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                  {w.description && <div className="muted small">{w.description}</div>}
                </td>
                <td>{TRIGGER_LABEL[w.triggerType ?? ""] ?? "—"}</td>
                <td>{w.publishedVersion ? <span className="pill ok">v{w.publishedVersion}</span> : <span className="pill">draft</span>}</td>
                <td>{w.draftRevision}</td>
                <td>{w.myRole}</td>
                <td>{formatTime(w.updatedAt)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">No workflows yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
