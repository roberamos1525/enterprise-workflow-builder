import { useState, type FormEvent } from "react";
import { api, type Role } from "../api.js";
import { useSession } from "../App.js";
import { formatTime, useAsync } from "../hooks.js";

const ROLES: Role[] = ["viewer", "operator", "editor", "admin"];

export function UsersPage() {
  const me = useSession();
  const { data, error, reload } = useAsync(() => api.users(), []);
  const [form, setForm] = useState({ email: "", name: "", role: "viewer" as Role, password: "" });
  const [message, setMessage] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createUser(form);
      setForm({ email: "", name: "", role: "viewer", password: "" });
      setMessage(null);
      reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  const update = (id: string, patch: { role?: Role; disabled?: boolean }) =>
    api.updateUser(id, patch).then(reload, (err: Error) => setMessage(err.message));

  return (
    <section>
      <h2>Users</h2>
      {error && <p className="field-error">{error.message}</p>}
      <table className="table">
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          {(data ?? []).map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.name}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id} onChange={(e) => void update(u.id, { role: e.target.value as Role })}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td>
                <label className="check">
                  <input type="checkbox" checked={!u.disabled} disabled={u.id === me.id} onChange={(e) => void update(u.id, { disabled: !e.target.checked })} /> active
                </label>
              </td>
              <td>{formatTime(u.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Add user</h3>
      <form className="inline-form wrap" onSubmit={create}>
        <input type="email" placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input type="password" placeholder="initial password (8+)" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <button type="submit" className="primary">Create</button>
      </form>
      {message && <p className="field-error">{message}</p>}
    </section>
  );
}
