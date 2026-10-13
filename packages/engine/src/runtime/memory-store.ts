import type { WorkflowDefinition } from "../model/types.js";
import { isTerminalRun, type DefinitionProvider, type RunEvent, type RunRecord, type RunStore, type StepRecord } from "./types.js";

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * In-memory RunStore. Records are deep-copied on the way in and out so the
 * engine can never mutate stored state without calling the store, which keeps
 * behaviour identical to the SQLite implementation. Supports snapshot/restore
 * to simulate process restarts in tests.
 */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();
  private steps = new Map<string, StepRecord>();
  readonly events: RunEvent[] = [];
  private txDepth = 0;
  private txBackup: { runs: Map<string, RunRecord>; steps: Map<string, StepRecord>; events: number } | undefined;

  insertRun(run: RunRecord): void {
    if (this.runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
    this.runs.set(run.id, clone(run));
  }

  updateRun(run: RunRecord): void {
    if (!this.runs.has(run.id)) throw new Error(`run ${run.id} does not exist`);
    this.runs.set(run.id, clone(run));
  }

  getRun(id: string): RunRecord | undefined {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].map(clone);
  }

  listActiveRuns(): RunRecord[] {
    return [...this.runs.values()].filter((r) => !isTerminalRun(r.status)).map(clone);
  }

  findChildRuns(parentRunId: string): RunRecord[] {
    return [...this.runs.values()].filter((r) => r.parentRunId === parentRunId).map(clone);
  }

  listSteps(runId: string): StepRecord[] {
    return [...this.steps.values()].filter((s) => s.runId === runId).map(clone);
  }

  getStep(runId: string, nodeId: string): StepRecord | undefined {
    const step = this.steps.get(`${runId}:${nodeId}`);
    return step ? clone(step) : undefined;
  }

  saveStep(step: StepRecord): void {
    this.steps.set(`${step.runId}:${step.nodeId}`, clone(step));
  }

  appendEvent(event: RunEvent): void {
    this.events.push(clone(event));
  }

  eventsFor(runId: string): RunEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }

  /** Nested calls join the outermost transaction; a throw rolls everything back. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.txBackup = { runs: new Map(this.runs), steps: new Map(this.steps), events: this.events.length };
    }
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      if (this.txDepth === 0) this.txBackup = undefined;
      return result;
    } catch (err) {
      this.txDepth--;
      if (this.txDepth === 0 && this.txBackup) {
        this.runs = this.txBackup.runs;
        this.steps = this.txBackup.steps;
        this.events.length = this.txBackup.events;
        this.txBackup = undefined;
      }
      throw err;
    }
  }
}

/** Simple DefinitionProvider for tests and embedding: versions are immutable once added. */
export class MemoryDefinitions implements DefinitionProvider {
  private readonly versions = new Map<string, Map<number, WorkflowDefinition>>();
  private readonly published = new Map<string, number>();

  publish(workflowId: string, definition: WorkflowDefinition): number {
    const versions = this.versions.get(workflowId) ?? new Map<number, WorkflowDefinition>();
    const version = versions.size + 1;
    versions.set(version, clone(definition));
    this.versions.set(workflowId, versions);
    this.published.set(workflowId, version);
    return version;
  }

  getVersion(workflowId: string, version: number): WorkflowDefinition | undefined {
    const def = this.versions.get(workflowId)?.get(version);
    return def ? clone(def) : undefined;
  }

  getPublished(workflowId: string): { version: number; definition: WorkflowDefinition } | undefined {
    const version = this.published.get(workflowId);
    if (version === undefined) return undefined;
    const definition = this.getVersion(workflowId, version);
    return definition ? { version, definition } : undefined;
  }
}
