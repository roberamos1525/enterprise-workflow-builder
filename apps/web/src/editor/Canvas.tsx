import { getNodeType, type NodeDef, type WorkflowDefinition } from "@ewb/engine";
import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent } from "react";
import {
  edgePath,
  findFreeSpot,
  fitViewport,
  hitPort,
  HEADER_HEIGHT,
  NODE_WIDTH,
  nodeHeight,
  PORT_RADIUS,
  portPosition,
  snap,
  toWorld,
  zoomAt,
  type Point,
  type PortHit,
  type Viewport,
} from "./geometry.js";
import type { EditorAction, Selection } from "./state.js";

export const NODE_DRAG_TYPE = "application/x-ewb-node";

type Drag =
  | { kind: "pan"; start: Point; origin: Viewport }
  | { kind: "node"; id: string; offset: Point; moved: boolean }
  | { kind: "connect"; from: PortHit; to: Point };

export interface CanvasHandle {
  /** World position for a new node: visible-area centre, nudged to a free spot. */
  freeSpot(): Point;
}

interface CanvasProps {
  def: WorkflowDefinition;
  /** Receives an imperative handle (used by the palette to place nodes). */
  onReady?: (handle: CanvasHandle) => void;
  selected: Selection;
  dispatch?: Dispatch<EditorAction>;
  /** Validation error count per node id. */
  issues?: Map<string, number>;
  /** Live step status per node id (run overlay). */
  status?: Map<string, string>;
  readOnly?: boolean;
  height?: number | string;
}

const CATEGORY_COLOR: Record<string, string> = { trigger: "#7c3aed", action: "#2563eb", flow: "#0d9488" };
const specFor = (type: string) => getNodeType(type);

