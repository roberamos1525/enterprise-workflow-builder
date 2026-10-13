import { isValidCron, parseCron } from "../cron/cron.js";
import { checkExpression, checkTemplate, collectReferences, compileExpression, parseTemplate } from "../expr/index.js";
import { getNodeType, portCompatible } from "./catalog.js";
import type {
  EdgeDef,
  FieldSpec,
  NodeDef,
  NodeTypeSpec,
  RetryPolicy,
  ValidationIssue,
  WorkflowDefinition,
} from "./types.js";
import { isTriggerType } from "./types.js";

export const LIMITS = {
  maxNodes: 200,
  maxEdges: 400,
  maxNameLength: 120,
  maxTimeoutMs: 24 * 3600_000,
  maxRetryAttempts: 10,
  maxRetryDelayMs: 24 * 3600_000,
  maxConfigBytes: 64 * 1024,
};

export const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Roots expressions may read. `event` is only meaningful in event-trigger filters. */
export const EXPRESSION_ROOTS = ["input", "trigger", "vars", "steps", "run"] as const;

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ParseResult {
  definition?: WorkflowDefinition;
  issues: ValidationIssue[];
}

const err = (code: string, message: string, extra: Partial<ValidationIssue> = {}): ValidationIssue => ({
  severity: "error",
  code,
  message,
  ...extra,
});

const warn = (code: string, message: string, extra: Partial<ValidationIssue> = {}): ValidationIssue => ({
  severity: "warning",
  code,
  message,
  ...extra,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseRetry(raw: unknown, nodeId: string, issues: ValidationIssue[]): RetryPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(err("schema", "retry must be an object", { nodeId, field: "retry" }));
    return undefined;
  }
  const policy = {
    maxAttempts: raw["maxAttempts"] ?? 1,
    initialDelayMs: raw["initialDelayMs"] ?? 1000,
    backoffMultiplier: raw["backoffMultiplier"] ?? 2,
    maxDelayMs: raw["maxDelayMs"] ?? 60_000,
  };
  const bad = (field: string, message: string) => issues.push(err("schema", message, { nodeId, field: `retry.${field}` }));
  if (!Number.isInteger(policy.maxAttempts) || (policy.maxAttempts as number) < 1 || (policy.maxAttempts as number) > LIMITS.maxRetryAttempts) {
    bad("maxAttempts", `maxAttempts must be an integer between 1 and ${LIMITS.maxRetryAttempts}`);
  }
  if (!finite(policy.initialDelayMs) || policy.initialDelayMs < 0 || policy.initialDelayMs > LIMITS.maxRetryDelayMs) {
    bad("initialDelayMs", "initialDelayMs must be between 0 and 24h");
  }
  if (!finite(policy.backoffMultiplier) || policy.backoffMultiplier < 1 || policy.backoffMultiplier > 10) {
    bad("backoffMultiplier", "backoffMultiplier must be between 1 and 10");
  }
  if (!finite(policy.maxDelayMs) || policy.maxDelayMs < 0 || policy.maxDelayMs > LIMITS.maxRetryDelayMs) {
    bad("maxDelayMs", "maxDelayMs must be between 0 and 24h");
  }
  return policy as RetryPolicy;
}

/**
 * Structural (schema) validation of untrusted input. Returns a typed
 * definition only when the shape is sound enough for graph validation.
 */
