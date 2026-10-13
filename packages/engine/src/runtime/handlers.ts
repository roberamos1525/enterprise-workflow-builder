import { truthy, type Value } from "../expr/index.js";
import { StepError, type NodeHandler, type ResumeEvent, type StepContext, type StepOutcome } from "./types.js";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderString(ctx: StepContext, template: string): string {
  const value = ctx.render(template);
  return typeof value === "string" ? value : JSON.stringify(value);
}

// ------------------------------------------------------------------ pure handlers

export const transformHandler: NodeHandler = {
  execute(ctx) {
    return { type: "complete", port: "out", output: ctx.evaluate(str(ctx.node.config["expression"])) };
  },
};

export const setVariableHandler: NodeHandler = {
  execute(ctx) {
    const name = str(ctx.node.config["name"]);
    const value = ctx.evaluate(str(ctx.node.config["expression"]));
    return { type: "complete", port: "out", output: value, vars: { [name]: value } };
  },
};

export const branchHandler: NodeHandler = {
  execute(ctx) {
    const result = truthy(ctx.evaluate(str(ctx.node.config["condition"])));
    return { type: "complete", port: result ? "true" : "false", output: ctx.input };
  },
};

export const joinHandler: NodeHandler = {
  execute(ctx) {
    return { type: "complete", port: "out", output: ctx.input };
  },
};

export const endHandler: NodeHandler = {
  execute(ctx) {
    const status = ctx.node.config["status"] === "failed" ? "failed" : "succeeded";
    const outputExpr = str(ctx.node.config["output"]);
    const output = outputExpr.trim() !== "" ? ctx.evaluate(outputExpr) : undefined;
    const message = str(ctx.node.config["message"]);
    const outcome: StepOutcome = { type: "end", status };
    if (output !== undefined) outcome.output = output;
    if (message !== "") outcome.message = renderString(ctx, message);
    return outcome;
  },
};

export const delayHandler: NodeHandler = {
  execute(ctx) {
    let wakeAt: number;
    if (ctx.node.config["mode"] === "until") {
      const until = ctx.evaluate(str(ctx.node.config["until"]));
      if (typeof until !== "number") throw new StepError("delay 'until' must evaluate to epoch milliseconds", { code: "BAD_DELAY", retryable: false });
      wakeAt = until;
    } else {
      wakeAt = ctx.now() + (num(ctx.node.config["durationMs"]) ?? 0);
    }
    if (wakeAt <= ctx.now()) return { type: "complete", port: "out", output: ctx.input };
    return { type: "wait", wakeAt, state: { wakeAt } };
  },
  resume(ctx, event) {
    if (event.kind !== "timer") throw new StepError("delay steps cannot be signalled", { code: "BAD_SIGNAL", retryable: false });
    return { type: "complete", port: "out", output: ctx.input };
  },
};

interface ChildResult {
  childRunId: string;
  status: string;
  output?: unknown;
  error?: { message: string; code: string } | null;
}

export const subworkflowHandler: NodeHandler = {
  execute(ctx) {
    const existing = ctx.state as { childRunId?: string } | null;
    if (existing?.childRunId) return { type: "wait", state: existing };
    const workflowId = str(ctx.node.config["workflowId"]);
    if (workflowId === ctx.run.workflowId) {
      throw new StepError("a workflow cannot call itself", { code: "RECURSIVE_SUBWORKFLOW", retryable: false });
    }
    const inputExpr = str(ctx.node.config["input"]);
    const input = inputExpr.trim() !== "" ? ctx.evaluate(inputExpr) : (ctx.input as Value);
    const childRunId = ctx.startChildRun(workflowId, input);
    return { type: "wait", state: { childRunId, workflowId, input } };
  },
  resume(_ctx, event) {
    if (event.kind !== "signal") throw new StepError("unexpected timer", { code: "BAD_SIGNAL", retryable: false });
    const result = event.payload as ChildResult;
    if (result.status === "succeeded") {
      return { type: "complete", port: "out", output: { childRunId: result.childRunId, output: result.output ?? null } };
    }
    throw new StepError(`sub-workflow ${result.status}: ${result.error?.message ?? "no details"}`, {
      code: "SUBWORKFLOW_FAILED",
      retryable: false,
      details: { childRunId: result.childRunId },
    });
  },
};

// ------------------------------------------------------------------ host-backed handlers

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Errors with this code (thrown by an HttpClient) are never retried. */
export const NON_RETRYABLE_HTTP_CODES = new Set(["SSRF_BLOCKED", "INVALID_URL", "RESPONSE_TOO_LARGE"]);

export function createHttpHandler(client: HttpClient): NodeHandler {
  return {
    async execute(ctx) {
      const config = ctx.node.config;
      const method = str(config["method"], "GET").toUpperCase();
      const url = renderString(ctx, str(config["url"]));
      const headers: Record<string, string> = {};
      const rawHeaders = config["headers"];
      if (rawHeaders && typeof rawHeaders === "object") {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = renderString(ctx, str(v));
      }
      let body: string | undefined;
      const bodyTemplate = str(config["body"]);
      if (bodyTemplate !== "" && method !== "GET") {
        const rendered = ctx.render(bodyTemplate);
        if (typeof rendered === "string") body = rendered;
        else {
          body = JSON.stringify(rendered);
          headers["content-type"] ??= "application/json";
        }
      }
      let response: HttpResponse;
      try {
        response = await client.request({ method, url, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal });
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        const known = typeof code === "string" && NON_RETRYABLE_HTTP_CODES.has(code);
        throw new StepError((err as Error).message, { code: known ? code : "HTTP_NETWORK", retryable: !known });
      }
      let parsed: unknown = response.body;
      if ((response.headers["content-type"] ?? "").includes("json") && response.body !== "") {
        try {
          parsed = JSON.parse(response.body);
        } catch {
          parsed = response.body;
        }
      }
      const output = { status: response.status, headers: response.headers, body: parsed };
      if (config["failOnHttpError"] !== false && response.status >= 400) {
        throw new StepError(`HTTP ${response.status} from ${method} ${url}`, {
          code: "HTTP_STATUS",
          retryable: response.status >= 500 || response.status === 429,
          details: { status: response.status },
        });
      }
      return { type: "complete", port: "success", output };
    },
  };
}