export function Canvas({ def, selected, dispatch, issues, status, readOnly = false, height = "100%", onReady }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const fitted = useRef(false);

  const screenPoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const fit = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect) setVp(fitViewport(def.nodes, specFor, rect.width, rect.height));
  }, [def.nodes]);

  useEffect(() => {
    if (!fitted.current && def.nodes.length > 0) {
      fitted.current = true;
      fit();
    }
  }, [def.nodes.length, fit]);

  useEffect(() => {
    onReady?.({
      freeSpot: () => {
        const rect = svgRef.current?.getBoundingClientRect();
        const w = rect?.width ?? 800;
        const h = rect?.height ?? 600;
        const centre = toWorld(vp, { x: w / 2, y: h / 2 });
        const topLeft = toWorld(vp, { x: 20, y: 20 });
        const bottomRight = toWorld(vp, { x: w - 20, y: h - 60 });
        const visible = { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
        // Flow reads left to right: continue after the selected node, else after the rightmost one.
        const anchor = def.nodes.find((n) => selected?.kind === "node" && n.id === selected.id) ?? [...def.nodes].sort((a, b) => b.position.x - a.position.x)[0];
        const start = anchor ? { x: anchor.position.x + NODE_WIDTH + 70, y: anchor.position.y } : { x: centre.x - NODE_WIDTH / 2, y: centre.y - 40 };
        return findFreeSpot(def.nodes, specFor, start, visible);
      },
    });
  }, [onReady, vp, def.nodes, selected]);

  // Wheel zoom needs a non-passive listener so the page does not scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const point = screenPoint(e.clientX, e.clientY);
      setVp((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), point));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [screenPoint]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (readOnly || !dispatch) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "deleteSelected" });
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      dispatch({ type: "redo" });
    }
  };

  const startPan = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    svgRef.current?.focus();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: "pan", start: screenPoint(e.clientX, e.clientY), origin: vp });
    dispatch?.({ type: "select", selection: null });
  };

  const startNodeDrag = (e: ReactPointerEvent, node: NodeDef) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef.current?.focus();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dispatch?.({ type: "select", selection: { kind: "node", id: node.id } });
    if (readOnly) return;
    const world = toWorld(vp, screenPoint(e.clientX, e.clientY));
    setDrag({ kind: "node", id: node.id, offset: { x: world.x - node.position.x, y: world.y - node.position.y }, moved: false });
  };

  const startConnect = (e: ReactPointerEvent, node: NodeDef, port: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    setDrag({ kind: "connect", from: { nodeId: node.id, port, direction: "out" }, to: toWorld(vp, screenPoint(e.clientX, e.clientY)) });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const screen = screenPoint(e.clientX, e.clientY);
    if (drag.kind === "pan") {
      setVp({ ...drag.origin, x: drag.origin.x + screen.x - drag.start.x, y: drag.origin.y + screen.y - drag.start.y });
    } else if (drag.kind === "node") {
      const world = toWorld(vp, screen);
      dispatch?.({ type: "moveNode", id: drag.id, position: { x: snap(world.x - drag.offset.x), y: snap(world.y - drag.offset.y) }, record: !drag.moved });
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else {
      setDrag({ ...drag, to: toWorld(vp, screen) });
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (drag?.kind === "connect") {
      const target = hitPort(def.nodes, specFor, toWorld(vp, screenPoint(e.clientX, e.clientY)), "in", 18 / vp.zoom);
      if (target) {
        dispatch?.({ type: "connect", source: { node: drag.from.nodeId, port: drag.from.port }, target: { node: target.nodeId, port: target.port } });
      }
    }
    setDrag(null);
  };

  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData(NODE_DRAG_TYPE);
    if (!type || readOnly) return;
    e.preventDefault();
    const world = toWorld(vp, screenPoint(e.clientX, e.clientY));
    dispatch?.({ type: "addNode", nodeType: type, position: { x: snap(world.x - NODE_WIDTH / 2), y: snap(world.y - HEADER_HEIGHT / 2) } });
  };

  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const connectFrom = drag?.kind === "connect" ? byId.get(drag.from.nodeId) : undefined;

  return (
    <div className="canvas-wrap" style={{ height }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <svg
        ref={svgRef}
        className={`canvas ${drag?.kind === "pan" ? "panning" : ""}`}
        tabIndex={0}
        role="application"
        aria-label="Workflow canvas"
        onPointerDown={startPan}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <defs>
          <pattern id="grid" width={20 * vp.zoom} height={20 * vp.zoom} x={vp.x} y={vp.y} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill="var(--grid)" />
          </pattern>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${vp.x} ${vp.y}) scale(${vp.zoom})`}>
          {def.edges.map((edge) => {
            const s = byId.get(edge.source.node);
            const t = byId.get(edge.target.node);
            if (!s || !t) return null;
            const d = edgePath(portPosition(s, specFor(s.type), "out", edge.source.port), portPosition(t, specFor(t.type), "in", edge.target.port));
            const isSelected = selected?.kind === "edge" && selected.id === edge.id;
            const active = status?.get(s.id) && status.get(t.id) && status.get(t.id) !== "skipped";
            return (
              <g key={edge.id} className="edge" onPointerDown={(e) => { e.stopPropagation(); dispatch?.({ type: "select", selection: { kind: "edge", id: edge.id } }); }}>
                <path d={d} className="edge-hit" />
                <path d={d} className={`edge-line ${isSelected ? "selected" : ""} ${active ? "active" : ""} ${edge.source.port === "error" ? "error" : ""}`} markerEnd="url(#arrow)" />
              </g>
            );
          })}
          {connectFrom && drag?.kind === "connect" && (
            <path d={edgePath(portPosition(connectFrom, specFor(connectFrom.type), "out", drag.from.port), drag.to)} className="edge-line pending" />
          )}
          {def.nodes.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              selected={selected?.kind === "node" && selected.id === node.id}
              issueCount={issues?.get(node.id) ?? 0}
              status={status?.get(node.id)}
              connecting={drag?.kind === "connect"}
              onPointerDown={(e) => startNodeDrag(e, node)}
              onPortDown={(e, port) => startConnect(e, node, port)}
            />
          ))}
        </g>
      </svg>
      <div className="canvas-controls">
        <button type="button" title="Zoom in" onClick={() => setVp((v) => zoomAt(v, 1.2, { x: 200, y: 150 }))}>+</button>
        <button type="button" title="Zoom out" onClick={() => setVp((v) => zoomAt(v, 1 / 1.2, { x: 200, y: 150 }))}>−</button>
        <button type="button" title="Fit to content" onClick={fit}>Fit</button>
        <span className="zoom-label">{Math.round(vp.zoom * 100)}%</span>
      </div>
    </div>
  );
}

interface NodeViewProps {
  node: NodeDef;
  selected: boolean;
  issueCount: number;
  status: string | undefined;
  connecting: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPortDown: (e: ReactPointerEvent, port: string) => void;
}

function NodeView({ node, selected, issueCount, status, connecting, onPointerDown, onPortDown }: NodeViewProps) {
  const spec = specFor(node.type);
  const h = nodeHeight(spec);
  const color = CATEGORY_COLOR[spec?.category ?? "action"];
  return (
    <g className={`node ${selected ? "selected" : ""} ${status ? `status-${status}` : ""}`} transform={`translate(${node.position.x} ${node.position.y})`}>
      <rect width={NODE_WIDTH} height={h} rx={8} className="node-body" onPointerDown={onPointerDown} />
      <rect width={NODE_WIDTH} height={HEADER_HEIGHT} rx={8} fill={color} onPointerDown={onPointerDown} />
      <rect y={HEADER_HEIGHT - 8} width={NODE_WIDTH} height={8} fill={color} onPointerDown={onPointerDown} />
      <text x={10} y={20} className="node-title" pointerEvents="none">
        {node.name.length > (status ? 13 : 22) ? `${node.name.slice(0, status ? 12 : 21)}…` : node.name}
      </text>
      <text x={10} y={HEADER_HEIGHT + 16} className="node-sub" pointerEvents="none">
        {node.id}
      </text>
      {issueCount > 0 && (
        <g transform={`translate(${NODE_WIDTH - 12} ${-6})`} pointerEvents="none">
          <circle r={9} className="issue-badge" />
          <text textAnchor="middle" y={4} className="issue-text">{issueCount}</text>
        </g>
      )}
      {status && (
        <text x={NODE_WIDTH - 10} y={20} textAnchor="end" className="node-status" pointerEvents="none">
          {status}
        </text>
      )}
      {(spec?.inputs ?? []).map((p) => {
        const pos = portPosition({ ...node, position: { x: 0, y: 0 } }, spec, "in", p.name);
        return <circle key={`in-${p.name}`} cx={pos.x} cy={pos.y} r={PORT_RADIUS} className={`port in ${connecting ? "droppable" : ""}`} />;
      })}
      {(spec?.outputs ?? []).map((p) => {
        const pos = portPosition({ ...node, position: { x: 0, y: 0 } }, spec, "out", p.name);
        return (
          <g key={`out-${p.name}`}>
            <text x={pos.x - 10} y={pos.y + 4} textAnchor="end" className="port-label" pointerEvents="none">
              {p.label}
            </text>
            <circle cx={pos.x} cy={pos.y} r={PORT_RADIUS} className={`port out ${p.dataType === "error" ? "error" : ""}`} onPointerDown={(e) => onPortDown(e, p.name)}>
              <title>{`${p.label} (${p.dataType}) — drag to connect`}</title>
            </circle>
          </g>
        );
      })}
    </g>
  );
}