export function parseDefinition(input: unknown): ParseResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { issues: [err("schema", "definition must be an object")] };
  if (input["schemaVersion"] !== 1) issues.push(err("schema", "schemaVersion must be 1"));
  const rawNodes = input["nodes"];
  const rawEdges = input["edges"];
  if (!Array.isArray(rawNodes)) issues.push(err("schema", "nodes must be an array"));
  if (!Array.isArray(rawEdges)) issues.push(err("schema", "edges must be an array"));
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) return { issues };
  if (rawNodes.length > LIMITS.maxNodes) issues.push(err("limit", `at most ${LIMITS.maxNodes} nodes are allowed`));
  if (rawEdges.length > LIMITS.maxEdges) issues.push(err("limit", `at most ${LIMITS.maxEdges} edges are allowed`));

  const nodes: NodeDef[] = [];
  const seenNodes = new Set<string>();
  rawNodes.forEach((raw, index) => {
    if (!isRecord(raw)) {
      issues.push(err("schema", `nodes[${index}] must be an object`));
      return;
    }
    const id = raw["id"];
    if (typeof id !== "string" || !NODE_ID_PATTERN.test(id)) {
      issues.push(err("schema", `nodes[${index}].id must match ${NODE_ID_PATTERN.source}`));
      return;
    }
    if (seenNodes.has(id)) issues.push(err("duplicate_node", `duplicate node id '${id}'`, { nodeId: id }));
    seenNodes.add(id);
    const type = raw["type"];
    if (typeof type !== "string") {
      issues.push(err("schema", "node type must be a string", { nodeId: id }));
      return;
    }
    const name = typeof raw["name"] === "string" ? raw["name"] : id;
    if (name.length > LIMITS.maxNameLength) issues.push(err("schema", "node name too long", { nodeId: id, field: "name" }));
    const pos = raw["position"];
    const position = isRecord(pos) && finite(pos["x"]) && finite(pos["y"]) ? { x: pos["x"], y: pos["y"] } : { x: 0, y: 0 };
    const config = raw["config"] ?? {};
    if (!isRecord(config)) {
      issues.push(err("schema", "config must be an object", { nodeId: id, field: "config" }));
      return;
    }
    if (JSON.stringify(config).length > LIMITS.maxConfigBytes) {
      issues.push(err("limit", "node config exceeds 64 KiB", { nodeId: id }));
    }
    const node: NodeDef = { id, type, name, position, config };
    const retry = parseRetry(raw["retry"], id, issues);
    if (retry) node.retry = retry;
    const timeout = raw["timeoutMs"];
    if (timeout !== undefined) {
      if (!finite(timeout) || timeout < 1 || timeout > LIMITS.maxTimeoutMs) {
        issues.push(err("schema", "timeoutMs must be between 1 ms and 24h", { nodeId: id, field: "timeoutMs" }));
      } else node.timeoutMs = timeout;
    }
    nodes.push(node);
  });

  const edges: EdgeDef[] = [];
  const seenEdges = new Set<string>();
  rawEdges.forEach((raw, index) => {
    const ref = (value: unknown) =>
      isRecord(value) && typeof value["node"] === "string" && typeof value["port"] === "string"
        ? { node: value["node"], port: value["port"] }
        : undefined;
    if (!isRecord(raw) || typeof raw["id"] !== "string" || raw["id"] === "") {
      issues.push(err("schema", `edges[${index}] must have a string id`));
      return;
    }
    const id = raw["id"];
    const source = ref(raw["source"]);
    const target = ref(raw["target"]);
    if (!source || !target) {
      issues.push(err("schema", "edge source/target must be {node, port}", { edgeId: id }));
      return;
    }
    if (seenEdges.has(id)) issues.push(err("duplicate_edge", `duplicate edge id '${id}'`, { edgeId: id }));
    seenEdges.add(id);
    edges.push({ id, source, target });
  });

  const definition: WorkflowDefinition = { schemaVersion: 1, nodes, edges };
  const variables = input["variables"];
  if (variables !== undefined) {
    if (isRecord(variables)) definition.variables = variables;
    else issues.push(err("schema", "variables must be an object"));
  }
  const settings = input["settings"];
  if (isRecord(settings)) {
    const max = settings["maxRunDurationMs"];
    if (max !== undefined) {
      if (finite(max) && max >= 1000 && max <= 30 * 24 * 3600_000) definition.settings = { maxRunDurationMs: max };
      else issues.push(err("schema", "settings.maxRunDurationMs must be between 1s and 30 days"));
    }
  }
  return { definition, issues };
}

function fieldActive(field: FieldSpec, config: Record<string, unknown>): boolean {
  if (!field.when) return true;
  return field.when.equals.includes(config[field.when.key]);
}

