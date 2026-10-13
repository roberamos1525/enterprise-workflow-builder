import { describe, expect, it } from "vitest";
import { branch, definition, edge, join, manual, node, transform } from "../__tests__/builders.js";
import { defaultConfig, getNodeType, NODE_TYPES, portCompatible } from "./catalog.js";
import { diffDefinitions, diffValues } from "./diff.js";
import { ancestors, parseDefinition, topologicalOrder, validateDefinition } from "./validate.js";

const codes = (input: unknown) => validateDefinition(input).issues.map((i) => i.code);
const errorsFor = (input: unknown, code: string) => validateDefinition(input).issues.filter((i) => i.code === code);

const valid = () =>
  definition(
    [manual(), branch("check", "trigger.amount > 100"), transform("big", "'big'"), transform("small", "'small'"), join("merge")],
    [edge("start", "check"), edge("check.true", "big"), edge("check.false", "small"), edge("big", "merge"), edge("small", "merge")],
  );

describe("catalog", () => {
  it("has unique node types with consistent ports", () => {
    const types = NODE_TYPES.map((t) => t.type);
    expect(new Set(types).size).toBe(types.length);
    for (const spec of NODE_TYPES) {
      if (spec.category === "trigger") expect(spec.inputs).toHaveLength(0);
      else expect(spec.inputs.map((p) => p.name)).toEqual(["in"]);
    }
  });

  it("produces default config and checks port compatibility", () => {
    expect(defaultConfig("action.http")).toMatchObject({ method: "GET", headers: {}, failOnHttpError: true });
    expect(defaultConfig("nope")).toEqual({});
    expect(portCompatible("error", getNodeType("flow.join")?.inputs[0]?.accepts)).toBe(false);
    expect(portCompatible("error", getNodeType("action.notify")?.inputs[0]?.accepts)).toBe(true);
  });
});

describe("parseDefinition (schema)", () => {
  it("accepts a well-formed definition", () => {
    const result = validateDefinition(valid());
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects non-objects and wrong schema versions", () => {
    expect(parseDefinition(null).issues[0]?.message).toMatch(/must be an object/);
    expect(codes({ schemaVersion: 2, nodes: [], edges: [] })).toContain("schema");
    expect(parseDefinition({ schemaVersion: 1, nodes: {}, edges: [] }).definition).toBeUndefined();
  });

  it("validates node ids, duplicates, config shape and retry policy", () => {
    const input = {
      schemaVersion: 1,
      nodes: [
        { id: "1bad", type: "trigger.manual" },
        { id: "a", type: "trigger.manual", config: {} },
        { id: "a", type: "action.transform", config: { expression: "1" } },
        { id: "b", type: "action.http", config: [] },
        { id: "c", type: "action.http", config: { url: "https://x" }, retry: { maxAttempts: 50, backoffMultiplier: 0 } },
        { id: "d", type: "action.http", config: { url: "https://x" }, timeoutMs: -5 },
      ],
      edges: [{ id: "e1", source: { node: "a" }, target: { node: "c", port: "in" } }],
    };
    const issues = parseDefinition(input).issues;
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/nodes\[0\]\.id must match/);
    expect(messages).toMatch(/duplicate node id 'a'/);
    expect(messages).toMatch(/config must be an object/);
    expect(messages).toMatch(/maxAttempts must be an integer/);
    expect(messages).toMatch(/backoffMultiplier/);
    expect(messages).toMatch(/timeoutMs/);
    expect(messages).toMatch(/edge source\/target/);
  });

  it("enforces size limits", () => {
    const nodes = Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, type: "action.transform", config: { expression: "1" } }));
    expect(codes({ schemaVersion: 1, nodes, edges: [] })).toContain("limit");
    const big = { schemaVersion: 1, nodes: [{ id: "a", type: "action.transform", config: { expression: "x".repeat(70_000) } }], edges: [] };
    expect(codes(big)).toContain("limit");
  });

  it("validates settings and variables", () => {
    expect(codes({ ...valid(), settings: { maxRunDurationMs: 5 } })).toContain("schema");
    expect(codes({ ...valid(), variables: [1] })).toContain("schema");
    expect(parseDefinition({ ...valid(), settings: { maxRunDurationMs: 60_000 } }).definition?.settings).toEqual({ maxRunDurationMs: 60_000 });
  });
});

