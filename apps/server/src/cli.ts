#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { describeCron, nextFireTimes, validateDefinition, type WorkflowDefinition } from "@ewb/engine";
import { ROLES, type AuthUser, type Role } from "./auth.js";
import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { UserService } from "./services/users.js";
import { WorkflowService } from "./services/workflows.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

const USAGE = `usage: ewb <command> [options]

commands:
  migrate                                   apply database migrations
  create-user --email E --name N --role R --password P
  seed [--password P]                       create demo users and sample workflows (empty database only)
  validate <definition.json>                validate a workflow definition file
  cron "<expr>" [--count N]                 show the next fire times of a cron expression (UTC)`;

/** Sample definitions created by `seed`; they exercise every trigger family. */
export function sampleWorkflows(): { name: string; description: string; definition: WorkflowDefinition }[] {
  const pos = (x: number, y: number) => ({ x, y });
  return [
    {
      name: "Purchase order approval",
      description: "Webhook-triggered order intake: large orders need manager approval, all orders are logged in parallel.",
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "hook", type: "trigger.webhook", name: "Order received", position: pos(40, 200), config: { requiredFields: ["orderId", "amount"] } },
          { id: "large", type: "flow.branch", name: "Amount > 1000?", position: pos(260, 200), config: { condition: "trigger.amount > 1000" } },
          { id: "record", type: "action.setVariable", name: "Record order", position: pos(500, 60), config: { name: "orderId", expression: "trigger.orderId" } },
          { id: "summary", type: "action.transform", name: "Build summary", position: pos(500, 180), config: { expression: "{ id: trigger.orderId, total: trigger.amount, lines: len(trigger.items ?? []) }" } },
          { id: "approve", type: "action.approval", name: "Manager approval", position: pos(500, 320), config: { title: "Approve order {{ trigger.orderId }} ({{ trigger.amount }})", assignees: ["role:operator"], timeoutMs: 86_400_000, escalateTo: ["role:admin"], escalationTimeoutMs: 86_400_000 } },
          { id: "notify", type: "action.notify", name: "Notify requester", position: pos(760, 320), config: { channel: "inApp", recipients: ["role:editor"], title: "Order {{ trigger.orderId }}: {{ input.decision }}", message: "Decision by {{ input.by ?? 'system' }}" } },
          { id: "done", type: "flow.join", name: "Join", position: pos(980, 200), config: { mode: "all" } },
        ],
        edges: [
          { id: "e1", source: { node: "hook", port: "out" }, target: { node: "large", port: "in" } },
          { id: "e2", source: { node: "large", port: "true" }, target: { node: "record", port: "in" } },
          { id: "e3", source: { node: "large", port: "true" }, target: { node: "summary", port: "in" } },
          { id: "e4", source: { node: "large", port: "true" }, target: { node: "approve", port: "in" } },
          { id: "e5", source: { node: "approve", port: "approved" }, target: { node: "notify", port: "in" } },
          { id: "e6", source: { node: "approve", port: "rejected" }, target: { node: "notify", port: "in" } },
          { id: "e7", source: { node: "record", port: "out" }, target: { node: "done", port: "in" } },
          { id: "e8", source: { node: "summary", port: "out" }, target: { node: "done", port: "in" } },
          { id: "e9", source: { node: "notify", port: "out" }, target: { node: "done", port: "in" } },
        ],
      },
    },
    {
      name: "Hourly heartbeat",
      description: "Scheduled every hour; records the scheduled time and notifies admins.",
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "cron", type: "trigger.schedule", name: "Every hour", position: pos(40, 120), config: { cron: "0 * * * *", payload: { source: "scheduler" } } },
          { id: "stamp", type: "action.setVariable", name: "Stamp", position: pos(280, 120), config: { name: "firedAt", expression: "trigger.scheduledFor" } },
          { id: "tell", type: "action.notify", name: "Notify admins", position: pos(520, 120), config: { channel: "inApp", recipients: ["role:admin"], title: "Heartbeat", message: "Fired for {{ vars.firedAt }}" } },
        ],
        edges: [
          { id: "e1", source: { node: "cron", port: "out" }, target: { node: "stamp", port: "in" } },
          { id: "e2", source: { node: "stamp", port: "out" }, target: { node: "tell", port: "in" } },
        ],
      },
    },
    {
      name: "Customer signup follow-up",
      description: "Event-triggered on customer.signup for paid plans; waits, then notifies the sales role.",
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "evt", type: "trigger.event", name: "customer.signup", position: pos(40, 120), config: { eventType: "customer.signup", filter: "event.payload.plan != 'free'" } },
          { id: "wait", type: "action.delay", name: "Wait 1 minute", position: pos(280, 120), config: { mode: "duration", durationMs: 60_000 } },
          { id: "tell", type: "action.notify", name: "Notify sales", position: pos(520, 120), config: { channel: "inApp", recipients: ["role:operator"], title: "New {{ trigger.payload.plan }} signup", message: "{{ trigger.payload.email }}" } },
        ],
        edges: [
          { id: "e1", source: { node: "evt", port: "out" }, target: { node: "wait", port: "in" } },
          { id: "e2", source: { node: "wait", port: "out" }, target: { node: "tell", port: "in" } },
        ],
      },
    },
  ];
}

