import { describe, expect, it } from "vitest";
import { ManualClock } from "../runtime/clock.js";
import { CronScheduler, type ScheduleEntry, type ScheduleStore } from "./scheduler.js";

class MemoryScheduleStore implements ScheduleStore {
  constructor(public entries: ScheduleEntry[]) {}
  listSchedules(): ScheduleEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
  updateSchedule(id: string, patch: { nextFireAt: number | null; lastFiredAt?: number | null }): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error("missing");
    entry.nextFireAt = patch.nextFireAt;
    if (patch.lastFiredAt !== undefined) entry.lastFiredAt = patch.lastFiredAt;
  }
}

const entry = (id: string, cron: string, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  id,
  workflowId: `wf-${id}`,
  cron,
  enabled: true,
  nextFireAt: null,
  lastFiredAt: null,
  ...extra,
});

function setup(entries: ScheduleEntry[], start = "2026-05-01T00:00:30Z", policy: "skip" | "fire_once" = "fire_once") {
  const clock = new ManualClock(start);
  const store = new MemoryScheduleStore(entries);
  const fired: { id: string; at: string; scheduledFor: string }[] = [];
  const errors: unknown[] = [];
  const scheduler = new CronScheduler({
    clock,
    store,
    misfirePolicy: policy,
    onFire: (e, scheduledFor) => {
      fired.push({ id: e.id, at: new Date(clock.now()).toISOString(), scheduledFor: new Date(scheduledFor).toISOString() });
    },
    onError: (err) => errors.push(err),
  });
  return { clock, store, fired, errors, scheduler };
}

describe("CronScheduler", () => {
  it("computes initial fire times and fires on schedule with a fake clock", async () => {
    const { clock, store, fired, scheduler } = setup([entry("a", "*/5 * * * *"), entry("b", "0 * * * *")]);
    scheduler.start();
    expect(new Date(store.entries[0]!.nextFireAt!).toISOString()).toBe("2026-05-01T00:05:00.000Z");
    expect(clock.pendingTimers).toBe(1);
    clock.advance(60 * 60_000);
    await scheduler.idle();
    expect(fired.filter((f) => f.id === "a")).toHaveLength(12);
    expect(fired.filter((f) => f.id === "b").map((f) => f.at)).toEqual(["2026-05-01T01:00:00.000Z"]);
    expect(fired.every((f) => f.at === f.scheduledFor)).toBe(true);
    scheduler.stop();
    expect(clock.pendingTimers).toBe(0);
  });

  it("ignores disabled entries", async () => {
    const { clock, fired, scheduler } = setup([entry("a", "* * * * *", { enabled: false })]);
    scheduler.start();
    clock.advance(10 * 60_000);
    await scheduler.idle();
    expect(fired).toHaveLength(0);
  });

  it("fires a missed schedule once after downtime with fire_once", async () => {
    const missed = Date.parse("2026-05-01T00:00:00Z");
    const { fired, store, scheduler } = setup([entry("a", "0 * * * *", { nextFireAt: missed })], "2026-05-01T05:30:00Z");
    scheduler.start();
    await scheduler.idle();
    expect(fired).toEqual([{ id: "a", at: "2026-05-01T05:30:00.000Z", scheduledFor: "2026-05-01T00:00:00.000Z" }]);
    expect(new Date(store.entries[0]!.nextFireAt!).toISOString()).toBe("2026-05-01T06:00:00.000Z");
  });

  it("skips missed schedules with the skip policy", async () => {
    const missed = Date.parse("2026-05-01T00:00:00Z");
    const { fired, store, scheduler } = setup([entry("a", "0 * * * *", { nextFireAt: missed })], "2026-05-01T05:30:00Z", "skip");
    scheduler.start();
    await scheduler.idle();
    expect(fired).toHaveLength(0);
    expect(new Date(store.entries[0]!.nextFireAt!).toISOString()).toBe("2026-05-01T06:00:00.000Z");
  });

  it("picks up new schedules on refresh", async () => {
    const { clock, store, fired, scheduler } = setup([]);
    scheduler.start();
    expect(clock.pendingTimers).toBe(0);
    store.entries.push(entry("late", "1 0 * * *"));
    scheduler.refresh();
    clock.advance(60_000);
    await scheduler.idle();
    expect(fired.map((f) => f.id)).toEqual(["late"]);
  });

  it("reports callback errors without stopping the schedule", async () => {
    const clock = new ManualClock("2026-05-01T00:00:00Z");
    const store = new MemoryScheduleStore([entry("a", "* * * * *")]);
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = new CronScheduler({
      clock,
      store,
      onFire: () => {
        calls++;
        throw new Error("boom");
      },
      onError: (err) => errors.push(err),
    });
    scheduler.start();
    clock.advance(3 * 60_000);
    await scheduler.idle();
    expect(calls).toBe(3);
    expect(errors).toHaveLength(3);
  });

  it("disables entries whose cron is invalid instead of crashing", () => {
    const { store, errors, scheduler } = setup([entry("bad", "not a cron")]);
    scheduler.start();
    expect(store.entries[0]!.nextFireAt).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
