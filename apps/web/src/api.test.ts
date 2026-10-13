import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, SseParser } from "./api.js";
import { formatDuration, formatPercent, matchPath } from "./hooks.js";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

function fakeFetch(responses: { status: number; body?: unknown }[], calls: { url: string; init: RequestInit }[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
}

describe("ApiClient", () => {
  it("stores the token on login and sends it as a bearer header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const storage = new MemoryStorage();
    const client = new ApiClient("http://x", fakeFetch([{ status: 200, body: { token: "t1", user: { id: "u" } } }, { status: 200, body: [] }], calls), storage);
    await client.login("a@b.c", "pw");
    expect(storage.getItem("ewb.token")).toBe("t1");
    await client.workflows();
    expect(calls[1]!.url).toBe("http://x/api/workflows");
    expect((calls[1]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer t1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("maps error envelopes to ApiError and clears the session on 401", async () => {
    const storage = new MemoryStorage();
    storage.setItem("ewb.token", "old");
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new ApiClient("", fakeFetch([
      { status: 409, body: { error: { code: "CONFLICT", message: "stale", details: { currentRevision: 3 } } } },
      { status: 401, body: { error: { code: "UNAUTHORIZED", message: "token expired" } } },
    ], calls), storage);
    let loggedOut = false;
    client.onUnauthorized = () => (loggedOut = true);
    const conflict = await client.saveWorkflow("wf", 1, {}).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict).toMatchObject({ status: 409, code: "CONFLICT", details: { currentRevision: 3 } });
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(loggedOut).toBe(true);
    expect(client.token).toBeNull();
    expect(storage.getItem("ewb.token")).toBeNull();
  });

  it("builds query strings for run listings", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new ApiClient("", fakeFetch([{ status: 200, body: { items: [], nextBefore: null } }], calls), null);
    await client.runs({ workflowId: "wf_1", status: "", limit: 10 });
    expect(calls[0]!.url).toBe("/api/runs?workflowId=wf_1&limit=10");
  });
});

describe("SseParser", () => {
  it("parses events split across chunks and skips comments", () => {
    const seen: [string, unknown][] = [];
    const parser = new SseParser((type, data) => seen.push([type, data]));
    parser.push("event: hello\ndata: {\"userId\":");
    parser.push("\"u1\"}\n\n: ping\n\nevent: run\r\ndata: {\"type\":\"run.started\"}\r\n\r\n");
    parser.push("data: plain text\n\n");
    expect(seen).toEqual([
      ["hello", { userId: "u1" }],
      ["run", { type: "run.started" }],
      ["message", "plain text"],
    ]);
  });

  it("joins multi-line data fields", () => {
    const seen: unknown[] = [];
    const parser = new SseParser((_t, d) => seen.push(d));
    parser.push("data: line1\ndata: line2\n\n");
    expect(seen).toEqual(["line1\nline2"]);
  });
});

describe("routing and formatting helpers", () => {
  it("matches path patterns", () => {
    expect(matchPath("/runs/:id", "/runs/abc?x=1")).toEqual({ id: "abc" });
    expect(matchPath("/runs/:id", "/runs")).toBeNull();
    expect(matchPath("/workflows/:id", "/runs/abc")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
  });

  it("formats durations and percentages", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatPercent(0.125)).toBe("12.5%");
    expect(formatPercent(null)).toBe("—");
  });
});