/** Validates a single node's config against its type spec. */
export function validateNodeConfig(node: NodeDef, spec: NodeTypeSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) => issues.push(err("invalid_config", message, { nodeId: node.id, field }));
  for (const field of spec.fields) {
    if (!fieldActive(field, node.config)) continue;
    const value = node.config[field.key];
    const empty =
      value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) issues.push(err("missing_config", `${field.label} is required`, { nodeId: node.id, field: field.key }));
      continue;
    }
    switch (field.kind) {
      case "string":
      case "text":
      case "url":
      case "expression":
      case "template":
      case "cron":
        if (typeof value !== "string") {
          at(field.key, `${field.label} must be a string`);
          continue;
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          at(field.key, `${field.label} must be at most ${field.maxLength} characters`);
        }
        if (field.kind === "expression") {
          const check = checkExpression(value);
          if (!check.ok) at(field.key, `${field.label}: ${check.error?.message} (at ${check.error?.position})`);
        } else if (field.kind === "template") {
          const check = checkTemplate(value);
          if (!check.ok) at(field.key, `${field.label}: ${check.error?.message} (at ${check.error?.position})`);
        } else if (field.kind === "cron") {
          try {
            parseCron(value);
          } catch (e) {
            at(field.key, `${field.label}: ${(e as Error).message}`);
          }
        } else if (field.kind === "url" && !/^https?:\/\/[^\s]+$/i.test(value)) {
          at(field.key, `${field.label} must be an http(s) URL`);
        }
        break;
      case "number":
        if (!finite(value)) at(field.key, `${field.label} must be a number`);
        else if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          at(field.key, `${field.label} must be between ${field.min ?? "-inf"} and ${field.max ?? "inf"}`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") at(field.key, `${field.label} must be true or false`);
        break;
      case "select":
        if (!field.options?.includes(value as string)) at(field.key, `${field.label} must be one of ${field.options?.join(", ")}`);
        break;
      case "stringList":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
          at(field.key, `${field.label} must be a list of non-empty strings`);
        }
        break;
      case "keyValue":
        if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
          at(field.key, `${field.label} must map names to string values`);
        } else {
          for (const [k, v] of Object.entries(value)) {
            const check = checkTemplate(v as string);
            if (!check.ok) at(field.key, `${field.label} '${k}': ${check.error?.message}`);
          }
        }
        break;
      case "json":
        break;
    }
  }
  if (spec.validate) issues.push(...spec.validate(node.config).map((i) => ({ ...i, nodeId: node.id })));
  return issues;
}

/** Returns node ids in topological order, or the ids involved in a cycle. */
export function topologicalOrder(def: WorkflowDefinition): { order: string[]; cycle: string[] } {
  const indegree = new Map(def.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) {
    if (!indegree.has(e.source.node) || !indegree.has(e.target.node)) continue;
    indegree.set(e.target.node, (indegree.get(e.target.node) ?? 0) + 1);
    next.get(e.source.node)?.push(e.target.node);
  }
  const queue = def.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const t of next.get(id) ?? []) {
      const d = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  const cycle = def.nodes.filter((n) => (indegree.get(n.id) ?? 0) > 0).map((n) => n.id);
  return { order, cycle };
}

/** All nodes from which `nodeId` is reachable (its upstream). */
export function ancestors(def: WorkflowDefinition, nodeId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of def.edges) incoming.set(e.target.node, [...(incoming.get(e.target.node) ?? []), e.source.node]);
  const seen = new Set<string>();
  const stack = [...(incoming.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(incoming.get(id) ?? []));
  }
  return seen;
}

function expressionSources(node: NodeDef, spec: NodeTypeSpec): { field: string; source: string; template: boolean }[] {
  const out: { field: string; source: string; template: boolean }[] = [];
  for (const field of spec.fields) {
    const value = node.config[field.key];
    if (field.kind === "expression" && typeof value === "string" && value.trim() !== "") {
      out.push({ field: field.key, source: value, template: false });
    } else if (field.kind === "template" && typeof value === "string") {
      out.push({ field: field.key, source: value, template: true });
    } else if (field.kind === "keyValue" && isRecord(value)) {
      for (const v of Object.values(value)) if (typeof v === "string") out.push({ field: field.key, source: v, template: true });
    }
  }
  return out;
}

function checkReferences(def: WorkflowDefinition, node: NodeDef, spec: NodeTypeSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(def.nodes.map((n) => n.id));
  let upstream: Set<string> | undefined;
  const roots = new Set<string>(node.type === "trigger.event" ? ["event"] : EXPRESSION_ROOTS);
  for (const { field, source, template } of expressionSources(node, spec)) {
    let asts;
    try {
      asts = template
        ? parseTemplate(source).flatMap((p) => (p.kind === "expr" ? [p.expr.ast] : []))
        : [compileExpression(source).ast];
    } catch {
      continue; // syntax errors are reported by validateNodeConfig
    }
    for (const ref of asts.flatMap((a) => collectReferences(a))) {
      if (!roots.has(ref.root)) {
        issues.push(err("unknown_reference", `unknown variable '${ref.root}' (use ${[...roots].join(", ")})`, { nodeId: node.id, field }));
      } else if (ref.root === "steps" && ref.member !== undefined) {
        if (!nodeIds.has(ref.member)) {
          issues.push(err("unknown_reference", `steps.${ref.member} refers to a node that does not exist`, { nodeId: node.id, field }));
        } else {
          upstream ??= ancestors(def, node.id);
          if (!upstream.has(ref.member)) {
            issues.push(warn("not_upstream", `steps.${ref.member} is not upstream of this node and may not have run`, { nodeId: node.id, field }));
          }
        }
      }
    }
  }
  return issues;
}

