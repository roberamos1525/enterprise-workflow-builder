import { ExpressionError, renderDeep, renderTemplate, compileExpression, type Value } from "../expr/index.js";
import { getNodeType } from "../model/catalog.js";
import type { EdgeDef, NodeDef, RetryPolicy, WorkflowDefinition } from "../model/types.js";
import { isTriggerType } from "../model/types.js";
import { topologicalOrder, validateDefinition } from "../model/validate.js";
import type { Clock, TimerHandle } from "./clock.js";
import {
  EngineError,
  isTerminalRun,
  StepError,
  type DefinitionProvider,
  type EngineLogger,
  type NodeHandler,
  type ResumeEvent,
  type RunError,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StepContext,
  type StepOutcome,
  type StepRecord,
  type TriggerInfo,
} from "./types.js";

export interface EngineOptions {
  store: RunStore;
  clock: Clock;
  definitions: DefinitionProvider;
  handlers: Record<string, NodeHandler>;
  idGenerator?: () => string;
  /** Observes every persisted run event (live UI, metrics, notifications). */
  onEvent?: (event: RunEvent, run: RunRecord) => void;
  logger?: EngineLogger;
  /** Default per-attempt timeout when a node does not set `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Maximum JSON size of a single step output. */
  maxOutputBytes?: number;
  /** Maximum sub-workflow nesting. */
  maxDepth?: number;
}

export interface StartRunRequest {
  workflowId: string;
  /** Explicit version; defaults to the currently published version. */
  version?: number;
  input?: unknown;
  trigger: TriggerInfo;
  createdBy?: string | null;
  runId?: string;
  parent?: { runId: string; nodeId: string; depth: number };
}

interface Prepared {
  def: WorkflowDefinition;
  order: string[];
  nodes: Map<string, NodeDef>;
  incoming: Map<string, EdgeDef[]>;
  outgoing: Map<string, EdgeDef[]>;
}

type Attempt = { ok: true; outcome: StepOutcome } | { ok: false; error: unknown };

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

