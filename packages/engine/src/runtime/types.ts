import type { Value } from "../expr/index.js";
import type { NodeDef, WorkflowDefinition } from "../model/types.js";

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "running" | "waiting" | "succeeded" | "failed" | "skipped" | "cancelled";
export type TriggerType = "manual" | "webhook" | "schedule" | "event" | "subworkflow";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
export const ACTIVE_STEP_STATUSES: readonly StepStatus[] = ["running", "waiting"];

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface TriggerInfo {
  type: TriggerType;
  /** Free-form origin details (schedule time, event id, webhook request id...). */
  meta?: Record<string, unknown>;
}

export interface RunError {
  message: string;
  code: string;
  nodeId?: string;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  version: number;
  status: RunStatus;
  trigger: TriggerInfo;
  input: unknown;
  vars: Record<string, unknown>;
  output: unknown;
  error: RunError | null;
  parentRunId: string | null;
  parentNodeId: string | null;
  depth: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  deadlineAt: number | null;
}

export type ResumeEvent = { kind: "timer" } | { kind: "signal"; payload: unknown };

export interface StepRecord {
  runId: string;
  nodeId: string;
  nodeType: string;
  status: StepStatus;
  attempt: number;
  /** Output port the step completed through; drives edge activation. */
  port: string | null;
  input: unknown;
  output: unknown;
  error: RunError | null;
  /** Handler-private durable state (approval id, child run id...). */
  state: unknown;
  wakeAt: number | null;
  wakeReason: "retry" | "resume" | null;
  /** A resume event accepted but not yet processed; replayed on recovery. */
  pendingEvent: ResumeEvent | null;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
}

export type RunEventType =
  | "run.started"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "run.recovered"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "step.retry_scheduled"
  | "step.waiting"
  | "step.resumed"
  | "step.skipped"
  | "step.cancelled";

export interface RunEvent {
  runId: string;
  nodeId: string | null;
  type: RunEventType;
  at: number;
  data?: Record<string, unknown>;
}

/**
 * Durable storage for run state. Methods are synchronous so that every state
 * transition is applied atomically with respect to the event loop.
 */
export interface RunStore {
  insertRun(run: RunRecord): void;
  updateRun(run: RunRecord): void;
  getRun(id: string): RunRecord | undefined;
  listActiveRuns(): RunRecord[];
  findChildRuns(parentRunId: string): RunRecord[];
  listSteps(runId: string): StepRecord[];
  getStep(runId: string, nodeId: string): StepRecord | undefined;
  saveStep(step: StepRecord): void;
  appendEvent(event: RunEvent): void;
  transaction<T>(fn: () => T): T;
}

export interface DefinitionProvider {
  getVersion(workflowId: string, version: number): WorkflowDefinition | undefined;
  getPublished(workflowId: string): { version: number; definition: WorkflowDefinition } | undefined;
}

export interface StepContext {
  readonly run: Readonly<RunRecord>;
  readonly node: NodeDef;
  readonly attempt: number;
  readonly input: unknown;
  readonly state: unknown;
  readonly signal: AbortSignal;
  /** Variables visible to expressions (`input`, `trigger`, `vars`, `steps`, `run`). */
  readonly scope: Record<string, unknown>;
  now(): number;
  evaluate(source: string): Value;
  render(template: string): Value;
  renderDeep(value: unknown): Value;
  /** Reserves a child run of another workflow; it starts once this step is waiting. */
  startChildRun(workflowId: string, input: unknown): string;
}

export type StepOutcome =
  | { type: "complete"; port?: string; output?: unknown; vars?: Record<string, unknown> }
  | { type: "wait"; wakeAt?: number | null; state?: unknown }
  | { type: "end"; status: "succeeded" | "failed"; output?: unknown; message?: string };

export interface NodeHandler {
  execute(ctx: StepContext): StepOutcome | Promise<StepOutcome>;
  resume?(ctx: StepContext, event: ResumeEvent): StepOutcome | Promise<StepOutcome>;
  /** Called when a waiting/running step is cancelled (run cancelled or ended). */
  cancel?(ctx: StepContext): void;
}

/** Error thrown by handlers; `retryable` controls whether the retry policy applies. */
export class StepError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: { code?: string; retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "StepError";
    this.code = options.code ?? "STEP_FAILED";
    this.retryable = options.retryable ?? true;
    this.details = options.details;
  }
}

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export interface EngineLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
