import type { Clock, TimerHandle } from "../runtime/clock.js";
import { nextFireTime, parseCron, type CronSchedule } from "./cron.js";

export interface ScheduleEntry {
  id: string;
  workflowId: string;
  cron: string;
  enabled: boolean;
  /** Persisted next fire time; null means "compute from now". */
  nextFireAt: number | null;
  lastFiredAt: number | null;
}

export interface ScheduleStore {
  listSchedules(): ScheduleEntry[];
  updateSchedule(id: string, patch: { nextFireAt: number | null; lastFiredAt?: number | null }): void;
}

/** What to do with fire times that passed while the process was down. */
export type MisfirePolicy = "skip" | "fire_once";

export interface SchedulerOptions {
  clock: Clock;
  store: ScheduleStore;
  onFire: (entry: ScheduleEntry, scheduledFor: number) => void | Promise<void>;
  misfirePolicy?: MisfirePolicy;
  /** Fire times older than this (relative to now) are treated as misfires. */
  misfireGraceMs?: number;
  onError?: (error: unknown, entry: ScheduleEntry) => void;
}

/**
 * Persistent cron scheduler. Next fire times are stored so a restart can
 * detect misfires; a single clock timer is armed for the earliest due entry.
 */
export class CronScheduler {
  private timer: TimerHandle | undefined;
  private running = false;
  private readonly parsed = new Map<string, CronSchedule>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly policy: MisfirePolicy;
  private readonly graceMs: number;

  constructor(private readonly options: SchedulerOptions) {
    this.policy = options.misfirePolicy ?? "fire_once";
    this.graceMs = options.misfireGraceMs ?? 60_000;
  }

  start(): void {
    this.running = true;
    this.refresh();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** Waits for fire callbacks that are still running. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private schedule(cron: string): CronSchedule {
    let s = this.parsed.get(cron);
    if (!s) {
      s = parseCron(cron);
      this.parsed.set(cron, s);
    }
    return s;
  }

  /** Re-reads the store (call after schedules are added/changed) and re-arms the timer. */
  refresh(): void {
    if (!this.running) return;
    const now = this.options.clock.now();
    for (const entry of this.options.store.listSchedules()) {
      if (!entry.enabled) continue;
      if (entry.nextFireAt === null) {
        this.options.store.updateSchedule(entry.id, { nextFireAt: this.safeNext(entry, now) });
      } else if (entry.nextFireAt < now - this.graceMs) {
        // Missed while offline.
        if (this.policy === "fire_once") this.fire(entry, entry.nextFireAt);
        this.options.store.updateSchedule(entry.id, {
          nextFireAt: this.safeNext(entry, now),
          ...(this.policy === "fire_once" ? { lastFiredAt: now } : {}),
        });
      }
    }
    this.arm();
  }

  private safeNext(entry: ScheduleEntry, after: number): number | null {
    try {
      return nextFireTime(this.schedule(entry.cron), after);
    } catch (err) {
      this.options.onError?.(err, entry);
      return null;
    }
  }

  private arm(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (!this.running) return;
    let earliest: number | undefined;
    for (const entry of this.options.store.listSchedules()) {
      if (entry.enabled && entry.nextFireAt !== null && (earliest === undefined || entry.nextFireAt < earliest)) {
        earliest = entry.nextFireAt;
      }
    }
    if (earliest !== undefined) this.timer = this.options.clock.setTimer(earliest, () => this.tick());
  }

  /** Fires every entry whose time has come, advances them, re-arms. */
  tick(): void {
    if (!this.running) return;
    const now = this.options.clock.now();
    for (const entry of this.options.store.listSchedules()) {
      if (!entry.enabled || entry.nextFireAt === null || entry.nextFireAt > now) continue;
      const scheduledFor = entry.nextFireAt;
      this.options.store.updateSchedule(entry.id, {
        nextFireAt: this.safeNext(entry, Math.max(now, scheduledFor)),
        lastFiredAt: now,
      });
      this.fire(entry, scheduledFor);
    }
    this.arm();
  }

  /** Invokes the callback synchronously (so runs start at the scheduled instant); async results are tracked. */
  private fire(entry: ScheduleEntry, scheduledFor: number): void {
    let result: void | Promise<void>;
    try {
      result = this.options.onFire(entry, scheduledFor);
    } catch (err) {
      this.options.onError?.(err, entry);
      return;
    }
    if (result instanceof Promise) {
      const p: Promise<void> = result
        .catch((err: unknown) => this.options.onError?.(err, entry))
        .finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }
}
