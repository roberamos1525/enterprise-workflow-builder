import { describe, expect, it } from "vitest";
import { describeCron, isValidCron, nextFireTime, nextFireTimes, parseCron } from "./cron.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const next = (expr: string, after: string) => iso(nextFireTime(expr, at(after)));

describe("parseCron", () => {
  it("parses wildcards, lists, ranges and steps", () => {
    const s = parseCron("*/15 9-17 1,15 * MON-FRI");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.daysOfMonth]).toEqual([1, 15]);
    expect(s.months.size).toBe(12);
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(s.domRestricted).toBe(true);
    expect(s.dowRestricted).toBe(true);
  });

  it("supports range steps, start/step and names case-insensitively", () => {
    expect([...parseCron("0-30/10 * * * *").minutes]).toEqual([0, 10, 20, 30]);
    expect([...parseCron("50/5 * * * *").minutes]).toEqual([50, 55]);
    expect([...parseCron("0 0 * jan,Mar,DEC *").months]).toEqual([1, 3, 12]);
    expect([...parseCron("0 0 * * sun").daysOfWeek]).toEqual([0]);
  });

  it("treats 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 5-7").daysOfWeek].sort()).toEqual([0, 5, 6]);
  });

  it("expands macros", () => {
    expect(parseCron("@daily").minutes.has(0)).toBe(true);
    expect([...parseCron("@hourly").hours].length).toBe(24);
    expect([...parseCron("@weekly").daysOfWeek]).toEqual([0]);
    expect([...parseCron("@yearly").months]).toEqual([1]);
    expect(parseCron("@monthly").daysOfMonth.has(1)).toBe(true);
  });

  it("treats */1 as unrestricted but */2 as restricted", () => {
    expect(parseCron("0 0 */1 * 1").domRestricted).toBe(false);
    expect(parseCron("0 0 */2 * 1").domRestricted).toBe(true);
  });

  it.each([
    ["* * * *", /5 fields/],
    ["60 * * * *", /out of range/],
    ["* 24 * * *", /out of range/],
    ["* * 0 * *", /out of range/],
    ["* * * 13 *", /out of range/],
    ["* * * * 8", /out of range/],
    ["5-1 * * * *", /reversed/],
    ["*/0 * * * *", /invalid step/],
    ["1,,2 * * * *", /empty list/],
    ["a * * * *", /invalid minute/],
    ["1-2-3 * * * *", /invalid range/],
    ["*/2/3 * * * *", /invalid step syntax/],
    ["*/99 * * * *", /too large/],
  ])("rejects %s", (expr, message) => {
    expect(() => parseCron(expr)).toThrow(message);
    expect(isValidCron(expr)).toBe(false);
  });
});