describe("validateGraph", () => {
  it("requires exactly one trigger", () => {
    expect(codes(definition([transform("a", "1")], []))).toContain("no_trigger");
    expect(codes(definition([manual("t1"), manual("t2")], []))).toContain("multiple_triggers");
  });

  it("detects cycles", () => {
    const def = definition(
      [manual(), transform("a", "1"), transform("b", "2"), transform("c", "3")],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );
    const cycle = errorsFor(def, "cycle");
    expect(cycle[0]?.message).toMatch(/a, b, c/);
    expect(cycle.filter((i) => i.nodeId).map((i) => i.nodeId)).toEqual(["a", "b", "c"]);
    expect(topologicalOrder(def).cycle).toEqual(["a", "b", "c"]);
  });

  it("detects self loops and unreachable nodes", () => {
    const def = definition([manual(), transform("a", "1"), transform("orphan", "2")], [edge("start", "a"), edge("a", "a")]);
    expect(codes(def)).toEqual(expect.arrayContaining(["self_loop", "unreachable"]));
    expect(errorsFor(def, "unreachable").map((i) => i.nodeId)).toEqual(["orphan"]);
  });

  it("checks ports exist and are compatible", () => {
    const def = definition(
      [manual(), node("h", "action.http", { url: "https://example.com" }), join("j"), transform("t", "1")],
      [edge("start", "h"), edge("h.error", "j"), edge("h.success", "j"), edge("j", "t.nope"), edge("start.bad", "t")],
    );
    expect(errorsFor(def, "incompatible_ports")).toHaveLength(1);
    expect(errorsFor(def, "bad_port").map((i) => i.message)).toEqual([
      "'t' has no input port 'nope'",
      "'start' has no output port 'bad'",
    ]);
  });

  it("detects duplicate connections and dangling edges", () => {
    const def = definition([manual(), transform("a", "1")], [edge("start", "a"), edge("start", "a"), edge("start", "ghost")]);
    expect(codes(def)).toEqual(expect.arrayContaining(["duplicate_connection", "dangling_edge"]));
  });

  it("flags unknown node types", () => {
    expect(codes(definition([manual(), node("x", "action.teleport")], [edge("start", "x")]))).toContain("unknown_type");
  });

  it("warns about joins with a single input", () => {
    const def = definition([manual(), join("j")], [edge("start", "j")]);
    const result = validateDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("join_inputs");
  });
});