/** Graph + configuration validation of a structurally valid definition. */
export function validateGraph(def: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const specs = new Map<string, NodeTypeSpec>();
  for (const node of def.nodes) {
    const spec = getNodeType(node.type);
    if (!spec) {
      issues.push(err("unknown_type", `unknown node type '${node.type}'`, { nodeId: node.id }));
      continue;
    }
    specs.set(node.id, spec);
    issues.push(...validateNodeConfig(node, spec));
    if (node.retry && node.retry.maxAttempts > 1 && !spec.retryable) {
      issues.push(warn("retry_ignored", `${spec.label} nodes are not retried`, { nodeId: node.id, field: "retry" }));
    }
  }

  const triggers = def.nodes.filter((n) => isTriggerType(n.type));
  if (triggers.length === 0) issues.push(err("no_trigger", "workflow needs exactly one trigger node"));
  if (triggers.length > 1) {
    for (const t of triggers.slice(1)) issues.push(err("multiple_triggers", "only one trigger node is allowed", { nodeId: t.id }));
  }

  const edgeKeys = new Set<string>();
  const incomingCount = new Map<string, number>();
  for (const edge of def.edges) {
    const source = byId.get(edge.source.node);
    const target = byId.get(edge.target.node);
    if (!source || !target) {
      issues.push(err("dangling_edge", "edge references a missing node", { edgeId: edge.id }));
      continue;
    }
    if (source.id === target.id) {
      issues.push(err("self_loop", "a node cannot connect to itself", { edgeId: edge.id, nodeId: source.id }));
      continue;
    }
    const outPort = specs.get(source.id)?.outputs.find((p) => p.name === edge.source.port);
    const inPort = specs.get(target.id)?.inputs.find((p) => p.name === edge.target.port);
    if (specs.has(source.id) && !outPort) {
      issues.push(err("bad_port", `'${source.id}' has no output port '${edge.source.port}'`, { edgeId: edge.id }));
    }
    if (specs.has(target.id) && !inPort) {
      issues.push(err("bad_port", `'${target.id}' has no input port '${edge.target.port}'`, { edgeId: edge.id }));
    }
    if (outPort && inPort && !portCompatible(outPort.dataType, inPort.accepts)) {
      issues.push(
        err("incompatible_ports", `${outPort.dataType} output cannot connect to ${target.id}.${inPort.name}`, { edgeId: edge.id }),
      );
    }
    const key = `${edge.source.node}.${edge.source.port}->${edge.target.node}.${edge.target.port}`;
    if (edgeKeys.has(key)) issues.push(err("duplicate_connection", "the same ports are connected twice", { edgeId: edge.id }));
    edgeKeys.add(key);
    incomingCount.set(target.id, (incomingCount.get(target.id) ?? 0) + 1);
  }

  const { cycle } = topologicalOrder(def);
  if (cycle.length > 0) {
    issues.push(err("cycle", `cycle detected involving: ${cycle.join(", ")}`));
    for (const id of cycle) issues.push(err("cycle", "node is part of a cycle", { nodeId: id }));
  }

  const trigger = triggers[0];
  if (trigger) {
    const reachable = new Set<string>([trigger.id]);
    const stack = [trigger.id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      for (const e of def.edges) {
        if (e.source.node === id && !reachable.has(e.target.node)) {
          reachable.add(e.target.node);
          stack.push(e.target.node);
        }
      }
    }
    for (const node of def.nodes) {
      if (!reachable.has(node.id)) {
        issues.push(err("unreachable", `node '${node.name}' is not reachable from the trigger`, { nodeId: node.id }));
      }
    }
  }

  for (const node of def.nodes) {
    const spec = specs.get(node.id);
    if (!spec) continue;
    if (node.type === "flow.join" && (incomingCount.get(node.id) ?? 0) < 2) {
      issues.push(warn("join_inputs", "join has fewer than two incoming connections", { nodeId: node.id }));
    }
    issues.push(...checkReferences(def, node, spec));
  }
  return issues;
}

/** Full validation of untrusted input: schema, graph and node configuration. */
export function validateDefinition(input: unknown): ValidationResult & { definition?: WorkflowDefinition } {
  const parsed = parseDefinition(input);
  const issues = [...parsed.issues];
  if (parsed.definition) issues.push(...validateGraph(parsed.definition));
  const result: ValidationResult & { definition?: WorkflowDefinition } = {
    valid: !issues.some((i) => i.severity === "error"),
    issues,
  };
  if (parsed.definition) result.definition = parsed.definition;
  return result;
}

export { isValidCron };
