import type { EdgeDef, NodeDef, RetryPolicy, WorkflowDefinition } from "../model/types.js";

let edgeCounter = 0;

export function node(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  extra: { retry?: RetryPolicy; timeoutMs?: number; name?: string } = {},
): NodeDef {
  const n: NodeDef = { id, type, name: extra.name ?? id, position: { x: 0, y: 0 }, config };
  if (extra.retry) n.retry = extra.retry;
  if (extra.timeoutMs !== undefined) n.timeoutMs = extra.timeoutMs;
  return n;
}

/** `edge("a.out", "b")` connects port `out` of a to port `in` of b. */
export function edge(from: string, to: string): EdgeDef {
  const [sn, sp = "out"] = from.split(".");
  const [tn, tp = "in"] = to.split(".");
  return { id: `e${++edgeCounter}`, source: { node: sn as string, port: sp }, target: { node: tn as string, port: tp } };
}

export function definition(nodes: NodeDef[], edges: EdgeDef[], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { schemaVersion: 1, nodes, edges, ...extra };
}

export const manual = (id = "start", config: Record<string, unknown> = {}) => node(id, "trigger.manual", config);
export const transform = (id: string, expression: string) => node(id, "action.transform", { expression });
export const setVar = (id: string, name: string, expression: string) => node(id, "action.setVariable", { name, expression });
export const branch = (id: string, condition: string) => node(id, "flow.branch", { condition });
export const join = (id: string, mode: "all" | "any" = "all") => node(id, "flow.join", { mode });