describe("node config validation", () => {
  it("reports missing required config", () => {
    const def = definition([manual(), node("h", "action.http", {}), node("a", "action.approval", {})], [edge("start", "h"), edge("h.success", "a")]);
    const missing = errorsFor(def, "missing_config").map((i) => `${i.nodeId}.${i.field}`);
    expect(missing).toEqual(["h.url", "a.title", "a.assignees"]);
  });

  it("validates expressions, templates, cron, urls, selects and numbers", () => {
    const def = definition(
      [
        node("s", "trigger.schedule", { cron: "61 * * * *" }),
        node("t", "action.transform", { expression: "1 +" }),
        node("h", "action.http", { url: "https://x/{{ 1 + }}", method: "FETCH", headers: { a: "{{" } }),
        node("n", "action.notify", { channel: "webhook", url: "ftp://x", title: "t", message: "m" }),
        node("d", "action.delay", { durationMs: -1 }),
        node("v", "action.setVariable", { name: "1x", expression: "2" }),
      ],
      [edge("s", "t"), edge("t", "h"), edge("h.success", "n"), edge("n", "d"), edge("d", "v")],
    );
    const fields = errorsFor(def, "invalid_config").map((i) => `${i.nodeId}.${i.field}`);
    expect(fields).toEqual(["s.cron", "t.expression", "h.method", "h.url", "h.headers", "n.url", "d.durationMs", "v.name"]);
  });

  it("only validates fields whose `when` condition holds", () => {
    const def = definition([manual(), node("d", "action.delay", { mode: "until", until: "now() + 1000" })], [edge("start", "d")]);
    expect(validateDefinition(def).valid).toBe(true);
    const missing = definition([manual(), node("d", "action.delay", { mode: "until" })], [edge("start", "d")]);
    expect(errorsFor(missing, "missing_config").map((i) => i.field)).toEqual(["until"]);
  });

  it("requires a timeout when escalation is configured", () => {
    const def = definition(
      [manual(), node("a", "action.approval", { title: "x", assignees: ["role:admin"], escalateTo: ["boss@example.com"] })],
      [edge("start", "a")],
    );
    expect(errorsFor(def, "invalid_config").map((i) => i.field)).toEqual(["timeoutMs"]);
  });

  it("checks expression references against upstream nodes", () => {
    const def = definition(
      [manual(), transform("a", "steps.b.output + nope"), transform("b", "steps.ghost.output"), transform("c", "steps.a.output")],
      [edge("start", "a"), edge("start", "b"), edge("a", "c")],
    );
    const result = validateDefinition(def);
    const messages = result.issues.map((i) => `${i.severity}:${i.nodeId}:${i.message}`);
    expect(messages).toContain("warning:a:steps.b is not upstream of this node and may not have run");
    expect(messages).toContain("error:a:unknown variable 'nope' (use input, trigger, vars, steps, run)");
    expect(messages).toContain("error:b:steps.ghost refers to a node that does not exist");
    expect(messages.filter((m) => m.includes(":c:"))).toEqual([]);
  });

  it("allows `event` only in event trigger filters", () => {
    const ok = definition([node("ev", "trigger.event", { eventType: "order.created", filter: "event.total > 5" }), transform("t", "event")], [edge("ev", "t")]);
    expect(errorsFor(ok, "unknown_reference").map((i) => i.nodeId)).toEqual(["t"]);
  });

  it("computes ancestors", () => {
    expect([...ancestors(valid(), "merge")].sort()).toEqual(["big", "check", "small", "start"]);
  });
});

describe("diffDefinitions", () => {
  it("reports added/removed/changed/moved nodes and edges", () => {
    const before = valid();
    const after = valid();
    after.nodes = after.nodes.filter((n) => n.id !== "small");
    after.edges = after.edges.filter((e) => e.target.node !== "small" && e.source.node !== "small");
    after.nodes.push(transform("extra", "42"));
    after.edges.push(edge("check.false", "extra"));
    const check = after.nodes.find((n) => n.id === "check")!;
    check.config = { condition: "trigger.amount > 500" };
    after.nodes.find((n) => n.id === "big")!.position = { x: 100, y: 5 };
    after.settings = { maxRunDurationMs: 60_000 };

    const diff = diffDefinitions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(["extra"]);
    expect(diff.removedNodes.map((n) => n.id)).toEqual(["small"]);
    expect(diff.changedNodes).toEqual([
      { nodeId: "check", name: "check", type: "flow.branch", changes: [{ path: "config.condition", before: "trigger.amount > 100", after: "trigger.amount > 500" }] },
    ]);
    expect(diff.movedNodes).toEqual(["big"]);
    expect(diff.addedEdges).toHaveLength(1);
    expect(diff.removedEdges).toHaveLength(2);
    expect(diff.settingsChanges).toEqual([{ path: "settings.maxRunDurationMs", before: null, after: 60_000 }]);
  });

  it("treats re-created identical edges as unchanged", () => {
    const before = valid();
    const after = valid();
    after.edges = after.edges.map((e, i) => ({ ...e, id: `new${i}` }));
    expect(diffDefinitions(before, after).identical).toBe(true);
  });

  it("diffs nested values", () => {
    expect(diffValues({ a: { b: [1, 2] } }, { a: { b: [1, 3], c: true } })).toEqual([
      { path: "a.b[1]", before: 2, after: 3 },
      { path: "a.c", before: null, after: true },
    ]);
    expect(diffValues([1], [1, 2])).toEqual([{ path: "(root)", before: [1], after: [1, 2] }]);
  });
});
