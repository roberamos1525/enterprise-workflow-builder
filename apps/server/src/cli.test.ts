import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, sampleWorkflows } from "./cli.js";
import { Database } from "./db/database.js";

let output: string[];
let dir: string;
const env = { ...process.env };

beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  dir = mkdtempSync(join(tmpdir(), "ewb-cli-"));
  process.env["DATABASE_PATH"] = join(dir, "cli.db");
  delete process.env["EWB_CONFIG"];
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...env };
});

const text = () => output.join("");

describe("cli", () => {
  it("prints usage for missing or unknown commands", () => {
    expect(runCli([])).toBe(1);
    expect(text()).toContain("usage: ewb");
    expect(runCli(["help"])).toBe(0);
  });

  it("migrates and reports an up-to-date database", () => {
    expect(runCli(["migrate"])).toBe(0);
    expect(runCli(["migrate"])).toBe(0);
    expect(text()).toContain("database is up to date");
  });

  it("creates users with validation", () => {
    expect(runCli(["create-user", "--email", "ops@x.dev", "--role", "operator", "--password", "longpassword"])).toBe(0);
    expect(text()).toMatch(/created operator ops@x\.dev/);
    expect(() => runCli(["create-user", "--email", "a@x", "--role", "god", "--password", "longpassword"])).toThrow(/--role/);
    expect(() => runCli(["create-user", "--email", "b@x", "--role", "viewer", "--password", "short"])).toThrow(/8 characters/);
  });

  it("seeds demo users and valid sample workflows exactly once", () => {
    expect(runCli(["seed", "--password", "demo-password"])).toBe(0);
    const db = new Database(process.env["DATABASE_PATH"] as string);
    expect(db.all("SELECT id FROM users")).toHaveLength(4);
    expect(db.all("SELECT id FROM workflows")).toHaveLength(sampleWorkflows().length);
    expect(db.all("SELECT * FROM workflow_acl")).toHaveLength(sampleWorkflows().length * 3);
    db.close();
    expect(runCli(["seed"])).toBe(0);
    expect(text()).toContain("seed skipped");
  });

  it("validates definition files", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(sampleWorkflows()[0]?.definition));
    expect(runCli(["validate", good])).toBe(0);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ schemaVersion: 1, nodes: [{ id: "x", type: "action.transform", config: {} }], edges: [] }));
    expect(runCli(["validate", bad])).toBe(1);
    expect(text()).toMatch(/no_trigger/);
    expect(text()).toMatch(/missing_config\s+x\.expression/);
  });

  it("previews cron schedules", () => {
    expect(runCli(["cron", "0 9 * * MON-FRI", "--count", "2"])).toBe(0);
    const lines = text().trim().split("\n");
    expect(lines[0]).toBe("at 09:00 UTC on Mon,Tue,Wed,Thu,Fri");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/T09:00:00\.000Z$/);
  });
});
