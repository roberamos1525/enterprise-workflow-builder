import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Notification, type User } from "./api.js";
import { liveBus, matchPath, navigate, useLocation } from "./hooks.js";
import { ApprovalsPage } from "./pages/Approvals.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { EditorPage } from "./pages/Editor.js";
import { LoginPage } from "./pages/Login.js";
import { RunDetailPage, RunsPage } from "./pages/Runs.js";
import { UsersPage } from "./pages/Users.js";
import { WorkflowsPage } from "./pages/Workflows.js";

const SessionContext = createContext<User | null>(null);
export const useSession = (): User => {
  const user = useContext(SessionContext);
  if (!user) throw new Error("no session");
  return user;
};

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(api.token ? undefined : null);
  const location = useLocation();

  useEffect(() => {
    api.onUnauthorized = () => setUser(null);
    if (api.token) api.me().then(setUser, () => setUser(null));
  }, []);

  // One authenticated SSE connection per session, re-established with backoff.
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let attempt = 0;
    const connect = () => {
      api
        .stream((type, data) => {
          attempt = 0;
          liveBus.emit(type, data);
        }, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (controller.signal.aborted) return;
          attempt++;
          setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
        });
    };
    connect();
    return () => controller.abort();
  }, [user]);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (user === null) return <LoginPage onLogin={setUser} />;

  const route = (pattern: string) => matchPath(pattern, location);
  let page: ReactNode;
  let params: Record<string, string> | null;
  if ((params = route("/workflows/:id"))) page = <EditorPage key={params["id"]} id={params["id"] as string} />;
  else if ((params = route("/runs/:id"))) page = <RunDetailPage key={params["id"]} id={params["id"] as string} />;
  else if (route("/runs")) page = <RunsPage />;
  else if (route("/dashboard")) page = <DashboardPage />;
  else if (route("/approvals")) page = <ApprovalsPage />;
  else if (route("/users") && user.role === "admin") page = <UsersPage />;
  else page = <WorkflowsPage />;

  const nav = [
    ["/", "Workflows"],
    ["/runs", "Runs"],
    ["/dashboard", "Dashboard"],
    ["/approvals", "Approvals"],
    ...(user.role === "admin" ? [["/users", "Users"]] : []),
  ] as const;
  const current = location.split("?")[0] ?? "/";

  return (
    <SessionContext.Provider value={user}>
      <div className="shell">
        <header className="topbar">
          <span className="brand">◆ Workflow Builder</span>
          <nav>
            {nav.map(([to, label]) => (
              <Link key={to} to={to} className={(to === "/" ? current === "/" || current.startsWith("/workflows") : current.startsWith(to)) ? "active" : ""}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="spacer" />
          <NotificationBell />
          <span className="who" title={user.email}>
            {user.name} <span className="role">{user.role}</span>
          </span>
          <button
            type="button"
            className="link"
            onClick={() => {
              api.setToken(null);
              setUser(null);
              navigate("/");
            }}
          >
            Sign out
          </button>
        </header>
        <main className="content">{page}</main>
      </div>
    </SessionContext.Provider>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const refresh = () => {
    api.notifications().then((r) => {
      setItems(r.items);
      setUnread(r.unread);
    }, () => undefined);
  };
  useEffect(() => {
    refresh();
    return liveBus.subscribe((type) => type === "notification" && refresh());
  }, []);
  return (
    <div className="bell">
      <button type="button" className="link" onClick={() => setOpen(!open)} aria-label={`${unread} unread notifications`}>
        🔔{unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="dropdown-head">
            <strong>Notifications</strong>
            <button type="button" className="link" onClick={() => api.markAllRead().then(refresh)}>Mark all read</button>
          </div>
          {items.length === 0 && <p className="muted">Nothing yet.</p>}
          {items.map((n) => (
            <div key={n.id} className={`note ${n.readAt ? "" : "unread"}`} onClick={() => { if (n.link) navigate(n.link.split("?")[0] ?? "/"); setOpen(false); }}>
              <div className="note-title">{n.title}</div>
              <div className="muted small">{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
