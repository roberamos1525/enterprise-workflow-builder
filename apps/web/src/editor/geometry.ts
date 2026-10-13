import type { NodeDef, NodeTypeSpec } from "@ewb/engine";

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const NODE_WIDTH = 184;
export const HEADER_HEIGHT = 30;
export const PORT_SPACING = 22;
export const PORT_RADIUS = 6;
export const GRID = 10;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;

type PortCounts = Pick<NodeTypeSpec, "inputs" | "outputs">;

export function nodeHeight(spec: PortCounts | undefined): number {
  const rows = Math.max(1, spec?.outputs.length ?? 1, spec?.inputs.length ?? 0);
  return HEADER_HEIGHT + rows * PORT_SPACING + 8;
}

/** World position of a port's connection point. */
export function portPosition(node: NodeDef, spec: PortCounts | undefined, direction: "in" | "out", port: string): Point {
  const list = direction === "in" ? (spec?.inputs ?? []) : (spec?.outputs ?? []);
  const index = Math.max(0, list.findIndex((p) => p.name === port));
  const rows = Math.max(1, list.length);
  const body = nodeHeight(spec) - HEADER_HEIGHT;
  const y = node.position.y + HEADER_HEIGHT + (body / rows) * (index + 0.5);
  return { x: node.position.x + (direction === "in" ? 0 : NODE_WIDTH), y };
}

/** Horizontal S-curve between an output and an input port. */
export function edgePath(from: Point, to: Point): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

export function toWorld(vp: Viewport, screen: Point): Point {
  return { x: (screen.x - vp.x) / vp.zoom, y: (screen.y - vp.y) / vp.zoom };
}

export function toScreen(vp: Viewport, world: Point): Point {
  return { x: world.x * vp.zoom + vp.x, y: world.y * vp.zoom + vp.y };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zooms by `factor` keeping the world point under `screen` fixed (cursor-anchored zoom). */
export function zoomAt(vp: Viewport, factor: number, screen: Point): Viewport {
  const zoom = clampZoom(vp.zoom * factor);
  const world = toWorld(vp, screen);
  return { zoom, x: screen.x - world.x * zoom, y: screen.y - world.y * zoom };
}

export function snap(value: number, grid = GRID): number {
  return Math.round(value / grid) * grid;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function contentBounds(nodes: NodeDef[], specFor: (type: string) => PortCounts | undefined): Bounds | undefined {
  if (nodes.length === 0) return undefined;
  return nodes.reduce<Bounds>(
    (b, n) => ({
      minX: Math.min(b.minX, n.position.x),
      minY: Math.min(b.minY, n.position.y),
      maxX: Math.max(b.maxX, n.position.x + NODE_WIDTH),
      maxY: Math.max(b.maxY, n.position.y + nodeHeight(specFor(n.type))),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

/** Viewport that fits all nodes into a `width`x`height` screen area with padding. */
export function fitViewport(nodes: NodeDef[], specFor: (type: string) => PortCounts | undefined, width: number, height: number, padding = 40): Viewport {
  const b = contentBounds(nodes, specFor);
  if (!b || width <= 0 || height <= 0) return { x: 0, y: 0, zoom: 1 };
  const zoom = clampZoom(Math.min((width - padding * 2) / (b.maxX - b.minX), (height - padding * 2) / (b.maxY - b.minY), 1.2));
  return {
    zoom,
    x: (width - (b.maxX - b.minX) * zoom) / 2 - b.minX * zoom,
    y: (height - (b.maxY - b.minY) * zoom) / 2 - b.minY * zoom,
  };
}

export interface PortHit {
  nodeId: string;
  port: string;
  direction: "in" | "out";
}

/** Finds the port closest to `world` within `radius` (world units). */
export function hitPort(nodes: NodeDef[], specFor: (type: string) => PortCounts | undefined, world: Point, direction: "in" | "out", radius = 14): PortHit | undefined {
  let best: (PortHit & { d: number }) | undefined;
  for (const node of nodes) {
    const spec = specFor(node.type);
    for (const port of direction === "in" ? (spec?.inputs ?? []) : (spec?.outputs ?? [])) {
      const p = portPosition(node, spec, direction, port.name);
      const d = Math.hypot(p.x - world.x, p.y - world.y);
      if (d <= radius && (!best || d < best.d)) best = { nodeId: node.id, port: port.name, direction, d };
    }
  }
  if (!best) return undefined;
  const { d: _d, ...hit } = best;
  return hit;
}

/** Topmost node whose box contains the point (later nodes render on top). */
export function hitNode(nodes: NodeDef[], specFor: (type: string) => PortCounts | undefined, world: Point): NodeDef | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i] as NodeDef;
    const h = nodeHeight(specFor(n.type));
    if (world.x >= n.position.x && world.x <= n.position.x + NODE_WIDTH && world.y >= n.position.y && world.y <= n.position.y + h) return n;
  }
  return undefined;
}

/**
 * Free position for a new node: the grid cell closest to `start` (searching
 * outward, preferring cells inside `visible`) that overlaps no existing node.
 */
export function findFreeSpot(
  nodes: NodeDef[],
  specFor: (type: string) => PortCounts | undefined,
  start: Point,
  visible?: Bounds,
  newHeight = 90,
): Point {
  const overlaps = (p: Point) =>
    nodes.some((n) => {
      const h = nodeHeight(specFor(n.type));
      return p.x < n.position.x + NODE_WIDTH + 20 && p.x + NODE_WIDTH + 20 > n.position.x && p.y < n.position.y + h + 20 && p.y + newHeight + 20 > n.position.y;
    });
  const inside = (p: Point) => !visible || (p.x >= visible.minX && p.y >= visible.minY && p.x + NODE_WIDTH <= visible.maxX && p.y + newHeight <= visible.maxY);
  const candidates: Point[] = [];
  const around = (origin: Point) => {
    for (let dx = -6; dx <= 6; dx++) {
      for (let dy = -6; dy <= 6; dy++) candidates.push({ x: snap(origin.x + dx * (NODE_WIDTH / 2 + 20)), y: snap(origin.y + dy * (newHeight / 2 + 15)) });
    }
  };
  around(start);
  // When the anchor is off-screen, also consider the visible area itself.
  if (visible) around({ x: (visible.minX + visible.maxX - NODE_WIDTH) / 2, y: (visible.minY + visible.maxY - newHeight) / 2 });
  const dist = (p: Point) => Math.hypot(p.x - start.x, p.y - start.y);
  candidates.sort((a, b) => Number(inside(b)) - Number(inside(a)) || dist(a) - dist(b));
  return candidates.find((p) => !overlaps(p)) ?? { x: snap(start.x), y: snap(start.y) };
}
