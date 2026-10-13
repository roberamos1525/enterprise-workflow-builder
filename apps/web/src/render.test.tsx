import { diffDefinitions, type RunRecord, type StepRecord, type WorkflowDefinition } from "@ewb/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Canvas } from "./editor/Canvas.js";
import { DailyChart } from "./pages/Dashboard.js";
import { DiffView } from "./pages/Editor.js";
import { Timeline } from "./pages/Runs.js";

const def: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [
    { id: "start", type: "trigger.webhook", name: "Order received", position: { x: 0, y: 0 }, config: {} },
    { id: "check", type: "flow.branch", name: "A very long branch name that is truncated", position: { x: 260, y: 0 }, config: { condition: "true" } },
  ],
  edges: [{ id: "e1", source: { node: "start", port: "out" }, target: { node: "check", port: "in" } }],
};

const run: RunRecord = {
  id: "r1", workflowId: "wf", version: 1, status: "succeeded", trigger: { type: "manual" }, input: {}, vars: {}, output: null, error: null,
  parentRunId: null, parentNodeId: null, depth: 0, createdBy: null, createdAt: 0, updatedAt: 0, finishedAt: 1000, deadlineAt: null,
};
const step = (nodeId: string, status: StepRecord["status"], startedAt: number, finishedAt: number | null): StepRecord => ({
  runId: "r1", nodeId, nodeType: "action.transform", status, attempt: 1, port: null, input: null, output: null, error: null, state: null,
  wakeAt: null, wakeReason: null, pendingEvent: null, startedAt, finishedAt, updatedAt: startedAt,
});

describe("Canvas rendering", () => {
  it("draws nodes, ports, edges, issue badges and run status classes", () => {
    const html = renderToStaticMarkup(
      <Canvas def={def} selected={{ kind: "node", id: "check" }} issues={new Map([["check", 2]])} status={new Map([["start", "succeeded"], ["check", "running"]])} />,
    );
    expect(html).toContain('aria-label="Workflow canvas"');
    expect((html.match(/class="node /g) ?? []).length).toBe(2);
    expect(html).toContain("node selected status-running");
    expect(html).toContain("status-succeeded");
    expect(html).toContain("A very long …"); // shortened further when a status label shares the header
    expect(html).toMatch(/class="issue-text"[^>]*>2</);
    expect((html.match(/class="port out/g) ?? []).length).toBe(3); // webhook out + branch true/false
    expect(html).toMatch(/<path d="M 184 \d+(\.\d+)? C/);
    expect(html).toContain("edge-line");
    expect(html).toContain("active");
  });

  it("renders read-only canvases without editing affordances changing markup", () => {
    const html = renderToStaticMarkup(<Canvas def={def} selected={null} readOnly height={200} />);
    expect(html).toContain("height:200px");
    expect(html).not.toContain("selected");
  });
});

describe("charts and views", () => {
  it("scales timeline bars relative to the run duration and skips skipped steps", () => {
    const html = renderToStaticMarkup(
      <Timeline run={run} steps={[step("a", "succeeded", 0, 500), step("b", "failed", 500, 1000), step("c", "skipped", 0, 0)]} now={1000} />,
    );
    expect(html).toContain(">a<");
    expect(html).toContain(">b<");
    expect(html).not.toContain(">c<");
    const widths = [...html.matchAll(/<rect x="([\d.]+)" y="4" width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(widths).toHaveLength(2);
    expect(widths[0]![0]).toBe(140);
    expect(widths[1]![0]).toBeCloseTo(140 + widths[0]![1], 5);
    expect(html).toContain("1.0 s");
  });

  it("stacks daily bars by outcome", () => {
    const html = renderToStaticMarkup(
      <DailyChart days={[{ day: "2026-06-01", succeeded: 3, failed: 1, other: 0 }, { day: "2026-06-02", succeeded: 0, failed: 0, other: 0 }]} />,
    );
    expect(html).toContain("2026-06-01: 3 succeeded");
    expect(html).toContain("2026-06-01: 1 failed");
    expect(html).not.toContain("0 other");
    expect(html).toContain(">06-02<");
  });

  it("summarises definition diffs", () => {
    const after: WorkflowDefinition = { ...def, nodes: [def.nodes[0]!, { ...def.nodes[1]!, config: { condition: "false" } }], edges: [] };
    const html = renderToStaticMarkup(<DiffView diff={diffDefinitions(def, after)} />);
    expect(html).toContain("~ node check");
    expect(html).toContain("config.condition: &quot;true&quot; → &quot;false&quot;");
    expect(html).toContain("− start.out → check");
    expect(renderToStaticMarkup(<DiffView diff={diffDefinitions(def, def)} />)).toContain("No differences.");
  });
});
