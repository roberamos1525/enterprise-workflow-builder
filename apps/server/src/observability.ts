import type { EngineLogger } from "@ewb/engine";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger extends EngineLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Structured JSON-lines logger writing to stdout (info/debug) and stderr (warn/error). */
export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}, sink?: (line: string) => void): Logger {
  const threshold = LEVELS[level];
  const write = (lvl: Exclude<LogLevel, "silent">, message: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: message, ...bindings, ...data });
    if (sink) sink(line);
    else if (lvl === "warn" || lvl === "error") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
    .join(",");
}

class Counter {
  readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ""} ${v}`);
    return lines;
  }
}

class Histogram {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {}
  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count++;
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const prefix = k ? `${k},` : "";
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${prefix}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ""} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ""} ${s.count}`);
    }
    return lines;
  }
}

/** Minimal Prometheus-compatible metrics registry. */
export class Metrics {
  readonly httpRequests = new Counter("ewb_http_requests_total", "HTTP requests by method, route and status");
  readonly httpDuration = new Histogram("ewb_http_request_duration_ms", "HTTP request duration in ms", [5, 25, 100, 250, 1000, 5000]);
  readonly runsStarted = new Counter("ewb_runs_started_total", "Workflow runs started by trigger type");
  readonly runsFinished = new Counter("ewb_runs_finished_total", "Workflow runs finished by status");
  readonly stepsFinished = new Counter("ewb_steps_finished_total", "Steps finished by node type and status");
  readonly webhookRejected = new Counter("ewb_webhook_rejected_total", "Webhook calls rejected by reason");

  render(): string {
    return [
      ...this.httpRequests.render(),
      ...this.httpDuration.render(),
      ...this.runsStarted.render(),
      ...this.runsFinished.render(),
      ...this.stepsFinished.render(),
      ...this.webhookRejected.render(),
    ].join("\n") + "\n";
  }
}
