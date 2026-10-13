import { useEffect, useState } from "react";
import { api, type Approval } from "../api.js";
import { Link } from "../App.js";
import { formatTime, liveBus, useAsync } from "../hooks.js";

export function ApprovalsPage() {
  const [mine, setMine] = useState(true);
  const [status, setStatus] = useState("pending");
  const { data, error, reload } = useAsync(() => api.approvals(mine, status || undefined), [mine, status]);
  useEffect(() => liveBus.subscribe((type) => type === "notification" && reload()), [reload]);
  return (
    <section>
      <div className="page-head">
        <h2>Approvals</h2>
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {["pending", "approved", "rejected", "timed_out", "cancelled", ""].map((s) => <option key={s} value={s}>{s || "any status"}</option>)}
        </select>
      </div>
      {error && <p className="field-error">{error.message}</p>}
      {data?.length === 0 && <p className="muted">Nothing here.</p>}
      <div className="cards">
        {(data ?? []).map((a) => <ApprovalCard key={a.id} approval={a} onDecided={reload} />)}
      </div>
    </section>
  );
}

function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    try {
      await api.decide(approval.id, decision, comment);
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="card approval">
      <div className="approval-head">
        <strong>{approval.title}</strong>
        <span className={`pill status-${approval.status}`}>{approval.status}</span>
        {approval.escalated && <span className="pill warn">escalated</span>}
      </div>
      {approval.description && <p>{approval.description}</p>}
      <p className="muted small">
        Run <Link to={`/runs/${approval.runId}`}>{approval.runId.slice(0, 8)}</Link> • step {approval.nodeId} • requested {formatTime(approval.createdAt)}
        {approval.dueAt ? ` • due ${formatTime(approval.dueAt)}` : ""}
      </p>
      <p className="small">Assignees: {approval.assignees.join(", ")}</p>
      {approval.decidedBy && <p className="small">Decided by {approval.decidedBy}{approval.comment ? `: “${approval.comment}”` : ""}</p>}
      {approval.canDecide && (
        <div className="decide">
          <input placeholder="Comment (optional)" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
          <button type="button" className="primary" onClick={() => void decide("approved")}>Approve</button>
          <button type="button" className="danger" onClick={() => void decide("rejected")}>Reject</button>
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
