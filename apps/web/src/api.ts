import type {
  DefinitionDiff,
  NodeTypeSpec,
  RunEvent,
  RunRecord,
  StepRecord,
  ValidationIssue,
  WorkflowDefinition,
} from "@ewb/engine";

export type Role = "admin" | "editor" | "operator" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled?: boolean;
  createdAt?: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  draftRevision: number;
  publishedVersion: number | null;
  triggerType: string | null;
  updatedAt: number;
  myRole: Role;
}

export interface WorkflowDetail extends WorkflowSummary {
  draft: WorkflowDefinition;
  validation: { valid: boolean; issues: ValidationIssue[] };
  webhook: { path: string; secret?: string };
}

export interface VersionInfo {
  version: number;
  checksum: string;
  notes: string;
  publishedBy: string | null;
  publishedAt: number;
}

export interface RunDetail {
  run: RunRecord;
  steps: StepRecord[];
  events: RunEvent[];
  definition: WorkflowDefinition | null;
  children: RunRecord[];
}

export interface Approval {
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
  comment: string | null;
  createdAt: number;
  canDecide: boolean;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: number | null;
  createdAt: number;
}

export interface Summary {
  total: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  perDay: { day: string; succeeded: number; failed: number; other: number }[];
  byWorkflow: { workflowId: string; total: number; succeeded: number; failed: number }[];
}

export interface Catalog {
  nodeTypes: Omit<NodeTypeSpec, "validate">[];
  functions: { name: string; description: string }[];
}

export interface AclEntry {
  userId: string;
  email: string;
  name: string;
  role: "editor" | "operator" | "viewer";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "ewb.token";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" && typeof localStorage.getItem === "function" ? localStorage : null;
  } catch {
    return null; // storage disabled (privacy mode) or non-browser runtime
  }
}

export class ApiClient {
  token: string | null;
  onUnauthorized: () => void = () => {};

  constructor(
    private readonly base = "",
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = browserStorage(),
  ) {
    this.token = storage?.getItem(TOKEN_KEY) ?? null;
  }

  setToken(token: string | null): void {
    this.token = token;
    if (token) this.storage?.setItem(TOKEN_KEY, token);
    else this.storage?.removeItem(TOKEN_KEY);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (data as { error?: { code: string; message: string; details?: unknown } } | undefined)?.error;
      if (res.status === 401 && this.token) {
        this.setToken(null);
        this.onUnauthorized();
      }
      throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `request failed (${res.status})`, err?.details);
    }
    return data as T;
  }

  login = async (email: string, password: string) => {
    const res = await this.request<{ token: string; user: User }>("POST", "/api/auth/login", { email, password });
    this.setToken(res.token);
    return res.user;
  };
  me = () => this.request<User>("GET", "/api/auth/me");
  catalog = () => this.request<Catalog>("GET", "/api/catalog");
  users = () => this.request<User[]>("GET", "/api/users");
  createUser = (u: { email: string; name: string; role: Role; password: string }) => this.request<User>("POST", "/api/users", u);
  updateUser = (id: string, patch: Partial<{ role: Role; disabled: boolean; name: string }>) => this.request<User>("PATCH", `/api/users/${id}`, patch);

  workflows = () => this.request<WorkflowSummary[]>("GET", "/api/workflows");
  workflow = (id: string) => this.request<WorkflowDetail>("GET", `/api/workflows/${id}`);
  createWorkflow = (name: string, description = "") => this.request<WorkflowDetail>("POST", "/api/workflows", { name, description });
  saveWorkflow = (id: string, revision: number, patch: { name?: string; definition?: WorkflowDefinition }) =>
    this.request<WorkflowDetail>("PUT", `/api/workflows/${id}`, { revision, ...patch });
  archiveWorkflow = (id: string) => this.request<void>("DELETE", `/api/workflows/${id}`);
  publish = (id: string, notes: string) => this.request<VersionInfo>("POST", `/api/workflows/${id}/publish`, { notes });
  versions = (id: string) => this.request<VersionInfo[]>("GET", `/api/workflows/${id}/versions`);
  diff = (id: string, from: string, to: string) => this.request<DefinitionDiff>("GET", `/api/workflows/${id}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  rotateSecret = (id: string) => this.request<{ secret: string }>("POST", `/api/workflows/${id}/webhook/rotate`);
  acl = (id: string) => this.request<AclEntry[]>("GET", `/api/workflows/${id}/acl`);
  setAcl = (id: string, entries: { userId: string; role: AclEntry["role"] }[]) => this.request<AclEntry[]>("PUT", `/api/workflows/${id}/acl`, { entries });
  startRun = (id: string, input: unknown) => this.request<RunRecord>("POST", `/api/workflows/${id}/runs`, { input });

  runs = (params: { workflowId?: string; status?: string; before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return this.request<{ items: RunRecord[]; nextBefore: number | null }>("GET", `/api/runs?${q.toString()}`);
  };
  run = (id: string) => this.request<RunDetail>("GET", `/api/runs/${id}`);
  cancelRun = (id: string) => this.request<RunRecord>("POST", `/api/runs/${id}/cancel`, {});
  summary = (workflowId: string | undefined, days: number) =>
    this.request<Summary>("GET", `/api/metrics/summary?days=${days}${workflowId ? `&workflowId=${workflowId}` : ""}`);

  approvals = (mine: boolean, status?: string) =>
    this.request<Approval[]>("GET", `/api/approvals?mine=${mine}${status ? `&status=${status}` : ""}`);
  decide = (id: string, decision: "approved" | "rejected", comment: string) =>
    this.request<Approval>("POST", `/api/approvals/${id}/decision`, { decision, comment });
  notifications = () => this.request<{ items: Notification[]; unread: number }>("GET", "/api/notifications?limit=30");
  markAllRead = () => this.request<{ updated: number }>("POST", "/api/notifications/read-all");
  publishEvent = (type: string, payload: unknown) => this.request<{ runIds: string[] }>("POST", "/api/events", { type, payload });

  /** Opens the authenticated SSE stream via fetch (EventSource cannot send headers). */
  async stream(onEvent: (type: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/api/stream`, { headers: { authorization: `Bearer ${this.token ?? ""}` }, signal });
    if (!res.ok || !res.body) throw new ApiError(res.status, "STREAM_FAILED", "live stream unavailable");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser(onEvent);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      parser.push(decoder.decode(value, { stream: true }));
    }
  }
}

/** Incremental Server-Sent-Events parser (handles events split across chunks). */
export class SseParser {
  private buffer = "";
  constructor(private readonly onEvent: (type: string, data: unknown) => void) {}

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let index: number;
    while ((index = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const text = data.join("\n");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* plain text payload */
      }
      this.onEvent(type, parsed);
    }
  }
}

export const api = new ApiClient();
