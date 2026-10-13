/**
 * Standard 5-field cron expressions (minute hour day-of-month month day-of-week)
 * evaluated in UTC. Supports `*`, lists, ranges, steps, month/weekday names,
 * `7` as Sunday and the common `@hourly`-style macros. When both day-of-month
 * and day-of-week are restricted, a day matches if EITHER matches (Vixie cron).
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  {
    name: "month",
    min: 1,
    max: 12,
    names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  },
  { name: "day-of-week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export interface CronSchedule {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** False when the field was `*` (or `*` with step 1), which affects day matching. */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

function parseValue(token: string, field: FieldDef): number {
  const upper = token.toUpperCase();
  const named = field.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (field.name === "month" ? 1 : 0);
  if (!/^\d+$/.test(token)) throw new CronError(`invalid ${field.name} value '${token}'`);
  const value = Number(token);
  if (value < field.min || value > field.max) {
    throw new CronError(`${field.name} value ${value} out of range ${field.min}-${field.max}`);
  }
  return value;
}

function parseField(text: string, field: FieldDef): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`empty list item in ${field.name}`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined || rangePart === undefined) throw new CronError(`invalid step syntax '${part}'`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronError(`invalid step '${stepPart}'`);
      step = Number(stepPart);
      if (step > field.max) throw new CronError(`step ${step} too large for ${field.name}`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = field.min;
      end = field.max;
      if (step !== 1) restricted = true;
    } else {
      restricted = true;
      const bounds = rangePart.split("-");
      if (bounds.length > 2 || bounds.some((p) => p === "")) throw new CronError(`invalid range '${rangePart}'`);
      start = parseValue(bounds[0] ?? "", field);
      // `a/n` means "from a to the field maximum, every n".
      end = bounds.length === 2 ? parseValue(bounds[1] ?? "", field) : stepPart !== undefined ? field.max : start;
      if (end < start) throw new CronError(`range ${start}-${end} is reversed in ${field.name}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, restricted };
}

export function parseCron(expression: string): CronSchedule {
  const source = expression.trim();
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const parsed = parts.map((p, i) => parseField(p, FIELDS[i] as FieldDef));
  const [minute, hour, dom, month, dow] = parsed as [
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
  ];
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return {
    source,
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const domOk = schedule.daysOfMonth.has(date.getUTCDate());
  const dowOk = schedule.daysOfWeek.has(date.getUTCDay());
  if (schedule.domRestricted && schedule.dowRestricted) return domOk || dowOk;
  if (schedule.domRestricted) return domOk;
  if (schedule.dowRestricted) return dowOk;
  return true;
}

/** Searching beyond this horizon means the schedule can never fire (e.g. `0 0 30 2 *`). */
const SEARCH_YEARS = 8;

/**
 * Returns the first fire time strictly after `after` (epoch ms), or null when
 * the expression never matches within the search horizon.
 */
export function nextFireTime(scheduleOrExpr: CronSchedule | string, after: number): number | null {
  const s = typeof scheduleOrExpr === "string" ? parseCron(scheduleOrExpr) : scheduleOrExpr;
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limitYear = d.getUTCFullYear() + SEARCH_YEARS;
  while (d.getUTCFullYear() <= limitYear) {
    if (!s.months.has(d.getUTCMonth() + 1)) {
      // Jump to the first day of the next month (Date handles the year wrap).
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}

/** Convenience for previews: the next `count` fire times after `after`. */
export function nextFireTimes(expression: string, after: number, count: number): number[] {
  const schedule = parseCron(expression);
  const out: number[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextFireTime(schedule, cursor);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Short English description used by the editor, e.g. "at 09:30 on Mon-Fri". */
export function describeCron(expression: string): string {
  const s = parseCron(expression);
  const fmt = (set: ReadonlySet<number>, max: number, min = 0): string | null =>
    set.size === max - min + 1 ? null : [...set].sort((a, b) => a - b).join(",");
  const minutes = fmt(s.minutes, 59);
  const hours = fmt(s.hours, 23);
  const pieces: string[] = [];
  if (minutes !== null && hours !== null && s.minutes.size === 1 && s.hours.size === 1) {
    const [h] = s.hours;
    const [m] = s.minutes;
    pieces.push(`at ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`);
  } else {
    pieces.push(minutes === null ? "every minute" : `at minute ${minutes}`);
    if (hours !== null) pieces.push(`past hour ${hours}`);
  }
  if (s.domRestricted) pieces.push(`on day-of-month ${[...s.daysOfMonth].sort((a, b) => a - b).join(",")}`);
  if (s.dowRestricted) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    pieces.push(`${s.domRestricted ? "or" : "on"} ${[...s.daysOfWeek].sort((a, b) => a - b).map((d) => names[d]).join(",")}`);
  }
  const months = fmt(s.months, 12, 1);
  if (months !== null) pieces.push(`in month ${months}`);
  return pieces.join(" ");
}
