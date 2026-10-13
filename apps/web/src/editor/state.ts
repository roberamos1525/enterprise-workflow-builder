import {
  defaultConfig,
  getNodeType,
  isTriggerType,
  NODE_ID_PATTERN,
  portCompatible,
  type EdgeDef,
  type NodeDef,
  type PortRef,
  type WorkflowDefinition,
} from "@ewb/engine";
import type { Point } from "./geometry.js";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

export interface EditorState {
  def: WorkflowDefinition;
  selected: Selection;
  dirty: boolean;
  past: WorkflowDefinition[];
  future: WorkflowDefinition[];
  /** Last rejected operation, shown as a toast. */
  error: string | null;
}

export type EditorAction =
  | { type: "load"; def: WorkflowDefinition }
  | { type: "addNode"; nodeType: string; position: Point }
  | { type: "moveNode"; id: string; position: Point; record: boolean }
  | { type: "connect"; source: PortRef; target: PortRef }
  | { type: "select"; selection: Selection }
  | { type: "deleteSelected" }
  | { type: "updateNode"; id: string; patch: Partial<Omit<NodeDef, "id">> }
  | { type: "renameNode"; from: string; to: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved" }
  | { type: "clearError" };

const HISTORY_LIMIT = 50;

export function initialState(def: WorkflowDefinition): EditorState {
  return { def, selected: null, dirty: false, past: [], future: [], error: null };
}

/** Short, readable node id such as `http_2`, unique within the definition. */
export function nextNodeId(def: WorkflowDefinition, nodeType: string): string {
  const base = (nodeType.split(".")[1] ?? "node").replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "node";
  const used = new Set(def.nodes.map((n) => n.id));
  for (let i = 1; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

function reachable(def: WorkflowDefinition, from: string, to: string): boolean {
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of def.edges) if (e.source.node === id) stack.push(e.target.node);
  }
  return false;
}

/** Explains why a connection is not allowed, or returns null when it is. */
export function connectionError(def: WorkflowDefinition, source: PortRef, target: PortRef): string | null {
  const src = def.nodes.find((n) => n.id === source.node);
  const dst = def.nodes.find((n) => n.id === target.node);
  if (!src || !dst) return "unknown node";
  if (src.id === dst.id) return "a node cannot connect to itself";
  const out = getNodeType(src.type)?.outputs.find((p) => p.name === source.port);
  const input = getNodeType(dst.type)?.inputs.find((p) => p.name === target.port);
  if (!out) return `${src.name} has no output '${source.port}'`;
  if (!input) return `${dst.name} has no input '${target.port}'`;
  if (!portCompatible(out.dataType, input.accepts)) return `${out.dataType} output cannot feed ${dst.name}`;
  if (def.edges.some((e) => e.source.node === source.node && e.source.port === source.port && e.target.node === target.node && e.target.port === target.port)) {
    return "these ports are already connected";
  }
  if (reachable(def, dst.id, src.id)) return "connection would create a cycle";
  return null;
}

function newEdgeId(def: WorkflowDefinition): string {
  const used = new Set(def.edges.map((e) => e.id));
  for (let i = def.edges.length + 1; ; i++) if (!used.has(`e${i}`)) return `e${i}`;
}

function commit(state: EditorState, def: WorkflowDefinition, extra: Partial<EditorState> = {}): EditorState {
  return {
    ...state,
    def,
    dirty: true,
    past: [...state.past, state.def].slice(-HISTORY_LIMIT),
    future: [],
    error: null,
    ...extra,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { def } = state;
  switch (action.type) {
    case "load":
      return initialState(action.def);
    case "addNode": {
      const spec = getNodeType(action.nodeType);
      if (!spec) return { ...state, error: `unknown node type ${action.nodeType}` };
      const existingTrigger = def.nodes.find((n) => isTriggerType(n.type));
      if (spec.category === "trigger" && existingTrigger) {
        // A workflow has exactly one trigger: switching type keeps id, position and edges.
        const nodes = def.nodes.map((n) =>
          n.id === existingTrigger.id ? { ...n, type: action.nodeType, name: spec.label, config: defaultConfig(action.nodeType) } : n,
        );
        return commit(state, { ...def, nodes }, { selected: { kind: "node", id: existingTrigger.id } });
      }
      const node: NodeDef = {
        id: nextNodeId(def, action.nodeType),
        type: action.nodeType,
        name: spec.label,
        position: action.position,
        config: defaultConfig(action.nodeType),
      };
      return commit(state, { ...def, nodes: [...def.nodes, node] }, { selected: { kind: "node", id: node.id } });
    }
    case "moveNode": {
      const nodes = def.nodes.map((n) => (n.id === action.id ? { ...n, position: action.position } : n));
      if (action.record) return commit(state, { ...def, nodes });
      return { ...state, def: { ...def, nodes }, dirty: true };
    }
    case "connect": {
      const error = connectionError(def, action.source, action.target);
      if (error) return { ...state, error };
      const edge: EdgeDef = { id: newEdgeId(def), source: action.source, target: action.target };
      return commit(state, { ...def, edges: [...def.edges, edge] }, { selected: { kind: "edge", id: edge.id } });
    }
    case "select":
      return { ...state, selected: action.selection };
    case "deleteSelected": {
      const sel = state.selected;
      if (!sel) return state;
      if (sel.kind === "edge") return commit(state, { ...def, edges: def.edges.filter((e) => e.id !== sel.id) }, { selected: null });
      const node = def.nodes.find((n) => n.id === sel.id);
      if (node && isTriggerType(node.type)) return { ...state, error: "the trigger cannot be deleted; pick another trigger type instead" };
      return commit(
        state,
        { ...def, nodes: def.nodes.filter((n) => n.id !== sel.id), edges: def.edges.filter((e) => e.source.node !== sel.id && e.target.node !== sel.id) },
        { selected: null },
      );
    }
    case "updateNode":
      return commit(state, { ...def, nodes: def.nodes.map((n) => (n.id === action.id ? { ...n, ...action.patch } : n)) });
    case "renameNode": {
      if (action.from === action.to) return state;
      if (!NODE_ID_PATTERN.test(action.to)) return { ...state, error: "ids start with a letter and contain letters, digits or _" };
      if (def.nodes.some((n) => n.id === action.to)) return { ...state, error: `id '${action.to}' is already used` };
      const rename = (ref: PortRef) => (ref.node === action.from ? { ...ref, node: action.to } : ref);
      return commit(
        state,
        {
          ...def,
          nodes: def.nodes.map((n) => (n.id === action.from ? { ...n, id: action.to } : n)),
          edges: def.edges.map((e) => ({ ...e, source: rename(e.source), target: rename(e.target) })),
        },
        { selected: { kind: "node", id: action.to } },
      );
    }
    case "undo": {
      const prev = state.past.at(-1);
      if (!prev) return state;
      return { ...state, def: prev, past: state.past.slice(0, -1), future: [def, ...state.future], dirty: true, selected: null };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return { ...state, def: next, past: [...state.past, def], future: state.future.slice(1), dirty: true, selected: null };
    }
    case "saved":
      return { ...state, dirty: false };
    case "clearError":
      return { ...state, error: null };
  }
}