describe("nextFireTime", () => {
  it("returns the next minute strictly after the reference time", () => {
    expect(next("* * * * *", "2026-03-10T10:15:00Z")).toBe("2026-03-10T10:16:00.000Z");
    expect(next("* * * * *", "2026-03-10T10:15:59.999Z")).toBe("2026-03-10T10:16:00.000Z");
  });

  it("finds the next match within the same hour/day", () => {
    expect(next("*/15 * * * *", "2026-03-10T10:16:00Z")).toBe("2026-03-10T10:30:00.000Z");
    expect(next("30 9 * * *", "2026-03-10T08:00:00Z")).toBe("2026-03-10T09:30:00.000Z");
  });

  it("rolls over day, month and year boundaries", () => {
    expect(next("0 0 * * *", "2026-03-31T23:59:00Z")).toBe("2026-04-01T00:00:00.000Z");
    expect(next("0 0 1 * *", "2026-12-15T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("59 23 31 12 *", "2026-12-31T23:59:00Z")).toBe("2027-12-31T23:59:00.000Z");
    expect(next("0 12 * FEB *", "2026-03-01T00:00:00Z")).toBe("2027-02-01T12:00:00.000Z");
  });

  it("skips months that lack the requested day", () => {
    expect(next("0 0 31 * *", "2026-04-01T00:00:00Z")).toBe("2026-05-31T00:00:00.000Z");
    expect(next("0 0 30 * *", "2026-01-31T00:00:00Z")).toBe("2026-03-30T00:00:00.000Z");
  });

  it("handles leap days", () => {
    expect(next("0 0 29 2 *", "2026-01-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 0 29 2 *", "2028-02-29T00:00:00Z")).toBe("2032-02-29T00:00:00.000Z");
  });

  it("returns null for impossible dates", () => {
    expect(nextFireTime("0 0 30 2 *", at("2026-01-01T00:00:00Z"))).toBeNull();
    expect(nextFireTime("0 0 31 4,6,9,11 *", at("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("matches weekdays", () => {
    // 2026-03-13 is a Friday
    expect(next("0 9 * * MON-FRI", "2026-03-13T10:00:00Z")).toBe("2026-03-16T09:00:00.000Z");
    expect(next("0 9 * * 0", "2026-03-13T10:00:00Z")).toBe("2026-03-15T09:00:00.000Z");
  });

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // 1st of the month OR any Monday; 2026-03-02 is a Monday
    expect(next("0 0 1 * MON", "2026-02-27T00:00:00Z")).toBe("2026-03-01T00:00:00.000Z");
    expect(next("0 0 1 * MON", "2026-03-01T00:00:00Z")).toBe("2026-03-02T00:00:00.000Z");
    // With dow wildcard only dom applies
    expect(next("0 0 13 * *", "2026-03-01T00:00:00Z")).toBe("2026-03-13T00:00:00.000Z");
  });

  it("produces a sequence across a year boundary", () => {
    const times = nextFireTimes("0 */12 * * *", at("2026-12-31T00:00:00Z"), 4).map(iso);
    expect(times).toEqual([
      "2026-12-31T12:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
      "2027-01-01T12:00:00.000Z",
      "2027-01-02T00:00:00.000Z",
    ]);
  });

  it("agrees with brute-force minute scanning", () => {
    const exprs = ["*/7 3-5 */3 * *", "15 10 1-7 * TUE", "0 0 L * *".replace("L", "28-31"), "5,35 */6 * 2-11 SAT,SUN"];
    for (const expr of exprs) {
      const schedule = parseCron(expr);
      let cursor = at("2026-01-30T22:13:00Z");
      for (let i = 0; i < 20; i++) {
        const expected = bruteForce(schedule, cursor);
        const actual = nextFireTime(schedule, cursor);
        expect(iso(actual)).toBe(iso(expected));
        if (actual === null) break;
        cursor = actual;
      }
    }
  });
});

function bruteForce(schedule: ReturnType<typeof parseCron>, after: number): number | null {
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 2 * 366 * 24 * 60; i++, t += 60_000) {
    const d = new Date(t);
    const dom = schedule.daysOfMonth.has(d.getUTCDate());
    const dow = schedule.daysOfWeek.has(d.getUTCDay());
    const dayOk =
      schedule.domRestricted && schedule.dowRestricted ? dom || dow : schedule.domRestricted ? dom : schedule.dowRestricted ? dow : true;
    if (
      schedule.minutes.has(d.getUTCMinutes()) &&
      schedule.hours.has(d.getUTCHours()) &&
      schedule.months.has(d.getUTCMonth() + 1) &&
      dayOk
    ) {
      return t;
    }
  }
  return null;
}

describe("describeCron", () => {
  it("produces readable summaries", () => {
    expect(describeCron("30 9 * * 1-5")).toBe("at 09:30 UTC on Mon,Tue,Wed,Thu,Fri");
    expect(describeCron("* * * * *")).toBe("every minute");
    expect(describeCron("0 */6 1 * *")).toBe("at minute 0 past hour 0,6,12,18 on day-of-month 1");
  });
});
