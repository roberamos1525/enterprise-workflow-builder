/**
 * Core workflow definition model. A workflow is a directed acyclic graph of
 * nodes connected by edges between typed ports.
 */

/** Data carried along an edge. Used to check port compatibility. */
export type DataType = "any" | "object" | "http" | "decision" | "error";

export interface Position {
  x: number;
  y: number;
}

export interface RetryPolicy {
  /** Total attempts including the first one (1 = no retries). */
  maxAttempts: number;
  /** Delay before the second attempt. */
  initialDelayMs: number;
  /** Multiplier applied to the delay after each failed attempt. */
  backoffMultiplier: number;
  /** Upper bound for a single delay. */
  maxDelayMs: number;
}

export interface NodeDef {
  id: string;
  type: string;
  name: string;
  position: Position;
  config: Record<string, unknown>;
  retry?: RetryPolicy;
  /** Per-attempt execution timeout. */
  timeoutMs?: number;
}

export interface PortRef {
  node: string;
  port: string;
}

export interface EdgeDef {
  id: string;
  source: PortRef;
  target: PortRef;
}

export interface WorkflowSettings {
  /** Fails the run when it is still active after this many milliseconds. */
  maxRunDurationMs?: number;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  nodes: NodeDef[];
  edges: EdgeDef[];
  /** Initial values of run variables (`vars.*` in expressions). */
  variables?: Record<string, unknown>;
  settings?: WorkflowSettings;
}

export type NodeCategory = "trigger" | "action" | "flow";

export interface PortSpec {
  name: string;
  label: string;
  /** For outputs: the type produced. For inputs: ignored (see `accepts`). */
  dataType: DataType;
  /** For inputs: the accepted data types. */
  accepts?: DataType[];
}

export type FieldKind =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "expression"
  | "template"
  | "json"
  | "stringList"
  | "cron"
  | "url"
  | "keyValue";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
  default?: unknown;
  help?: string;
  /** Only validate/show this field when another field has one of these values. */
  when?: { key: string; equals: readonly unknown[] };
}

export type Severity = "error" | "warning";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  field?: string;
}

export interface NodeTypeSpec {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  fields: FieldSpec[];
  /** Whether a retry policy / timeout is meaningful for the node. */
  retryable: boolean;
  /** Extra cross-field validation beyond the generic per-field checks. */
  validate?: (config: Record<string, unknown>) => ValidationIssue[];
}

export function isTriggerType(type: string): boolean {
  return type.startsWith("trigger.");
}
