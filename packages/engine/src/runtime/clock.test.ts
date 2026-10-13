import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock, SystemClock } from "./clock.js";
import { MemoryRunStore } from "./memory-store.js";

describe("ManualClock", () => {
  it("fires timers in chronological order, including ones armed during the advance", () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    clock.setTimer(300, () => fired.push(`c@${clock.now()}`));
    clock.setTimer(100, () => {
      fired.push(`a@${clock.now()}`);
      clock.setTimer(150, () => fired.push(`nested@${clock.now()}`));
    });
    clock.setTimer(100, () => fired.push(`b@${clock.now()}`));
    clock.setTimer(900, () => fired.push("late"));
    clock.advance(500);
    expect(fired).toEqual(["a@100", "b@100", "nested@150", "c@300"]);
    expect(clock.now()).toBe(500);
    expect(clock.pendingTimers).toBe(1);
    expect(clock.nextTimerAt).toBe(900);
  });

  it("supports cancellation, past timers and ISO start times, but never runs backwards", () => {
    const clock = new ManualClock("2026-01-01T00:00:00Z");
    const fired: number[] = [];
    clock.setTimer(clock.now() + 10, () => fired.push(1)).cancel();
    clock.setTimer(clock.now() - 10, () => fired.push(2));
    clock.advance(0);
    expect(fired).toEqual([2]);
    expect(() => clock.set(0)).toThrow(/backwards/);
  });
});

describe("SystemClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires at the absolute time and can be cancelled", () => {
    vi.useFakeTimers({ now: 0 });
    const clock = new SystemClock();
    const fired: number[] = [];
    clock.setTimer(1000, () => fired.push(Date.now()));
    const cancelled = clock.setTimer(500, () => fired.push(-1));
    cancelled.cancel();
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([1000]);
  });

  it("chains delays longer than the 32-bit setTimeout limit", () => {
    vi.useFakeTimers({ now: 0 });
    const clock = new SystemClock();
    const at = 2 ** 31 + 5_000;
    let fired = false;
    clock.setTimer(at, () => (fired = true));
    vi.advanceTimersByTime(2 ** 31 - 1);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(fired).toBe(true);
  });
});

describe("MemoryRunStore transactions", () => {
  it("rolls back every write of a failed outer transaction, including nested ones", () => {
    const store = new MemoryRunStore();
    const run = { id: "r", workflowId: "w", version: 1, status: "running", trigger: { type: "manual" }, input: {}, vars: {}, output: null, error: null, parentRunId: null, parentNodeId: null, depth: 0, createdBy: null, createdAt: 0, updatedAt: 0, finishedAt: null, deadlineAt: null } as const;
    expect(() =>
      store.transaction(() => {
        store.insertRun({ ...run });
        store.transaction(() => store.appendEvent({ runId: "r", nodeId: null, type: "run.started", at: 0 }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getRun("r")).toBeUndefined();
    expect(store.events).toEqual([]);
    store.insertRun({ ...run });
    expect(() => store.insertRun({ ...run })).toThrow(/already exists/);
    expect(() => store.updateRun({ ...run, id: "missing" })).toThrow(/does not exist/);
  });

  it("returns defensive copies", () => {
    const store = new MemoryRunStore();
    store.insertRun({ id: "r", workflowId: "w", version: 1, status: "running", trigger: { type: "manual" }, input: { a: 1 }, vars: {}, output: null, error: null, parentRunId: null, parentNodeId: null, depth: 0, createdBy: null, createdAt: 0, updatedAt: 0, finishedAt: null, deadlineAt: null });
    const copy = store.getRun("r")!;
    (copy.input as { a: number }).a = 99;
    expect((store.getRun("r")!.input as { a: number }).a).toBe(1);
  });
});