export function runCli(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    out(USAGE);
    return command ? 0 : 1;
  }
  if (command === "validate") {
    const file = rest[0];
    if (!file) throw new Error("validate requires a file path");
    const result = validateDefinition(JSON.parse(readFileSync(file, "utf8")));
    for (const i of result.issues) out(`${i.severity.padEnd(7)} ${i.code.padEnd(20)} ${i.nodeId ?? i.edgeId ?? "-"}${i.field ? `.${i.field}` : ""}: ${i.message}`);
    out(result.valid ? "definition is valid" : "definition is INVALID");
    return result.valid ? 0 : 1;
  }
  if (command === "cron") {
    const { values, positionals } = parseArgs({ args: rest, options: { count: { type: "string", default: "5" } }, allowPositionals: true });
    const expr = positionals[0];
    if (!expr) throw new Error("cron requires an expression");
    out(describeCron(expr));
    for (const t of nextFireTimes(expr, Date.now(), Number(values.count))) out(new Date(t).toISOString());
    return 0;
  }

  const config = loadConfig();
  const db = new Database(config.databasePath);
  try {
    const applied = db.migrate();
    const users = new UserService(db, Date.now);
    switch (command) {
      case "migrate":
        out(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
        return 0;
      case "create-user": {
        const { values } = parseArgs({ args: rest, options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" }, password: { type: "string" } } });
        if (!values.email || !values.password || !values.role || !ROLES.includes(values.role as Role)) {
          throw new Error(`create-user requires --email, --password and --role (${ROLES.join("|")})`);
        }
        if (values.password.length < 8) throw new Error("password must be at least 8 characters");
        const user = users.create({ email: values.email, name: values.name ?? values.email, role: values.role as Role, password: values.password });
        out(`created ${user.role} ${user.email} (${user.id})`);
        return 0;
      }
      case "seed": {
        const { values } = parseArgs({ args: rest, options: { password: { type: "string", default: "Passw0rd!demo" } } });
        if (users.count() > 0) {
          out("database already has users; seed skipped");
          return 0;
        }
        const created = ROLES.map((role) => users.create({ email: `${role}@example.com`, name: `Demo ${role}`, role, password: values.password }));
        const editor = created.find((u) => u.role === "editor") as AuthUser;
        const workflows = new WorkflowService(db, Date.now);
        for (const sample of sampleWorkflows()) {
          const wf = workflows.create(editor, sample);
          workflows.setAcl(editor, wf.id, created.filter((u) => u.role !== "admin").map((u) => ({ userId: u.id, role: u.role as "editor" | "operator" | "viewer" })));
          out(`workflow ${wf.id}: ${sample.name}`);
        }
        out(`users: ${created.map((u) => u.email).join(", ")} (password: ${values.password})`);
        return 0;
      }
      default:
        out(USAGE);
        return 1;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1])) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
