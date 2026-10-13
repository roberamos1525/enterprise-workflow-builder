import type { WorkflowDefinition } from "../model/types.js";
import { ManualClock } from "../runtime/clock.js";
import { WorkflowEngine, type EngineOptions } from "../runtime/engine.js";
import { createHandlers, type ApprovalHost, type ApprovalRequest, type HttpRequest, type HttpResponse, type Notifier } from "../runtime/handlers.js";
import { MemoryDefinitions, MemoryRunStore } from "../runtime/memory-store.js";
import type { RunEvent } from "../runtime/types.js";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const ok = (body: unknown = {}, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export class FakeApprovals implements ApprovalHost {
  readonly records = new Map<string, ApprovalRequest & { status: string; escalatedTo: string[] }>();
  create(request: ApprovalRequest): string {
    const id = `appr:${request.runId}:${request.nodeId}`;
    if (!this.records.has(id)) this.records.set(id, { ...request, status: "pending", escalatedTo: [] });
    return id;
  }
  escalate(id: string, add: string[], dueAt: number | null): void {
    const r = this.records.get(id)!;
    r.status = "escalated";
    r.escalatedTo.push(...add);
    r.dueAt = dueAt;
  }
  close(id: string, status: "timed_out" | "cancelled"): void {
    this.records.get(id)!.status = status;
  }
}

export class FakeNotifier implements Notifier {
  readonly inAppSent: { recipients: string[]; title: string; message: string }[] = [];
  readonly webhooks: { url: string; payload: Record<string, unknown> }[] = [];
  webhookStatus = 200;
  inApp(req: { recipients: string[]; title: string; message: string }) {
    this.inAppSent.push({ recipients: req.recipients, title: req.title, message: req.message });
    return { delivered: req.recipients.length };
  }
  async webhook(req: { url: string; payload: Record<string, unknown> }) {
    this.webhooks.push({ url: req.url, payload: req.payload });
    return { status: this.webhookStatus };
  }
}

export type HttpScript = (req: HttpRequest, call: number) => Promise<HttpResponse> | HttpResponse;

/** Shared persistent pieces (store/definitions/clock) survive engine "restarts". */
export class Harness {
  readonly clock = new ManualClock("2026-06-01T00:00:00Z");
  readonly store = new MemoryRunStore();
  readonly definitions = new MemoryDefinitions();
  readonly approvals = new FakeApprovals();
  readonly notifier = new FakeNotifier();
  readonly httpCalls: HttpRequest[] = [];
  readonly live: RunEvent[] = [];
  http: HttpScript = () => ok();
  engine: WorkflowEngine;
  private ids = 0;

  constructor(private readonly extra: Partial<EngineOptions> = {}) {
    this.engine = this.createEngine();
  }

  createEngine(): WorkflowEngine {
    return new WorkflowEngine({
      store: this.store,
      clock: this.clock,
      definitions: this.definitions,
      idGenerator: () => `id${++this.ids}`,
      onEvent: (e) => this.live.push(e),
      handlers: createHandlers({
        http: {
          request: async (req) => {
            this.httpCalls.push(req);
            return this.http(req, this.httpCalls.length);
          },
        },
        notifier: this.notifier,
        approvals: this.approvals,
      }),
      ...this.extra,
    });
  }

  /** Simulates a process crash + restart: old engine stops, a new one recovers from the same store. */
  restart(): WorkflowEngine {
    this.engine.shutdown();
    this.engine = this.createEngine();
    this.engine.recover();
    return this.engine;
  }

  publish(workflowId: string, def: WorkflowDefinition): number {
    return this.definitions.publish(workflowId, def);
  }

  start(workflowId: string, input: unknown = {}) {
    return this.engine.startRun({ workflowId, input, trigger: { type: "manual" } });
  }

  run(id: string) {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`run ${id} missing`);
    return run;
  }

  step(runId: string, nodeId: string) {
    const step = this.store.getStep(runId, nodeId);
    if (!step) throw new Error(`step ${nodeId} missing`);
    return step;
  }

  statuses(runId: string): Record<string, string> {
    return Object.fromEntries(this.store.listSteps(runId).map((s) => [s.nodeId, s.status]));
  }

  eventTypes(runId: string, nodeId?: string): string[] {
    return this.store.eventsFor(runId).filter((e) => nodeId === undefined || e.nodeId === nodeId).map((e) => e.type);
  }

  async settle(): Promise<void> {
    await this.engine.idle();
  }

  /** Advances the fake clock and waits for resulting work. */
  async advance(ms: number): Promise<void> {
    this.clock.advance(ms);
    await this.engine.idle();
  }
}
