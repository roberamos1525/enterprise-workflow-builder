import { deepEqual } from "../expr/evaluator.js";
import type { EdgeDef, NodeDef, WorkflowDefinition } from "./types.js";

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface NodeChange {
  nodeId: string;
  name: string;
  type: string;
  changes: FieldChange[];
}

export interface DefinitionDiff {
  addedNodes: NodeDef[];
  removedNodes: NodeDef[];
  changedNodes: NodeChange[];
  /** Nodes whose only change is their canvas position. */
  movedNodes: string[];
  addedEdges: EdgeDef[];
  removedEdges: EdgeDef[];
  settingsChanges: FieldChange[];
  identical: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursively lists leaf-level differences between two JSON values. */
export function diffValues(before: unknown, after: unknown, path = ""): FieldChange[] {
  if (deepEqual(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffValues(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((v, i) => diffValues(v, after[i], `${path}[${i}]`));
  }
  return [{ path: path || "(root)", before: before ?? null, after: after ?? null }];
}

function edgeKey(e: EdgeDef): string {
  return `${e.source.node}.${e.source.port}->${e.target.node}.${e.target.port}`;
}

/**
 * Semantic diff between two workflow definitions. Edges are compared by their
 * endpoints (not ids) so re-drawing an identical connection is not a change.
 */
export function diffDefinitions(before: WorkflowDefinition, after: WorkflowDefinition): DefinitionDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const addedNodes = after.nodes.filter((n) => !beforeNodes.has(n.id));
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));
  const changedNodes: NodeChange[] = [];
  const movedNodes: string[] = [];
  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) continue;
    const changes = [
      ...diffValues(prev.type, node.type, "type"),
      ...diffValues(prev.name, node.name, "name"),
      ...diffValues(prev.config, node.config, "config"),
      ...diffValues(prev.retry ?? null, node.retry ?? null, "retry"),
      ...diffValues(prev.timeoutMs ?? null, node.timeoutMs ?? null, "timeoutMs"),
    ];
    if (changes.length > 0) changedNodes.push({ nodeId: node.id, name: node.name, type: node.type, changes });
    else if (!deepEqual(prev.position, node.position)) movedNodes.push(node.id);
  }
  const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  const addedEdges = after.edges.filter((e) => !beforeEdges.has(edgeKey(e)));
  const removedEdges = before.edges.filter((e) => !afterEdges.has(edgeKey(e)));
  const settingsChanges = [
    ...diffValues(before.variables ?? {}, after.variables ?? {}, "variables"),
    ...diffValues(before.settings ?? {}, after.settings ?? {}, "settings"),
  ];
  const identical =
    addedNodes.length + removedNodes.length + changedNodes.length + movedNodes.length + addedEdges.length +
      removedEdges.length + settingsChanges.length === 0;
  return { addedNodes, removedNodes, changedNodes, movedNodes, addedEdges, removedEdges, settingsChanges, identical };
}
