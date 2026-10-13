export interface TimerHandle {
  cancel(): void;
}

/**
 * Time source plus absolute-time timers. Everything time-dependent in the
 * engine (delays, retries, timeouts, schedules, approvals) goes through this
 * interface so tests can drive time deterministically.
 */
export interface Clock {
  now(): number;
  /** Calls `callback` once the clock reaches `at` (epoch ms). Past times fire asap. */
  setTimer(at: number, callback: () => void): TimerHandle;
}

/** setTimeout cannot exceed a signed 32-bit delay; longer waits are chained. */
const MAX_DELAY = 2_147_483_647;

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimer(at: number, callback: () => void): TimerHandle {
    let handle: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const arm = (): void => {
      const delay = Math.max(0, at - Date.now());
      handle = setTimeout(
        () => {
          if (cancelled) return;
          if (Date.now() < at) arm();
          else callback();
        },
        Math.min(delay, MAX_DELAY),
      );
      // Timers must not keep a CLI process alive on their own.
      (handle as { unref?: () => void }).unref?.();
    };
    arm();
    return {
      cancel() {
        cancelled = true;
        if (handle !== undefined) clearTimeout(handle);
      },
    };
  }
}

interface PendingTimer {
  id: number;
  at: number;
  callback: () => void;
}

/** Fully manual clock for deterministic tests: time only moves on `advance`/`set`. */
export class ManualClock implements Clock {
  private current: number;
  private timers: PendingTimer[] = [];
  private nextId = 1;

  constructor(start: number | string = Date.UTC(2026, 0, 1)) {
    this.current = typeof start === "string" ? Date.parse(start) : start;
  }

  now(): number {
    return this.current;
  }

  setTimer(at: number, callback: () => void): TimerHandle {
    const timer: PendingTimer = { id: this.nextId++, at, callback };
    this.timers.push(timer);
    return {
      cancel: () => {
        this.timers = this.timers.filter((t) => t.id !== timer.id);
      },
    };
  }

  /** Number of armed timers (handy for asserting cleanup). */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Earliest armed timer time, if any. */
  get nextTimerAt(): number | undefined {
    return this.timers.reduce<number | undefined>((min, t) => (min === undefined || t.at < min ? t.at : min), undefined);
  }

  /**
   * Moves time forward by `ms`, firing due timers in chronological order.
   * Timers armed by callbacks during the advance also fire if they are due.
   */
  advance(ms: number): void {
    this.set(this.current + ms);
  }

  set(time: number): void {
    if (time < this.current) throw new Error("ManualClock cannot go backwards");
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= time)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.current = Math.max(this.current, due.at);
      due.callback();
    }
    this.current = time;
  }
}
