import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ------------------------------------------------------------------ routing

const listeners = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(path: string): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", path);
  listeners.forEach((l) => l());
}

export function useLocation(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname + window.location.search,
  );
}

/** Matches `/runs/:id` style patterns; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const [pathname = ""] = path.split("?");
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    const val = s[i] as string;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

// ------------------------------------------------------------------ data loading

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: Error | undefined; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current().then(
      (data) => !cancelled && setState({ data, error: undefined, loading: false }),
      (error: Error) => !cancelled && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ------------------------------------------------------------------ live events

export interface LiveRunEvent {
  runId: string;
  nodeId: string | null;
  type: string;
  at: number;
  workflowId: string;
  runStatus: string;
}

type LiveListener = (type: string, data: unknown) => void;
const liveListeners = new Set<LiveListener>();

export const liveBus = {
  emit(type: string, data: unknown): void {
    liveListeners.forEach((l) => l(type, data));
  },
  subscribe(listener: LiveListener): () => void {
    liveListeners.add(listener);
    return () => liveListeners.delete(listener);
  },
};

/** Subscribes to live run events; the callback ref is kept fresh without resubscribing. */
export function useLiveRuns(onEvent: (event: LiveRunEvent) => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => liveBus.subscribe((type, data) => type === "run" && ref.current(data as LiveRunEvent)), []);
}

// ------------------------------------------------------------------ formatting

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatPercent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%`;
}