let fallbackCounter = 0;
function fallbackId(): string {
  fallbackCounter = (fallbackCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${fallbackCounter.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Computes the delay before attempt `failedAttempt + 1`. */
export function retryDelay(policy: RetryPolicy, failedAttempt: number): number {
  const raw = policy.initialDelayMs * policy.backoffMultiplier ** (failedAttempt - 1);
  return Math.min(Math.round(raw), policy.maxDelayMs);
}

function toRunError(error: unknown, nodeId?: string): RunError & { retryable: boolean } {
  if (error instanceof StepError) {
    return { message: error.message, code: error.code, retryable: error.retryable, ...(nodeId ? { nodeId } : {}) };
  }
  if (error instanceof ExpressionError) {
    return { message: `expression error: ${error.message}`, code: "EXPRESSION_ERROR", retryable: false, ...(nodeId ? { nodeId } : {}) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, code: "STEP_FAILED", retryable: true, ...(nodeId ? { nodeId } : {}) };
}

/**
 * Durable workflow execution engine.
 *
 * Every state transition (step started/completed/waiting/failed, run status)
 * is written to the RunStore synchronously before any further work starts, so
 * a fresh engine over the same store can `recover()` and continue a run that
 * was interrupted at any point. Steps execute at-least-once.
 */
export class WorkflowEngine {
  private readonly store: RunStore;
  private readonly clock: Clock;
  private readonly handlers: Record<string, NodeHandler>;
  private readonly newId: () => string;
  private readonly prepared = new Map<string, Prepared>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingChildren = new Map<string, { workflowId: string; input: unknown; runId: string }[]>();
  private stopped = false;

  constructor(private readonly options: EngineOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.handlers = options.handlers;
    this.newId = options.idGenerator ?? fallbackId;
  }

  // ---------------------------------------------------------------- public API

  startRun(request: StartRunRequest): RunRecord {
    this.assertRunning();
    const { version, definition } = this.resolveDefinition(request.workflowId, request.version);
    const prepared = this.prepare(request.workflowId, version, definition);
    const depth = request.parent ? request.parent.depth + 1 : 0;
    if (depth > (this.options.maxDepth ?? 5)) {
      throw new EngineError("MAX_DEPTH", `sub-workflow nesting exceeds ${this.options.maxDepth ?? 5}`);
    }
    const trigger = definition.nodes.find((n) => isTriggerType(n.type));
    if (!trigger) throw new EngineError("INVALID_DEFINITION", "workflow has no trigger node");
    const input = request.input ?? {};
    this.checkTriggerInput(trigger, input);

    const now = this.clock.now();
    const maxDuration = definition.settings?.maxRunDurationMs;
    const run: RunRecord = {
      id: request.runId ?? this.newId(),
      workflowId: request.workflowId,
      version,
      status: "running",
      trigger: request.trigger,
      input,
      vars: { ...(definition.variables ?? {}) },
      output: null,
      error: null,
      parentRunId: request.parent?.runId ?? null,
      parentNodeId: request.parent?.nodeId ?? null,
      depth,
      createdBy: request.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      deadlineAt: maxDuration ? now + maxDuration : null,
    };
    const triggerStep = this.newStep(run.id, trigger, "succeeded", input, now);
    triggerStep.port = "out";
    triggerStep.output = input;
    triggerStep.finishedAt = now;
    this.store.transaction(() => {
      this.store.insertRun(run);
      this.store.saveStep(triggerStep);
      this.emit(run, { runId: run.id, nodeId: null, type: "run.started", at: now, data: { trigger: request.trigger.type } });
      this.emit(run, { runId: run.id, nodeId: trigger.id, type: "step.succeeded", at: now, data: { port: "out" } });
    });
    this.armDeadline(run);
    this.advance(run.id, prepared);
    return this.store.getRun(run.id) ?? run;
  }

  /** Delivers an external signal (approval decision, child completion) to a waiting step. */
  signal(runId: string, nodeId: string, payload: unknown): void {
    this.assertRunning();
    const run = this.requireActiveRun(runId);
    const step = this.store.getStep(runId, nodeId);
    if (!step || step.status !== "waiting" || step.wakeReason === "retry") {
      throw new EngineError("NOT_WAITING", `step '${nodeId}' is not waiting for a signal`);
    }
    this.resumeStep(run, step, { kind: "signal", payload });
  }

  cancel(runId: string, reason = "cancelled by user"): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new EngineError("NOT_FOUND", `run ${runId} not found`);
    if (isTerminalRun(run.status)) throw new EngineError("ALREADY_FINISHED", `run is already ${run.status}`);
    this.finishRun(run, "cancelled", { error: { message: reason, code: "CANCELLED" } });
    return this.store.getRun(runId) ?? run;
  }

  /**
   * Resumes all active runs from persisted state. Call once at startup:
   * running steps are re-executed (or their pending resume event replayed),
   * timers are re-armed and missing successor steps are created.
   */
  recover(): { runs: number; steps: number } {
    this.assertRunning();
    let steps = 0;
    const runs = this.store.listActiveRuns();
    for (const run of runs) {
      let prepared: Prepared;
      try {
        prepared = this.preparedFor(run);
      } catch (err) {
        this.finishRun(run, "failed", { error: { message: (err as Error).message, code: "DEFINITION_MISSING" } });
        continue;
      }
      this.emit(run, { runId: run.id, nodeId: null, type: "run.recovered", at: this.clock.now() });
      this.armDeadline(run);
      for (const step of this.store.listSteps(run.id)) {
        const node = prepared.nodes.get(step.nodeId);
        if (!node) continue;
        if (step.status === "running") {
          steps++;
          this.dispatch(run.id, node, step.pendingEvent ?? undefined);
        } else if (step.status === "waiting") {
          steps++;
          if (step.wakeAt !== null) this.armWake(step);
          this.recoverChild(run, step);
        }
      }
      this.advance(run.id, prepared);
    }
    return { runs: runs.length, steps };
  }

  /** Resolves once no step execution is in flight. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Stops the engine without touching persisted state (as if the process
   * died). In-flight completions are discarded; use `recover()` on a new
   * engine to continue.
   */
  shutdown(): void {
    this.stopped = true;
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
    for (const c of this.controllers.values()) c.abort(new EngineError("SHUTDOWN", "engine stopped"));
    this.controllers.clear();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  // ---------------------------------------------------------------- definitions

  private resolveDefinition(workflowId: string, version?: number): { version: number; definition: WorkflowDefinition } {
    if (version !== undefined) {
      const definition = this.options.definitions.getVersion(workflowId, version);
      if (!definition) throw new EngineError("NOT_FOUND", `workflow ${workflowId} v${version} not found`);
      return { version, definition };
    }
    const published = this.options.definitions.getPublished(workflowId);
    if (!published) throw new EngineError("NOT_PUBLISHED", `workflow ${workflowId} has no published version`);
    return published;
  }

  private prepare(workflowId: string, version: number, def: WorkflowDefinition): Prepared {
    const key = `${workflowId}@${version}`;
    const cached = this.prepared.get(key);
    if (cached) return cached;
    const validation = validateDefinition(def);
    if (!validation.valid) {
      const first = validation.issues.find((i) => i.severity === "error");
      throw new EngineError("INVALID_DEFINITION", `definition is invalid: ${first?.message ?? "unknown error"}`);
    }
    const incoming = new Map<string, EdgeDef[]>();
    const outgoing = new Map<string, EdgeDef[]>();
    for (const e of def.edges) {
      incoming.set(e.target.node, [...(incoming.get(e.target.node) ?? []), e]);
      outgoing.set(e.source.node, [...(outgoing.get(e.source.node) ?? []), e]);
    }
    for (const node of def.nodes) {
      if (!isTriggerType(node.type) && !this.handlers[node.type]) {
        throw new EngineError("NO_HANDLER", `no handler registered for node type ${node.type}`);
      }
    }
    const prepared: Prepared = {
      def,
      order: topologicalOrder(def).order,
      nodes: new Map(def.nodes.map((n) => [n.id, n])),
      incoming,
      outgoing,
    };
    this.prepared.set(key, prepared);
    return prepared;
  }

  private preparedFor(run: RunRecord): Prepared {
    const def = this.options.definitions.getVersion(run.workflowId, run.version);
    if (!def) throw new EngineError("NOT_FOUND", `definition ${run.workflowId} v${run.version} is missing`);
    return this.prepare(run.workflowId, run.version, def);
  }

  private checkTriggerInput(trigger: NodeDef, input: unknown): void {
    const required = trigger.config["requiredFields"];
    if (!Array.isArray(required) || required.length === 0) return;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new EngineError("INVALID_INPUT", "trigger input must be an object");
    }
    const missing = required.filter((k) => typeof k === "string" && !Object.hasOwn(input, k));
    if (missing.length > 0) throw new EngineError("INVALID_INPUT", `trigger input is missing: ${missing.join(", ")}`);
  }

  // ---------------------------------------------------------------- scheduling

  private advance(runId: string, prepared?: Prepared): void {
    if (this.stopped) return;
    const run = this.store.getRun(runId);
    if (!run || isTerminalRun(run.status)) return;
    const p = prepared ?? this.preparedFor(run);
    const steps = new Map(this.store.listSteps(runId).map((s) => [s.nodeId, s]));
    const started: { node: NodeDef; step: StepRecord }[] = [];
    let finished = false;
    this.store.transaction(() => {
      for (const nodeId of p.order) {
        if (steps.has(nodeId)) continue;
        const node = p.nodes.get(nodeId);
        if (!node || isTriggerType(node.type)) continue;
        const edges = p.incoming.get(nodeId) ?? [];
        const states = edges.map((e) => this.edgeState(e, steps));
        const anyMode = node.type === "flow.join" && node.config["mode"] === "any";
        const active = states.includes("active");
        const pending = states.includes("pending");
        if (anyMode ? !active && pending : pending) continue;
        const now = this.clock.now();
        if (!active) {
          const skipped = this.newStep(runId, node, "skipped", null, now);
          skipped.finishedAt = now;
          this.store.saveStep(skipped);
          steps.set(nodeId, skipped);
          this.emit(run, { runId, nodeId, type: "step.skipped", at: now });
          continue;
        }
        const input = this.collectInput(node, edges, steps);
        const step = this.newStep(runId, node, "running", input, now);
        this.store.saveStep(step);
        steps.set(nodeId, step);
        this.emit(run, { runId, nodeId, type: "step.started", at: now, data: { attempt: 1 } });
        started.push({ node, step });
      }
      const live = [...steps.values()].filter((s) => s.status === "running" || s.status === "waiting");
      if (live.length === 0) {
        finished = true;
        return;
      }
      const status: RunStatus = live.some((s) => s.status === "running") ? "running" : "waiting";
      if (status !== run.status) {
        run.status = status;
        run.updatedAt = this.clock.now();
        this.store.updateRun(run);
      }
    });
    if (finished) {
      this.finishRun(run, "succeeded", { output: run.vars });
      return;
    }
    for (const { node } of started) this.dispatch(runId, node);
  }

  private edgeState(edge: EdgeDef, steps: Map<string, StepRecord>): "active" | "dead" | "pending" {
    const source = steps.get(edge.source.node);
    if (!source || source.status === "running" || source.status === "waiting") return "pending";
    if ((source.status === "succeeded" || source.status === "failed") && source.port === edge.source.port) return "active";
    return "dead";
  }

  private collectInput(node: NodeDef, edges: EdgeDef[], steps: Map<string, StepRecord>): unknown {
    const activeSources = edges
      .filter((e) => this.edgeState(e, steps) === "active")
      .map((e) => steps.get(e.source.node) as StepRecord);
    if (activeSources.length === 1 && node.type !== "flow.join") return activeSources[0]?.output ?? null;
    const merged: Record<string, unknown> = {};
    for (const s of activeSources) merged[s.nodeId] = s.output;
    return merged;
  }

  private newStep(runId: string, node: NodeDef, status: StepRecord["status"], input: unknown, now: number): StepRecord {
    return {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      status,
      attempt: 1,
      port: null,
      input,
      output: null,
      error: null,
      state: null,
      wakeAt: null,
      wakeReason: null,
      pendingEvent: null,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    };
  }

  // ---------------------------------------------------------------- execution

  private stepKey(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`;
  }

  private dispatch(runId: string, node: NodeDef, event?: ResumeEvent): void {
    if (this.stopped) return;
    const run = this.store.getRun(runId);
    const step = this.store.getStep(runId, node.id);
    if (!run || !step) return;
    const handler = this.handlers[node.type] as NodeHandler;
    const key = this.stepKey(runId, node.id);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const token = { attempt: step.attempt, startedAt: step.updatedAt };
    const ctx = this.buildContext(run, node, step, controller.signal);
    const timeoutMs = node.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const task = (async (): Promise<void> => {
      // Execution begins after the dispatching transition has completed; the
      // timeout is measured from here, not from when the step was scheduled.
      await Promise.resolve();
      if (this.stopped || controller.signal.aborted) return;
      let result: Attempt;
      let timer: TimerHandle | undefined;
      try {
        const work = Promise.resolve().then(() =>
          event && handler.resume ? handler.resume(ctx, event) : handler.execute(ctx),
        );
        const timeout = new Promise<never>((_, reject) => {
          timer = this.clock.setTimer(this.clock.now() + timeoutMs, () => {
            const error = new StepError(`step timed out after ${timeoutMs} ms`, { code: "TIMEOUT", retryable: true });
            controller.abort(error);
            reject(error);
          });
        });
        result = { ok: true, outcome: await Promise.race([work, timeout]) };
      } catch (error) {
        result = { ok: false, error };
      } finally {
        timer?.cancel();
      }
      if (this.stopped) return;
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      this.complete(runId, node, token, result);
    })();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private buildContext(run: RunRecord, node: NodeDef, step: StepRecord, signal: AbortSignal): StepContext {
    const steps: Record<string, unknown> = {};
    for (const s of this.store.listSteps(run.id)) {
      if (s.status === "succeeded" || s.status === "failed") {
        steps[s.nodeId] = { output: s.output, status: s.status, port: s.port, attempt: s.attempt };
      }
    }
    const scope: Record<string, unknown> = {
      input: step.input,
      trigger: run.input,
      vars: run.vars,
      steps,
      run: { id: run.id, workflowId: run.workflowId, version: run.version, startedAt: run.createdAt, attempt: step.attempt },
    };
    const evalOptions = { now: () => this.clock.now() };
    const key = this.stepKey(run.id, node.id);
    return {
      run,
      node,
      attempt: step.attempt,
      input: step.input,
      state: step.state,
      signal,
      scope,
      now: () => this.clock.now(),
      evaluate: (source: string): Value => compileExpression(source).evaluate(scope, evalOptions),
      render: (template: string): Value => renderTemplate(template, scope, evalOptions),
      renderDeep: (value: unknown): Value => renderDeep(value, scope, evalOptions),
      startChildRun: (workflowId: string, input: unknown): string => {
        const childId = this.newId();
        this.pendingChildren.set(key, [...(this.pendingChildren.get(key) ?? []), { workflowId, input, runId: childId }]);
        return childId;
      },
    };
  }

  private complete(runId: string, node: NodeDef, token: { attempt: number; startedAt: number }, result: Attempt): void {
    const key = this.stepKey(runId, node.id);
    const children = this.pendingChildren.get(key) ?? [];
    this.pendingChildren.delete(key);
    const run = this.store.getRun(runId);
    const step = this.store.getStep(runId, node.id);
    // Stale completion: the step was cancelled, retried or the run finished meanwhile.
    if (!run || !step || isTerminalRun(run.status) || step.status !== "running" || step.attempt !== token.attempt) {
      return;
    }
    if (step.updatedAt !== token.startedAt) return;
    const now = this.clock.now();
    if (!result.ok) {
      this.handleFailure(run, node, step, result.error);
      return;
    }
    const outcome = result.outcome;
    let error: StepError | undefined;
    if (outcome.type === "complete") {
      const spec = getNodeType(node.type);
      const port = outcome.port ?? spec?.outputs[0]?.name ?? "out";
      if (spec && !spec.outputs.some((p) => p.name === port)) {
        error = new StepError(`handler chose unknown port '${port}'`, { code: "BAD_PORT", retryable: false });
      } else if (this.tooLarge(outcome.output)) {
        error = new StepError("step output exceeds the size limit", { code: "OUTPUT_TOO_LARGE", retryable: false });
      } else {
        this.store.transaction(() => {
          step.status = "succeeded";
          step.port = port;
          step.output = outcome.output ?? null;
          step.error = null;
          step.wakeAt = null;
          step.wakeReason = null;
          step.pendingEvent = null;
          step.finishedAt = now;
          step.updatedAt = now;
          this.store.saveStep(step);
          if (outcome.vars) {
            run.vars = { ...run.vars, ...outcome.vars };
            run.updatedAt = now;
            this.store.updateRun(run);
          }
          this.emit(run, { runId, nodeId: node.id, type: "step.succeeded", at: now, data: { port, attempt: step.attempt } });
        });
        this.advance(runId);
        return;
      }
    } else if (outcome.type === "wait") {
      this.store.transaction(() => {
        step.status = "waiting";
        step.wakeAt = outcome.wakeAt ?? null;
        step.wakeReason = step.wakeAt !== null ? "resume" : null;
        step.pendingEvent = null;
        if (outcome.state !== undefined) step.state = outcome.state;
        step.updatedAt = now;
        this.store.saveStep(step);
        this.emit(run, { runId, nodeId: node.id, type: "step.waiting", at: now, data: { wakeAt: step.wakeAt } });
      });
      if (step.wakeAt !== null) this.armWake(step);
      for (const child of children) this.startChild(run, node, child);
      this.advance(runId);
      return;
    } else {
      this.store.transaction(() => {
        step.status = "succeeded";
        step.port = null;
        step.output = outcome.output ?? null;
        step.finishedAt = now;
        step.updatedAt = now;
        this.store.saveStep(step);
        this.emit(run, { runId, nodeId: node.id, type: "step.succeeded", at: now, data: { end: outcome.status } });
      });
      if (outcome.status === "succeeded") this.finishRun(run, "succeeded", { output: outcome.output ?? run.vars });
      else this.finishRun(run, "failed", { error: { message: outcome.message ?? "workflow ended with failure", code: "END_FAILED", nodeId: node.id } });
      return;
    }
    if (error) this.handleFailure(run, node, step, error);
  }

  private tooLarge(output: unknown): boolean {
    if (output === undefined || output === null) return false;
    try {
      return JSON.stringify(output).length > (this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
    } catch {
      return true;
    }
  }

  private handleFailure(run: RunRecord, node: NodeDef, step: StepRecord, raw: unknown): void {
    const now = this.clock.now();
    const error = toRunError(raw, node.id);
    const { retryable, ...stored } = error;
    const policy = node.retry;
    const spec = getNodeType(node.type);
    if (retryable && spec?.retryable && policy && step.attempt < policy.maxAttempts) {
      const delay = retryDelay(policy, step.attempt);
      this.store.transaction(() => {
        step.status = "waiting";
        step.error = stored;
        step.wakeAt = now + delay;
        step.wakeReason = "retry";
        step.pendingEvent = null;
        step.updatedAt = now;
        this.store.saveStep(step);
        this.emit(run, {
          runId: run.id,
          nodeId: node.id,
          type: "step.retry_scheduled",
          at: now,
          data: { attempt: step.attempt, delayMs: delay, error: stored.message },
        });
      });
      this.armWake(step);
      this.advance(run.id);
      return;
    }
    const prepared = this.preparedFor(run);
    const handled = (prepared.outgoing.get(node.id) ?? []).some((e) => e.source.port === "error");
    this.store.transaction(() => {
      step.status = "failed";
      step.error = stored;
      step.port = handled ? "error" : null;
      step.output = handled ? { error: stored, attempts: step.attempt, input: step.input } : null;
      step.wakeAt = null;
      step.wakeReason = null;
      step.pendingEvent = null;
      step.finishedAt = now;
      step.updatedAt = now;
      this.store.saveStep(step);
      this.emit(run, {
        runId: run.id,
        nodeId: node.id,
        type: "step.failed",
        at: now,
        data: { error: stored.message, code: stored.code, attempt: step.attempt, handled },
      });
    });
    if (handled) this.advance(run.id);
    else this.finishRun(run, "failed", { error: stored });
  }

  private armWake(step: StepRecord): void {
    if (this.stopped || step.wakeAt === null) return;
    const key = this.stepKey(step.runId, step.nodeId);
    this.timers.get(key)?.cancel();
    const wakeAt = step.wakeAt;
    this.timers.set(
      key,
      this.clock.setTimer(wakeAt, () => {
        this.timers.delete(key);
        this.onWake(step.runId, step.nodeId, wakeAt);
      }),
    );
  }

  private onWake(runId: string, nodeId: string, wakeAt: number): void {
    if (this.stopped) return;
    const run = this.store.getRun(runId);
    const step = this.store.getStep(runId, nodeId);
    if (!run || isTerminalRun(run.status) || !step || step.status !== "waiting" || step.wakeAt !== wakeAt) return;
    const node = this.preparedFor(run).nodes.get(nodeId);
    if (!node) return;
    if (step.wakeReason === "retry") {
      const now = this.clock.now();
      this.store.transaction(() => {
        step.status = "running";
        step.attempt += 1;
        step.wakeAt = null;
        step.wakeReason = null;
        step.updatedAt = now;
        this.store.saveStep(step);
        this.markRunRunning(run, now);
        this.emit(run, { runId, nodeId, type: "step.started", at: now, data: { attempt: step.attempt } });
      });
      this.dispatch(runId, node);
    } else {
      this.resumeStep(run, step, { kind: "timer" });
    }
  }

  private resumeStep(run: RunRecord, step: StepRecord, event: ResumeEvent): void {
    const node = this.preparedFor(run).nodes.get(step.nodeId);
    if (!node) throw new EngineError("NOT_FOUND", `node ${step.nodeId} not in definition`);
    const key = this.stepKey(run.id, step.nodeId);
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
    const now = this.clock.now();
    this.store.transaction(() => {
      step.status = "running";
      step.pendingEvent = event;
      step.wakeAt = null;
      step.wakeReason = null;
      step.updatedAt = now;
      this.store.saveStep(step);
      this.markRunRunning(run, now);
      this.emit(run, { runId: run.id, nodeId: step.nodeId, type: "step.resumed", at: now, data: { kind: event.kind } });
    });
    this.dispatch(run.id, node, event);
  }

  private markRunRunning(run: RunRecord, now: number): void {
    if (run.status !== "running") {
      run.status = "running";
      run.updatedAt = now;
      this.store.updateRun(run);
    }
  }

  // ---------------------------------------------------------------- sub-workflows

  private startChild(parent: RunRecord, node: NodeDef, child: { workflowId: string; input: unknown; runId: string }): void {
    try {
      this.startRun({
        workflowId: child.workflowId,
        input: child.input,
        trigger: { type: "subworkflow", meta: { parentRunId: parent.id, parentNodeId: node.id } },
        createdBy: parent.createdBy,
        runId: child.runId,
        parent: { runId: parent.id, nodeId: node.id, depth: parent.depth },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const step = this.store.getStep(parent.id, node.id);
      if (step?.status === "waiting") {
        this.resumeStep(parent, step, { kind: "signal", payload: { childRunId: child.runId, status: "failed", error: { message, code: "CHILD_START_FAILED" } } });
      }
    }
  }

  private recoverChild(run: RunRecord, step: StepRecord): void {
    const state = step.state as { childRunId?: string; workflowId?: string; input?: unknown } | null;
    if (!state?.childRunId) return;
    const child = this.store.getRun(state.childRunId);
    if (!child) {
      const node = this.preparedFor(run).nodes.get(step.nodeId);
      if (node && state.workflowId) this.startChild(run, node, { workflowId: state.workflowId, input: state.input, runId: state.childRunId });
      return;
    }
    if (isTerminalRun(child.status)) this.notifyParent(child);
  }

  private notifyParent(child: RunRecord): void {
    if (!child.parentRunId || !child.parentNodeId) return;
    const parent = this.store.getRun(child.parentRunId);
    const step = parent ? this.store.getStep(parent.id, child.parentNodeId) : undefined;
    if (!parent || isTerminalRun(parent.status) || step?.status !== "waiting") return;
    this.resumeStep(parent, step, {
      kind: "signal",
      payload: { childRunId: child.id, status: child.status, output: child.output, error: child.error },
    });
  }

  // ---------------------------------------------------------------- run lifecycle

  private armDeadline(run: RunRecord): void {
    if (run.deadlineAt === null || this.stopped) return;
    const key = `${run.id}:deadline`;
    this.timers.get(key)?.cancel();
    this.timers.set(
      key,
      this.clock.setTimer(run.deadlineAt, () => {
        this.timers.delete(key);
        const current = this.store.getRun(run.id);
        if (current && !isTerminalRun(current.status) && !this.stopped) {
          this.finishRun(current, "failed", { error: { message: "run exceeded its maximum duration", code: "RUN_TIMEOUT" } });
        }
      }),
    );
  }

  private finishRun(run: RunRecord, status: "succeeded" | "failed" | "cancelled", result: { output?: unknown; error?: RunError }): void {
    if (isTerminalRun(run.status)) return;
    const now = this.clock.now();
    const prepared = this.prepared.get(`${run.workflowId}@${run.version}`);
    const toCancel = this.store.listSteps(run.id).filter((s) => s.status === "running" || s.status === "waiting");
    this.store.transaction(() => {
      for (const step of toCancel) {
        step.status = "cancelled";
        step.wakeAt = null;
        step.wakeReason = null;
        step.finishedAt = now;
        step.updatedAt = now;
        this.store.saveStep(step);
        this.emit(run, { runId: run.id, nodeId: step.nodeId, type: "step.cancelled", at: now });
      }
      run.status = status;
      run.output = status === "succeeded" ? (result.output ?? null) : null;
      run.error = result.error ?? null;
      run.finishedAt = now;
      run.updatedAt = now;
      this.store.updateRun(run);
      this.emit(run, {
        runId: run.id,
        nodeId: null,
        type: `run.${status}`,
        at: now,
        data: result.error ? { error: result.error.message, code: result.error.code } : {},
      });
    });
    for (const step of toCancel) {
      const key = this.stepKey(run.id, step.nodeId);
      this.timers.get(key)?.cancel();
      this.timers.delete(key);
      this.controllers.get(key)?.abort(new EngineError("CANCELLED", "run finished"));
      this.controllers.delete(key);
      const node = prepared?.nodes.get(step.nodeId);
      const handler = node ? this.handlers[node.type] : undefined;
      if (node && handler?.cancel) {
        try {
          handler.cancel(this.buildContext(run, node, step, new AbortController().signal));
        } catch (err) {
          this.options.logger?.warn("handler cancel failed", { runId: run.id, nodeId: node.id, error: String(err) });
        }
      }
    }
    this.timers.get(`${run.id}:deadline`)?.cancel();
    this.timers.delete(`${run.id}:deadline`);
    for (const child of this.store.findChildRuns(run.id)) {
      if (!isTerminalRun(child.status)) this.finishRun(child, "cancelled", { error: { message: "parent run finished", code: "PARENT_FINISHED" } });
    }
    this.notifyParent(run);
  }

  private requireActiveRun(runId: string): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new EngineError("NOT_FOUND", `run ${runId} not found`);
    if (isTerminalRun(run.status)) throw new EngineError("ALREADY_FINISHED", `run is already ${run.status}`);
    return run;
  }

  private assertRunning(): void {
    if (this.stopped) throw new EngineError("SHUTDOWN", "engine has been shut down");
  }

  private emit(run: RunRecord, event: RunEvent): void {
    this.store.appendEvent(event);
    if (this.options.onEvent) {
      try {
        this.options.onEvent(event, run);
      } catch (err) {
        this.options.logger?.error("onEvent listener failed", { error: String(err) });
      }
    }
  }
}