export interface Notifier {
  inApp(request: { recipients: string[]; title: string; message: string; runId: string; workflowId: string }): { delivered: number };
  webhook(request: { url: string; payload: Record<string, unknown>; signal: AbortSignal }): Promise<{ status: number }>;
}

export function createNotifyHandler(notifier: Notifier): NodeHandler {
  return {
    async execute(ctx) {
      const config = ctx.node.config;
      const title = renderString(ctx, str(config["title"]));
      const message = renderString(ctx, str(config["message"]));
      if (config["channel"] === "webhook") {
        const url = str(config["url"]);
        const payload = { title, message, runId: ctx.run.id, workflowId: ctx.run.workflowId, nodeId: ctx.node.id };
        let result: { status: number };
        try {
          result = await notifier.webhook({ url, payload, signal: ctx.signal });
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          const known = typeof code === "string" && NON_RETRYABLE_HTTP_CODES.has(code);
          throw new StepError((err as Error).message, { code: known ? code : "NOTIFY_FAILED", retryable: !known });
        }
        if (result.status >= 400) {
          throw new StepError(`notification webhook returned ${result.status}`, { code: "NOTIFY_FAILED", retryable: result.status >= 500 });
        }
        return { type: "complete", port: "out", output: { channel: "webhook", status: result.status, title } };
      }
      const recipients = list(config["recipients"]);
      const { delivered } = notifier.inApp({ recipients, title, message, runId: ctx.run.id, workflowId: ctx.run.workflowId });
      return { type: "complete", port: "out", output: { channel: "inApp", delivered, title } };
    },
  };
}

export interface ApprovalRequest {
  runId: string;
  nodeId: string;
  workflowId: string;
  title: string;
  description: string;
  assignees: string[];
  dueAt: number | null;
}

/** Persistence/notification side of approvals, implemented by the host application. */
export interface ApprovalHost {
  /** Must be idempotent per (runId, nodeId): re-execution after a crash returns the same id. */
  create(request: ApprovalRequest): string;
  escalate(approvalId: string, addAssignees: string[], dueAt: number | null): void;
  close(approvalId: string, status: "timed_out" | "cancelled"): void;
}

export interface ApprovalDecision {
  decision: "approved" | "rejected";
  by: string;
  comment?: string;
}

interface ApprovalState {
  approvalId: string;
  level: number;
}

export function createApprovalHandler(host: ApprovalHost): NodeHandler {
  return {
    execute(ctx) {
      const config = ctx.node.config;
      const timeoutMs = num(config["timeoutMs"]);
      const dueAt = timeoutMs !== undefined ? ctx.now() + timeoutMs : null;
      const approvalId = host.create({
        runId: ctx.run.id,
        nodeId: ctx.node.id,
        workflowId: ctx.run.workflowId,
        title: renderString(ctx, str(config["title"])),
        description: renderString(ctx, str(config["description"])),
        assignees: list(config["assignees"]),
        dueAt,
      });
      const state: ApprovalState = { approvalId, level: 0 };
      return { type: "wait", wakeAt: dueAt, state };
    },
    resume(ctx, event: ResumeEvent) {
      const state = ctx.state as ApprovalState;
      if (event.kind === "timer") {
        const escalateTo = list(ctx.node.config["escalateTo"]);
        if (state.level === 0 && escalateTo.length > 0) {
          const escalationMs = num(ctx.node.config["escalationTimeoutMs"]);
          const dueAt = escalationMs !== undefined ? ctx.now() + escalationMs : null;
          host.escalate(state.approvalId, escalateTo, dueAt);
          return { type: "wait", wakeAt: dueAt, state: { ...state, level: 1 } };
        }
        host.close(state.approvalId, "timed_out");
        return { type: "complete", port: "timeout", output: { approvalId: state.approvalId, decision: "timeout", escalated: state.level > 0 } };
      }
      const decision = event.payload as ApprovalDecision;
      if (decision.decision !== "approved" && decision.decision !== "rejected") {
        throw new StepError("invalid approval decision", { code: "BAD_SIGNAL", retryable: false });
      }
      return {
        type: "complete",
        port: decision.decision,
        output: { approvalId: state.approvalId, decision: decision.decision, by: decision.by, comment: decision.comment ?? null },
      };
    },
    cancel(ctx) {
      const state = ctx.state as ApprovalState | null;
      if (state?.approvalId) host.close(state.approvalId, "cancelled");
    },
  };
}

export interface HostServices {
  http: HttpClient;
  notifier: Notifier;
  approvals: ApprovalHost;
}

/** The full handler registry for every node type in the catalog. */
export function createHandlers(host: HostServices): Record<string, NodeHandler> {
  return {
    "action.transform": transformHandler,
    "action.setVariable": setVariableHandler,
    "action.delay": delayHandler,
    "action.subworkflow": subworkflowHandler,
    "action.http": createHttpHandler(host.http),
    "action.notify": createNotifyHandler(host.notifier),
    "action.approval": createApprovalHandler(host.approvals),
    "flow.branch": branchHandler,
    "flow.join": joinHandler,
    "flow.end": endHandler,
  };
}
