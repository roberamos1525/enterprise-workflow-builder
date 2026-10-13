import { validateDefinition, type WorkflowDefinition } from "@ewb/engine";
import { describe, expect, it } from "vitest";
import {
  clampZoom,
  edgePath,
  findFreeSpot,
  fitViewport,
  hitNode,
  hitPort,
  HEADER_HEIGHT,
  NODE_WIDTH,
  nodeHeight,
  portPosition,
  snap,
  toScreen,
  toWorld,
  zoomAt,
} from "./geometry.js";
import { connectionError, editorReducer, initialState, nextNodeId, type EditorState } from "./state.js";
import { getNodeType } from "@ewb/engine";

const specFor = (type: string) => getNodeType(type);

const base = (): WorkflowDefinition => ({
  schemaVersion: 1,
  nodes: [
    { id: "trigger", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
    { id: "check", type: "flow.branch", name: "Check", position: { x: 300, y: 0 }, config: { condition: "true" } },
  ],
  edges: [{ id: "e1", source: { node: "trigger", port: "out" }, target: { node: "check", port: "in" } }],
});

const run = (state: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) => actions.reduce(editorReducer, state);

describe("geometry", () => {
  it("converts between screen and world coordinates", () => {
    const vp = { x: 100, y: 50, zoom: 2 };
    const world = toWorld(vp, { x: 300, y: 250 });
    expect(world).toEqual({ x: 100, y: 100 });
    expect(toScreen(vp, world)).toEqual({ x: 300, y: 250 });
  });

  it("zooms around the cursor and clamps the zoom level", () => {
    const vp = { x: 0, y: 0, zoom: 1 };
    const cursor = { x: 400, y: 300 };
    const before = toWorld(vp, cursor);
    const zoomed = zoomAt(vp, 2, cursor);
    expect(zoomed.zoom).toBe(2);
    expect(toWorld(zoomed, cursor)).toEqual(before);
    expect(zoomAt(vp, 100, cursor).zoom).toBe(2.5);
    expect(clampZoom(0.01)).toBe(0.25);
  });

  it("places ports on the node edges, spreading multiple outputs", () => {
    const node = base().nodes[1]!;
    const spec = specFor("flow.branch");
    const input = portPosition(node, spec, "in", "in");
    const t = portPosition(node, spec, "out", "true");
    const f = portPosition(node, spec, "out", "false");
    expect(input.x).toBe(300);
    expect(t.x).toBe(300 + NODE_WIDTH);
    expect(f.y).toBeGreaterThan(t.y);
    expect(t.y).toBeGreaterThan(HEADER_HEIGHT);
    expect(nodeHeight(specFor("action.approval"))).toBeGreaterThan(nodeHeight(specFor("action.transform")));
  });

  it("builds a cubic edge path and snaps to the grid", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 200, y: 100 })).toBe("M 0 0 C 100 0, 100 100, 200 100");
    expect(edgePath({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe("M 0 0 C 40 0, -30 0, 10 0");
    expect(snap(14)).toBe(10);
    expect(snap(15)).toBe(20);
  });

  it("hit-tests ports and nodes in world space", () => {
    const def = base();
    const target = portPosition(def.nodes[1]!, specFor("flow.branch"), "in", "in");
    expect(hitPort(def.nodes, specFor, { x: target.x + 5, y: target.y - 5 }, "in")).toEqual({ nodeId: "check", port: "in", direction: "in" });
    expect(hitPort(def.nodes, specFor, { x: target.x + 50, y: target.y }, "in")).toBeUndefined();
    expect(hitPort(def.nodes, specFor, target, "out")).toBeUndefined();
    expect(hitNode(def.nodes, specFor, { x: 310, y: 10 })?.id).toBe("check");
    expect(hitNode(def.nodes, specFor, { x: 250, y: 10 })).toBeUndefined();
  });

  it("fits all nodes into the viewport", () => {
    const vp = fitViewport(base().nodes, specFor, 800, 600);
    const topLeft = toScreen(vp, { x: 0, y: 0 });
    const bottomRight = toScreen(vp, { x: 300 + NODE_WIDTH, y: nodeHeight(specFor("flow.branch")) });
    expect(topLeft.x).toBeGreaterThanOrEqual(40);
    expect(bottomRight.x).toBeLessThanOrEqual(760);
    expect(fitViewport([], specFor, 800, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("findFreeSpot", () => {
  it("returns the start when it is free and avoids overlapping nodes otherwise", () => {
    const nodes = base().nodes;
    expect(findFreeSpot(nodes, specFor, { x: 600, y: 0 })).toEqual({ x: 600, y: 0 });
    const spot = findFreeSpot(nodes, specFor, { x: 300, y: 0 });
    expect(hitNode(nodes, specFor, { x: spot.x + 5, y: spot.y + 5 })).toBeUndefined();
    expect(Math.hypot(spot.x - 300, spot.y)).toBeLessThan(400);
  });

  it("prefers spots inside the visible bounds", () => {
    const spot = findFreeSpot([], specFor, { x: 2000, y: 0 }, { minX: 0, minY: 0, maxX: 800, maxY: 600 });
    expect(spot.x + NODE_WIDTH).toBeLessThanOrEqual(800);
    expect(spot.x).toBeGreaterThanOrEqual(0);
  });
});

describe("editor reducer", () => {
  it("adds nodes with readable unique ids and default config", () => {
    const s = run(initialState(base()), { type: "addNode", nodeType: "action.http", position: { x: 10, y: 20 } }, { type: "addNode", nodeType: "action.http", position: { x: 10, y: 90 } });
    expect(s.def.nodes.map((n) => n.id)).toEqual(["trigger", "check", "http_1", "http_2"]);
    expect(s.def.nodes[2]).toMatchObject({ name: "HTTP request", config: { method: "GET", failOnHttpError: true } });
    expect(s.selected).toEqual({ kind: "node", id: "http_2" });
    expect(s.dirty).toBe(true);
    expect(nextNodeId(s.def, "flow.join")).toBe("join_1");
  });

  it("replaces the trigger instead of adding a second one", () => {
    const s = run(initialState(base()), { type: "addNode", nodeType: "trigger.webhook", position: { x: 0, y: 0 } });
    expect(s.def.nodes.filter((n) => n.type.startsWith("trigger."))).toHaveLength(1);
    expect(s.def.nodes[0]).toMatchObject({ id: "trigger", type: "trigger.webhook" });
    expect(s.def.edges).toHaveLength(1);
  });

  it("connects compatible ports and rejects invalid connections with a reason", () => {
    let s = run(initialState(base()), { type: "addNode", nodeType: "action.transform", position: { x: 0, y: 0 } });
    s = run(s, { type: "connect", source: { node: "check", port: "true" }, target: { node: "transform_1", port: "in" } });
    expect(s.def.edges).toHaveLength(2);
    expect(s.error).toBeNull();
    const dup = run(s, { type: "connect", source: { node: "check", port: "true" }, target: { node: "transform_1", port: "in" } });
    expect(dup.error).toMatch(/already connected/);
    expect(dup.def.edges).toHaveLength(2);
    expect(connectionError(s.def, { node: "transform_1", port: "out" }, { node: "check", port: "in" })).toMatch(/cycle/);
    expect(connectionError(s.def, { node: "check", port: "true" }, { node: "check", port: "in" })).toMatch(/itself/);
    expect(connectionError(s.def, { node: "check", port: "true" }, { node: "trigger", port: "in" })).toMatch(/no input/);
    expect(connectionError(s.def, { node: "check", port: "maybe" }, { node: "transform_1", port: "in" })).toMatch(/no output/);
  });

  it("rejects error outputs into joins (typed ports)", () => {
    let s = run(initialState(base()), { type: "addNode", nodeType: "action.http", position: { x: 0, y: 0 } }, { type: "addNode", nodeType: "flow.join", position: { x: 0, y: 0 } });
    s = run(s, { type: "connect", source: { node: "http_1", port: "error" }, target: { node: "join_1", port: "in" } });
    expect(s.error).toMatch(/error output cannot feed/);
  });

  it("deletes nodes with their edges, but never the trigger", () => {
    let s = run(initialState(base()), { type: "select", selection: { kind: "node", id: "check" } }, { type: "deleteSelected" });
    expect(s.def.nodes.map((n) => n.id)).toEqual(["trigger"]);
    expect(s.def.edges).toEqual([]);
    s = run(s, { type: "select", selection: { kind: "node", id: "trigger" } }, { type: "deleteSelected" });
    expect(s.error).toMatch(/cannot be deleted/);
    const edgeGone = run(initialState(base()), { type: "select", selection: { kind: "edge", id: "e1" } }, { type: "deleteSelected" });
    expect(edgeGone.def.edges).toEqual([]);
  });

  it("records one undo step per drag and supports undo/redo", () => {
    let s = initialState(base());
    s = run(
      s,
      { type: "moveNode", id: "check", position: { x: 310, y: 0 }, record: true },
      { type: "moveNode", id: "check", position: { x: 320, y: 0 }, record: false },
      { type: "moveNode", id: "check", position: { x: 330, y: 0 }, record: false },
    );
    expect(s.past).toHaveLength(1);
    s = run(s, { type: "undo" });
    expect(s.def.nodes[1]!.position.x).toBe(300);
    s = run(s, { type: "redo" });
    expect(s.def.nodes[1]!.position.x).toBe(330);
    expect(run(initialState(base()), { type: "undo" }).past).toEqual([]);
  });

  it("renames node ids and rewires edges", () => {
    const s = run(initialState(base()), { type: "renameNode", from: "check", to: "decide" });
    expect(s.def.edges[0]!.target.node).toBe("decide");
    expect(run(s, { type: "renameNode", from: "decide", to: "trigger" }).error).toMatch(/already used/);
    expect(run(s, { type: "renameNode", from: "decide", to: "9bad" }).error).toMatch(/start with a letter/);
  });

  it("produces definitions that pass engine validation", () => {
    let s = run(
      initialState(base()),
      { type: "addNode", nodeType: "action.transform", position: { x: 0, y: 0 } },
      { type: "connect", source: { node: "check", port: "true" }, target: { node: "transform_1", port: "in" } },
    );
    expect(validateDefinition(s.def).valid).toBe(false); // transform has no expression yet
    s = run(s, { type: "updateNode", id: "transform_1", patch: { config: { expression: "trigger" } } }, { type: "saved" });
    expect(validateDefinition(s.def).valid).toBe(true);
    expect(s.dirty).toBe(false);
  });
});
